import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config.ts";
import type { ReviewCoordinator } from "../extensions/coordinator.ts";
import { parseLiveHunkSessions, waitForManagedHunkSession } from "../extensions/hunk-session.ts";
import {
  readHunkReview,
  ReviewHandoffGate,
  type HunkReviewNote,
} from "../extensions/review-handoff.ts";
import { hunkTestLayer } from "./support/hunk-runner.ts";

const baseLaunchedAt = "2026-01-01T00:00:00.000Z";

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    pid: 101,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: baseLaunchedAt,
    fileCount: 1,
    files: [{ path: "src/a.ts" }],
    ...overrides,
  };
}

function runner(
  comments: unknown[] | (() => unknown[]),
  sessions: unknown[] | (() => unknown[]) = [session()],
  expectedSessionId = "s1",
) {
  const hunk = hunkTestLayer((argv) => {
    if (argv.slice(1).join(" ") === "session list --json")
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          sessions: typeof sessions === "function" ? sessions() : sessions,
        }),
      };
    if (argv.slice(1).join(" ") === `session comment list ${expectedSessionId} --type user --json`)
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          comments: typeof comments === "function" ? comments() : comments,
        }),
      };
    return { code: 1, stderr: `unexpected argv: ${argv.join(" ")}`, stdout: "" };
  });
  return vi.fn(hunk.run);
}
const note = (body = "Fix this\nBecause it breaks", overrides: Record<string, unknown> = {}) => ({
  noteId: "user:1",
  source: "user",
  filePath: "src/a.ts",
  oldRange: [4, 6],
  newRange: [5, 8],
  body,
  author: "user",
  createdAt: "2026-05-10T00:00:00.000Z",
  editable: true,
  ...overrides,
});

type FakeState = "closed" | "starting" | "visible" | "hidden" | "closing";

class FakeCoordinator {
  state: FakeState = "closed";
  pid: number | undefined;
  launchCwd = "/repo";
  repoRoot: string | undefined;
  sessionId: string | undefined;
  stateListeners = new Set<() => void>();
  ensureOpen = vi.fn(async (...args: unknown[]) => {
    this.launchCwd = (args[4] as string | undefined) ?? this.launchCwd;
    this.state = "visible";
    this.emit();
  });
  hasLiveSurface() {
    return this.state === "starting" || this.state === "visible" || this.state === "hidden";
  }
  getActiveInfo() {
    return this.state === "closed"
      ? null
      : {
          state: this.state,
          argsKey: JSON.stringify([this.launchCwd, "hunk", "diff"]),
          launchCwd: this.launchCwd,
          source: "handoff" as const,
          pid: this.pid,
          repoRoot: this.repoRoot,
          sessionId: this.sessionId,
        };
  }
  adoptManagedSession(value: { repoRoot?: string; sessionId: string }) {
    this.repoRoot = value.repoRoot;
    this.sessionId = value.sessionId;
    return true;
  }
  adoptEarlySurfaceForRun() {}
  isEarlySurfaceOwnedForRun() {
    return false;
  }
  async releaseSurfaceForRouting() {
    this.state = "closed";
    this.emit();
    return true;
  }
  onStateChange(fn: () => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  markReviewCompleteForRun = vi.fn();
  emit() {
    for (const fn of this.stateListeners) fn();
  }
  transition(state: FakeState, duplicate = false) {
    this.state = state;
    this.emit();
    if (duplicate) this.emit();
  }
}
function setup(
  comments: unknown[] | (() => unknown[]),
  options: {
    sessions?: unknown[] | (() => unknown[]);
    expectedSessionId?: string;
    pid?: number;
  } = {},
) {
  const coordinator = new FakeCoordinator();
  coordinator.pid = options.pid ?? 101;
  const run = runner(comments, options.sessions, options.expectedSessionId);
  const gate = new ReviewHandoffGate(
    coordinator as unknown as ReviewCoordinator,
    () => DEFAULT_CONFIG,
    run,
  );
  const ctx = { cwd: "/repo", mode: "tui" } as ExtensionContext;
  return { coordinator, run, gate, ctx };
}

describe("fresh Hunk review parsing", () => {
  it.each([null, [], "invalid", 42])(
    "rejects invalid session-list root %j with a schema-drift diagnostic",
    (value) => {
      expect(() => parseLiveHunkSessions(value)).toThrow(
        "Hunk session JSON drift: expected a sessions array.",
      );
    },
  );

  it("parses and exposes Hunk's zero/non-zero review metadata", () => {
    expect(
      parseLiveHunkSessions({ sessions: [session({ fileCount: 0, files: [] })] })[0],
    ).toMatchObject({ fileCount: 0, files: [] });
    expect(() => parseLiveHunkSessions({ sessions: [session({ fileCount: 0 })] })).toThrow(
      /does not match files.length/,
    );
  });

  it("polls bounded registration and reload frames until a diff appears", async () => {
    let lookup = 0;
    const frames = [[], [session({ fileCount: 0, files: [] })], [session()]];
    const run = runner([], () => frames[Math.min(lookup++, frames.length - 1)]!);

    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0, 0],
      }),
    ).resolves.toMatchObject({ status: "reviewable", session: { fileCount: 1 } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("declares no-diff only after the bounded empty-frame window", async () => {
    const run = runner([], [session({ fileCount: 0, files: [] })]);
    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0, 0],
      }),
    ).resolves.toMatchObject({ status: "no-diff", session: { fileCount: 0 } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not report a stale no-diff frame after the managed session disappears", async () => {
    let lookup = 0;
    const frames = [[session({ fileCount: 0, files: [] })], []];
    const run = runner([], () => frames[Math.min(lookup++, frames.length - 1)]!);

    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0],
      }),
    ).resolves.toEqual({ status: "not-found" });
  });

  it("waits for the exact managed PID instead of adopting a same-repo session", async () => {
    let lookup = 0;
    const frames = [
      [session({ sessionId: "unrelated", pid: 202 })],
      [session({ sessionId: "managed", pid: 101 })],
    ];
    const run = runner([], () => frames[Math.min(lookup++, frames.length - 1)]!);

    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0],
      }),
    ).resolves.toMatchObject({
      status: "reviewable",
      session: { sessionId: "managed", pid: 101 },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gates comment list on a live repo session", async () => {
    const run = runner([], []);
    await expect(readHunkReview({ cwd: "/repo", run })).resolves.toMatchObject({
      status: "no-live-session",
      notes: [],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("strictly shapes current comment payload with note id and full ranges", async () => {
    await expect(readHunkReview({ cwd: "/repo", run: runner([note()]) })).resolves.toMatchObject({
      status: "live",
      sessionId: "s1",
      pid: 101,
      notes: [
        {
          noteId: "user:1",
          file: "src/a.ts",
          oldLine: 4,
          newLine: 5,
          oldRange: [4, 6],
          newRange: [5, 8],
          summary: "Fix this",
          rationale: "Because it breaks",
        },
      ],
    });
  });

  it("selects the exact managed PID even when a newer same-repo session exists", async () => {
    const sessions = [
      session({ sessionId: "managed", pid: 123, launchedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "newer", pid: 456, launchedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const run = runner([note()], sessions, "managed");
    await expect(
      readHunkReview({ cwd: "/repo/subdir", managedPid: 123, run }),
    ).resolves.toMatchObject({
      status: "live",
      sessionId: "managed",
      pid: 123,
    });
    expect(run).toHaveBeenNthCalledWith(2, [
      "hunk",
      "session",
      "comment",
      "list",
      "managed",
      "--type",
      "user",
      "--json",
    ]);
  });

  it("rejects duplicate live session identities instead of choosing the first record", async () => {
    const sessions = [session({ pid: 111 }), session({ pid: 222 })];
    const run = runner([], sessions);

    await expect(readHunkReview({ cwd: "/repo", sessionId: "s1", run })).rejects.toThrow(
      /sessionId duplicates/,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails as ambiguous when the managed PID is absent and multiple same-repo sessions match", async () => {
    const sessions = [
      session({ sessionId: "first", pid: 111, launchedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "second", pid: 222, launchedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const run = runner([note()], sessions, "first");
    await expect(readHunkReview({ cwd: "/repo", managedPid: 999, run })).rejects.toThrow(
      /Ambiguous live Hunk sessions/,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to a unique repository match for command wrappers", async () => {
    const sessions = [session({ sessionId: "wrapped", pid: 222 })];
    const run = runner([note()], sessions, "wrapped");
    await expect(readHunkReview({ cwd: "/repo", managedPid: 999, run })).resolves.toMatchObject({
      status: "live",
      sessionId: "wrapped",
      pid: 222,
    });
  });

  it("treats dot-dot-prefixed path names as inside the repository", async () => {
    const sessions = [session({ sessionId: "dot-config", pid: 222, repoRoot: "/repo/project" })];
    const run = runner([note()], sessions, "dot-config");
    await expect(
      readHunkReview({ cwd: "/repo/project/..config", managedPid: 999, run }),
    ).resolves.toMatchObject({ status: "live", sessionId: "dot-config" });
  });

  it("rejects parent-relative repository matches", async () => {
    const run = runner([], [session({ repoRoot: "/repo/project" })]);
    await expect(
      readHunkReview({ cwd: "/repo/sibling", managedPid: 999, run }),
    ).resolves.toMatchObject({
      status: "no-live-session",
    });
  });

  it("ignores unrelated valid sessions whose repoRoot is absent", async () => {
    const sessions = [
      session({
        sessionId: "repo-less",
        pid: 111,
        cwd: "/other",
        repoRoot: undefined,
        launchedAt: "2026-01-02T00:00:00.000Z",
      }),
      session({ sessionId: "match", pid: 222, launchedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const run = runner([note()], sessions, "match");
    await expect(readHunkReview({ cwd: "/repo", managedPid: 999, run })).resolves.toMatchObject({
      status: "live",
      sessionId: "match",
    });
  });

  it("honors a pinned session id even when another matching session has the managed PID", async () => {
    const sessions = [
      session({ sessionId: "pinned", pid: 111, launchedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "exact-pid", pid: 222, launchedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    await expect(
      readHunkReview({
        cwd: "/repo",
        sessionId: "pinned",
        managedPid: 222,
        run: runner([], sessions, "pinned"),
      }),
    ).resolves.toMatchObject({ status: "live", sessionId: "pinned", notes: [] });
  });

  it("treats comment-list ranges as inclusive positive endpoints", async () => {
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([note("Single line", { oldRange: [4, 4], newRange: undefined })]),
      }),
    ).resolves.toMatchObject({
      notes: [{ oldRange: [4, 4], newRange: null, oldLine: 4, newLine: null }],
    });

    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([note("Zero line", { oldRange: [0, 0], newRange: undefined })]),
      }),
    ).rejects.toThrow("ordered positive range");

    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([note("Inverted", { oldRange: [7, 6], newRange: undefined })]),
      }),
    ).rejects.toThrow("ordered positive range");
  });

  it("rejects duplicate note identities instead of submitting one note twice", async () => {
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([note("First copy"), note("Second copy", { filePath: "src/b.ts" })]),
      }),
    ).rejects.toThrow(/noteId duplicates/);
  });

  it("fails loudly on comment and session schema drift", async () => {
    await expect(
      readHunkReview({ cwd: "/repo", run: runner([{ source: "user", file: "bad", body: "x" }]) }),
    ).rejects.toThrow("JSON drift");
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([], [session({ launchedAt: "not-a-timestamp" })]),
      }),
    ).rejects.toThrow("valid timestamp");
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([], [session({ sessionId: "" })]),
      }),
    ).rejects.toThrow("non-empty sessionId");
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([], [session({ repoRoot: "" })]),
      }),
    ).rejects.toThrow("repoRoot");
    await expect(
      readHunkReview({
        cwd: "/repo",
        run: runner([], [session({ cwd: "relative/repo", repoRoot: "/repo" })]),
      }),
    ).rejects.toThrow("absolute path");
  });
});

describe("asynchronous Hunk comment handoff", () => {
  it("returns unavailable outside TUI without probing a surface", async () => {
    const { gate, coordinator } = setup([]);

    await expect(
      gate.submit({ cwd: "/repo", mode: "rpc" } as ExtensionContext),
    ).resolves.toMatchObject({ status: "unavailable", reason: "not-tui" });
    expect(coordinator.ensureOpen).not.toHaveBeenCalled();
  });

  it("submits unseen comments when any managed surface is hidden", async () => {
    const { gate, coordinator } = setup([note("Found on hide")]);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => undefined);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");

    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    expect(delivery).toHaveBeenCalledWith([
      expect.objectContaining({ noteId: "user:1", summary: "Found on hide" }),
    ]);
    expect(coordinator.sessionId).toBe("s1");
    expect(coordinator.repoRoot).toBe("/repo");
  });

  it("delivers each note once across repeated hide and restore cycles", async () => {
    let comments: unknown[] = [note("First", { noteId: "user:1" })];
    const { gate, coordinator } = setup(() => comments);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => undefined);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden", true);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());

    comments = [...comments, note("Second", { noteId: "user:2", newRange: [10, 10] })];
    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(2));
    expect(delivery.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ noteId: "user:2", summary: "Second" }),
    ]);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivery).toHaveBeenCalledTimes(2);
  });

  it("treats a comment-free hide as a no-op", async () => {
    const { gate, coordinator } = setup([]);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => undefined);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(delivery).not.toHaveBeenCalled();
    expect(coordinator.state).toBe("hidden");
  });

  it("lets /hunk feedback retry a failed automatic delivery", async () => {
    const { gate, coordinator, ctx } = setup([note("Retry me")]);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => {
      if (delivery.mock.calls.length === 1) throw new Error("Pi is busy");
    });
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(gate.submit(ctx)).resolves.toMatchObject({ status: "submitted" });
    expect(delivery).toHaveBeenCalledTimes(2);
  });

  it("routes successful mutation evidence without a blocking review tool", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-route-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const managedSession = session({ cwd: root, repoRoot: root });
      const waitForSession = vi.fn(
        async () => ({ status: "reviewable", session: managedSession }) as const,
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [managedSession]),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [root],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: root,
        fileCount: 1,
      });
      expect(coordinator.state).toBe("visible");
      expect(coordinator.repoRoot).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the next queued repository without approval semantics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-next-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const waitForSession = vi.fn(async (options: { cwd: string }) => {
        const repoRoot = options.cwd === repoA ? repoA : repoB;
        return {
          status: "reviewable" as const,
          session: session({
            sessionId: repoRoot === repoA ? "repo-a" : "repo-b",
            cwd: repoRoot,
            repoRoot,
          }),
        };
      });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([]),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [repoA, repoB],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: repoA,
      });
      await expect(gate.next(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: repoB,
      });
      expect(coordinator.launchCwd).toBe(repoB);
      await expect(gate.next(ctx)).resolves.toEqual({ status: "no-evidence" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns target-required for unresolved pathless mutations", async () => {
    const { gate, coordinator, ctx } = setup([]);
    gate.addEvidence({ mutation: true, targets: [], unresolved: true, revision: 1 });

    await expect(gate.presentAutomatic(ctx)).resolves.toEqual({ status: "target-required" });
    expect(coordinator.ensureOpen).not.toHaveBeenCalled();
  });

  it("caches an authoritative no-diff result", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-no-diff-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const emptySession = session({
        cwd: root,
        repoRoot: root,
        fileCount: 0,
        files: [],
      });
      const waitForSession = vi.fn(
        async () => ({ status: "no-diff", session: emptySession }) as const,
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [emptySession]),
        waitForSession,
      );
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({ status: "no-diff" });
      const opens = coordinator.ensureOpen.mock.calls.length;
      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({ status: "no-diff" });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(opens);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
