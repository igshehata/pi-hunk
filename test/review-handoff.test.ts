import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
}

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
const acceptedDelivery = async (_notes: HunkReviewNote[]) => ({ status: "accepted" as const });

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
  command = "hunk";
  args: string[] = ["diff", "--watch"];
  source: "auto" | "live" | "manual" | "shortcut" | "recover" | "handoff" = "handoff";
  repoRoot: string | undefined;
  sessionId: string | undefined;
  stateListeners = new Set<() => void>();
  ensureOpen = vi.fn(async (...args: unknown[]) => {
    this.launchCwd = (args[4] as string | undefined) ?? this.launchCwd;
    this.args = (args[2] as string[] | undefined) ?? this.args;
    this.source = (args[3] as typeof this.source | undefined) ?? this.source;
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
          argsKey: JSON.stringify([this.launchCwd, this.command, ...this.args]),
          launchCwd: this.launchCwd,
          source: this.source,
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
  showManagedSurface = vi.fn(async (managedPid: number, sessionId?: string) => {
    if (this.pid !== managedPid || (sessionId !== undefined && this.sessionId !== sessionId)) {
      return false;
    }
    this.state = "visible";
    this.emit();
    return true;
  });
  adoptEarlySurfaceForRun() {}
  isEarlySurfaceOwnedForRun() {
    return false;
  }
  releaseSurfaceForRouting = vi.fn(async () => {
    this.state = "closed";
    this.emit();
    return true;
  });
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
    waitForSession?: ConstructorParameters<typeof ReviewHandoffGate>[3];
  } = {},
) {
  const coordinator = new FakeCoordinator();
  coordinator.pid = options.pid ?? 101;
  const run = runner(comments, options.sessions, options.expectedSessionId);
  const gate = new ReviewHandoffGate(
    coordinator as unknown as ReviewCoordinator,
    () => DEFAULT_CONFIG,
    run,
    options.waitForSession,
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

  it("keeps an empty managed registration reviewable after the bounded retry window", async () => {
    const run = runner([], [session({ fileCount: 0, files: [] })]);
    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0, 0],
      }),
    ).resolves.toMatchObject({ status: "reviewable", session: { fileCount: 0 } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not treat empty frames as terminal no-diff when a later observation has files", async () => {
    let lookup = 0;
    // Seven empty registrations exhaust the default retry window; an eighth
    // non-empty registration must still be reachable because empty is unconfirmed.
    const empty = session({ fileCount: 0, files: [] });
    const filled = session({ fileCount: 1, files: [{ path: "src/a.ts" }] });
    const frames = Array.from({ length: 7 }, () => [empty]).concat([[filled]]);
    const run = runner([], () => frames[Math.min(lookup++, frames.length - 1)]!);

    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0, 0, 0, 0, 0, 0, 0],
      }),
    ).resolves.toMatchObject({ status: "reviewable", session: { fileCount: 0 } });
    expect(run).toHaveBeenCalledTimes(7);

    // A subsequent observation (outside the first bounded window) becomes reviewable.
    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0],
      }),
    ).resolves.toMatchObject({ status: "reviewable", session: { fileCount: 1 } });
    expect(run).toHaveBeenCalledTimes(8);
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

  it("never repository-falls back during a strict managed-PID lookup", async () => {
    const run = runner([], [session({ sessionId: "wrapper-child", pid: 202 })]);
    await expect(
      waitForManagedHunkSession({
        cwd: "/repo",
        managedPid: 101,
        run,
        retryDelaysMs: [0],
      }),
    ).resolves.toEqual({ status: "not-found" });
    expect(run).toHaveBeenCalledOnce();
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

  it.runIf(process.platform !== "win32")(
    "matches a unique repository through a canonical-equivalent symlink cwd",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-session-symlink-")));
      const repo = join(root, "repo");
      const linkedRepo = join(root, "linked-repo");
      try {
        await mkdir(join(repo, "packages", "app"), { recursive: true });
        await symlink(repo, linkedRepo, "dir");
        const sessions = [session({ sessionId: "canonical", pid: 222, cwd: repo, repoRoot: repo })];
        await expect(
          readHunkReview({
            cwd: join(linkedRepo, "packages", "app"),
            managedPid: 999,
            run: runner([note()], sessions, "canonical"),
          }),
        ).resolves.toMatchObject({ status: "live", sessionId: "canonical" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores an exact stale PID from a sibling worktree and uses the unique same-worktree wrapper session",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-session-worktree-")));
      const mainRepo = join(root, "main");
      const featureRepo = join(root, "feature");
      try {
        await mkdir(mainRepo);
        await git(mainRepo, ["init"]);
        await git(mainRepo, ["config", "user.email", "pi-hunk@example.com"]);
        await git(mainRepo, ["config", "user.name", "pi-hunk"]);
        await writeFile(join(mainRepo, "README.md"), "main\n");
        await git(mainRepo, ["add", "README.md"]);
        await git(mainRepo, ["commit", "-m", "init"]);
        await git(mainRepo, ["worktree", "add", "-b", "feature", featureRepo]);

        const sessions = [
          session({ sessionId: "stale-main", pid: 999, cwd: mainRepo, repoRoot: mainRepo }),
          session({
            sessionId: "feature-wrapper",
            pid: 222,
            cwd: featureRepo,
            repoRoot: featureRepo,
          }),
        ];
        await expect(
          readHunkReview({
            cwd: featureRepo,
            managedPid: 999,
            run: runner([note()], sessions, "feature-wrapper"),
          }),
        ).resolves.toMatchObject({
          status: "live",
          sessionId: "feature-wrapper",
          pid: 222,
        });
      } finally {
        await execFileAsync("git", ["-C", mainRepo, "worktree", "remove", "--force", featureRepo], {
          encoding: "utf8",
          timeout: 10_000,
        }).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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

  it("requires a supplied session id and managed PID to identify the same session", async () => {
    const sessions = [
      session({ sessionId: "pinned", pid: 111, launchedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "exact-pid", pid: 222, launchedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const run = runner([], sessions, "pinned");
    await expect(
      readHunkReview({
        cwd: "/repo",
        sessionId: "pinned",
        managedPid: 222,
        run,
      }),
    ).resolves.toMatchObject({ status: "no-live-session", notes: [] });
    expect(run).toHaveBeenCalledOnce();
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
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");

    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    expect(delivery).toHaveBeenCalledWith(
      [expect.objectContaining({ noteId: "user:1", summary: "Found on hide" })],
      expect.objectContaining({ epoch: 0, signal: expect.any(AbortSignal) }),
    );
    expect(coordinator.sessionId).toBe("s1");
    expect(coordinator.repoRoot).toBe("/repo");
  });

  it("delivers each note once across repeated hide and restore cycles", async () => {
    let comments: unknown[] = [note("First", { noteId: "user:1" })];
    const { gate, coordinator } = setup(() => comments);
    const delivery = vi.fn(acceptedDelivery);
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

  it("resets submitted-note deduplication at a Pi session boundary", async () => {
    let comments: unknown[] = [note("First session")];
    const { gate, coordinator } = setup(() => comments);
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());

    gate.resetSession();
    comments = [note("Next session")];
    coordinator.transition("visible");
    coordinator.transition("hidden");

    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(2));
    expect(delivery.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ noteId: "user:1", summary: "Next session" }),
    ]);
  });

  it.each(["success", "failure"] as const)(
    "quarantines and drains an in-flight old-epoch %s across reset",
    async (outcome) => {
      let comments: unknown[] = [note("Old session")];
      const { gate, coordinator } = setup(() => comments);
      let resolveOld!: (result: { status: "accepted" }) => void;
      let rejectOld!: (error: Error) => void;
      let oldSignal: AbortSignal | undefined;
      const oldDelivery = vi.fn(
        (_notes: HunkReviewNote[], context: { epoch: number; signal: AbortSignal }) => {
          oldSignal = context.signal;
          return new Promise<{ status: "accepted" }>((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          });
        },
      );
      gate.onLateSubmission(oldDelivery);

      coordinator.transition("visible");
      coordinator.transition("hidden");
      await vi.waitFor(() => expect(oldDelivery).toHaveBeenCalledOnce());

      const drained = gate.resetSession();
      expect(drained).toMatchObject({ epoch: 0, abortedInFlight: true });
      expect(drained.notes).toEqual([
        expect.objectContaining({ noteId: "user:1", summary: "Old session" }),
      ]);
      expect(oldSignal?.aborted).toBe(true);

      if (outcome === "success") resolveOld({ status: "accepted" });
      else rejectOld(new Error("old context closed"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The same Hunk note identity in the new epoch must remain unseen. An old
      // success must not add to new dedupe, and an old failure must not enqueue
      // itself for delivery through the replacement handler/context.
      comments = [note("New session")];
      const newDelivery = vi.fn(acceptedDelivery);
      gate.onLateSubmission(newDelivery);
      coordinator.transition("visible");
      coordinator.transition("hidden");
      await vi.waitFor(() => expect(newDelivery).toHaveBeenCalledOnce());
      expect(newDelivery).toHaveBeenCalledWith(
        [expect.objectContaining({ noteId: "user:1", summary: "New session" })],
        expect.objectContaining({ epoch: 1, signal: expect.any(AbortSignal) }),
      );
      expect(oldDelivery).toHaveBeenCalledOnce();

      coordinator.transition("visible");
      coordinator.transition("hidden");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(newDelivery).toHaveBeenCalledOnce();
    },
  );

  it("treats a comment-free hide as a no-op", async () => {
    const { gate, coordinator } = setup([]);
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(delivery).not.toHaveBeenCalled();
    expect(coordinator.state).toBe("hidden");
  });

  it("serializes close preservation behind an in-flight hide inspection without duplicate delivery", async () => {
    let finishHide!: (value: { status: "reviewable"; session: ReturnType<typeof session> }) => void;
    let lookup = 0;
    const waitForSession = vi.fn(() => {
      lookup += 1;
      if (lookup === 1) {
        return new Promise<{ status: "reviewable"; session: ReturnType<typeof session> }>(
          (resolve) => {
            finishHide = resolve;
          },
        );
      }
      return Promise.resolve({ status: "reviewable" as const, session: session() });
    });
    const { gate, coordinator } = setup([note("Preserve before close")], { waitForSession });
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(finishHide).toBeTypeOf("function"));
    const barrier = gate.beforeDestructiveTransition("close");
    expect(waitForSession).toHaveBeenCalledOnce();

    finishHide({ status: "reviewable", session: session() });
    await expect(barrier).resolves.toMatchObject({ status: "ready", transition: "close" });
    expect(waitForSession).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenCalledOnce();
    expect(delivery.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ noteId: "user:1", summary: "Preserve before close" }),
    ]);
  });

  it("runs a fresh exact-session barrier probe for notes added shortly after hide", async () => {
    let comments: unknown[] = [];
    const { gate, coordinator, run } = setup(() => comments);
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() =>
      expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(1),
    );
    expect(delivery).not.toHaveBeenCalled();

    comments = [note("Arrived after hide")];
    await expect(gate.beforeDestructiveTransition("close")).resolves.toMatchObject({
      status: "ready",
      notes: [expect.objectContaining({ summary: "Arrived after hide" })],
    });
    expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
    expect(delivery).toHaveBeenCalledOnce();
  });

  it("rechecks once for a note persisted shortly after the surface is hidden", async () => {
    vi.useFakeTimers();
    try {
      let comments: unknown[] = [];
      const { gate, coordinator, run } = setup(() => comments, {
        waitForSession: async () => ({ status: "reviewable", session: session() }),
      });
      const delivery = vi.fn(acceptedDelivery);
      gate.onLateSubmission(delivery);

      coordinator.transition("visible");
      coordinator.transition("hidden");
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(1);

      comments = [note("Persisted just after hide")];
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
      expect(delivery.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ summary: "Persisted just after hide" }),
      ]);
      expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs a fresh probe when a hidden review is restored before its debounce", async () => {
    let comments: unknown[] = [];
    const { gate, coordinator, run } = setup(() => comments);
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() =>
      expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(1),
    );

    comments = [note("Persisted before restore")];
    coordinator.transition("visible");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    expect(delivery.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ summary: "Persisted before restore" }),
    ]);
    expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
  });

  it("lets /hunk feedback wait behind a queued hide inspection without deadlocking or resending", async () => {
    let finishHide!: (value: { status: "reviewable"; session: ReturnType<typeof session> }) => void;
    let lookup = 0;
    const waitForSession = vi.fn(() => {
      lookup += 1;
      if (lookup === 1) {
        return new Promise<{ status: "reviewable"; session: ReturnType<typeof session> }>(
          (resolve) => {
            finishHide = resolve;
          },
        );
      }
      return Promise.resolve({ status: "reviewable" as const, session: session() });
    });
    const { gate, coordinator, ctx } = setup([note("Queued hide note")], { waitForSession });
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(finishHide).toBeTypeOf("function"));
    const feedback = gate.submit(ctx);
    finishHide({ status: "reviewable", session: session() });

    await expect(feedback).resolves.toMatchObject({ status: "pending" });
    expect(waitForSession).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenCalledOnce();
  });

  it("fails closed for user destruction but warns and continues for lifecycle teardown", async () => {
    const { gate, coordinator, run } = setup([note("Unreachable")]);
    const implementation = run.getMockImplementation()!;
    run.mockImplementation(async (argv) => {
      if (argv.includes("comment")) throw new Error("comment service unavailable");
      return implementation(argv);
    });
    const warnings = vi.fn();
    gate.onLateProbeWarning(warnings);
    coordinator.transition("visible");

    await expect(gate.beforeDestructiveTransition("close")).resolves.toMatchObject({
      status: "unavailable",
      behavior: "block",
      reason: "comment-probe-failed",
    });
    expect(warnings).not.toHaveBeenCalled();

    await expect(gate.beforeDestructiveTransition("shutdown")).resolves.toMatchObject({
      status: "unavailable",
      behavior: "continue-best-effort",
      reason: "comment-probe-failed",
    });
    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("teardown will continue"));
  });

  it("lets /hunk feedback retry a failed automatic delivery", async () => {
    const { gate, coordinator, ctx } = setup([note("Retry me")]);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => {
      if (delivery.mock.calls.length === 1) throw new Error("Pi is busy");
      return { status: "accepted" as const };
    });
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(gate.submit(ctx)).resolves.toMatchObject({ status: "submitted" });
    expect(delivery).toHaveBeenCalledTimes(2);
  });

  it("still probes for newer comments while retrying queued delivery", async () => {
    let comments: unknown[] = [note("First", { noteId: "user:1" })];
    const { gate, coordinator, ctx, run } = setup(() => comments);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => {
      if (delivery.mock.calls.length === 1) throw new Error("Pi is busy");
      return { status: "accepted" as const };
    });
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    comments = [...comments, note("Second", { noteId: "user:2", newRange: [10, 10] })];
    await expect(gate.submit(ctx)).resolves.toMatchObject({
      status: "submitted",
      notes: [
        expect.objectContaining({ noteId: "user:1" }),
        expect.objectContaining({ noteId: "user:2" }),
      ],
    });
    expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
    expect(delivery).toHaveBeenCalledTimes(3);
    expect(delivery.mock.calls[2]?.[0]).toEqual([
      expect.objectContaining({ noteId: "user:2", summary: "Second" }),
    ]);
  });

  it("keeps unconfirmed notes recoverable without an immediate resend loop", async () => {
    const { gate, coordinator, ctx } = setup([note("Awaiting acceptance")]);
    const delivery = vi.fn(async (_notes: HunkReviewNote[]) => ({
      status: "unconfirmed" as const,
    }));
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivery).toHaveBeenCalledOnce();

    await expect(gate.submit(ctx)).resolves.toMatchObject({ status: "pending" });
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(delivery.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ noteId: "user:1", summary: "Awaiting acceptance" }),
    ]);
  });

  it("warns once per failed hide lifecycle and lets /hunk feedback recover exactly once", async () => {
    const comments = [
      note("Recovered first", { noteId: "user:1" }),
      note("Recovered second", { noteId: "user:2", newRange: [10, 10] }),
    ];
    const { gate, coordinator, ctx, run } = setup(comments);
    const implementation = run.getMockImplementation()!;
    let failProbe = true;
    run.mockImplementation(async (argv) => {
      if (argv.includes("comment") && failProbe) {
        throw new Error("temporary Hunk failure");
      }
      return implementation(argv);
    });
    const delivery = vi.fn(acceptedDelivery);
    const warnings = vi.fn();
    gate.onLateProbeWarning(warnings);
    gate.onLateSubmission(delivery);

    coordinator.transition("visible");
    coordinator.transition("hidden", true);
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledOnce());
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("comments were not inspected"));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("/hunk feedback"));
    expect(delivery).not.toHaveBeenCalled();

    failProbe = false;
    await expect(gate.submit(ctx)).resolves.toMatchObject({
      status: "submitted",
      notes: [
        expect.objectContaining({ noteId: "user:1", summary: "Recovered first" }),
        expect.objectContaining({ noteId: "user:2", summary: "Recovered second" }),
      ],
    });
    expect(delivery).toHaveBeenCalledOnce();
    expect(delivery.mock.calls[0]?.[0]).toHaveLength(2);

    // A fresh explicit inspection sees the same open comments, but accepted
    // note identities are not delivered a second time.
    await expect(gate.submit(ctx)).resolves.toMatchObject({ status: "pending" });
    expect(delivery).toHaveBeenCalledOnce();

    // A genuinely later visible→hidden review lifecycle gets its own diagnosis.
    failProbe = true;
    coordinator.transition("visible");
    coordinator.transition("hidden", true);
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledTimes(2));
    expect(delivery).toHaveBeenCalledOnce();
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
        routing: "opened",
      });
      expect(coordinator.state).toBe("visible");
      expect(coordinator.repoRoot).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consumes a repo-root-missing head, releases its route surface, and presents the next repository", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-terminal-route-")));
    const invalidRoot = join(root, "not-a-repo");
    const validRoot = join(root, "repo");
    try {
      await Promise.all([mkdir(invalidRoot), mkdir(validRoot)]);
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const missingRoot = session({
        sessionId: "missing-root",
        cwd: invalidRoot,
        repoRoot: undefined,
      });
      const validSession = session({ sessionId: "valid", cwd: validRoot, repoRoot: validRoot });
      const waitForSession = vi.fn(async (options: { cwd: string }) =>
        options.cwd === invalidRoot
          ? ({ status: "reviewable", session: missingRoot } as const)
          : ({ status: "reviewable", session: validSession } as const),
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [validSession], "valid"),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [invalidRoot, validRoot],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: validRoot,
        fileCount: 1,
        routing: "opened",
      });
      expect(waitForSession).toHaveBeenCalledTimes(2);
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(2);
      expect(coordinator.releaseSurfaceForRouting).toHaveBeenCalledOnce();
      expect(coordinator.repoRoot).toBe(validRoot);
      expect(coordinator.state).toBe("visible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds registration retries without letting an unregistered head pin later work", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-registration-route-")));
    const unavailableRoot = join(root, "unavailable");
    const validRoot = join(root, "repo");
    try {
      await Promise.all([mkdir(unavailableRoot), mkdir(validRoot)]);
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const validSession = session({ sessionId: "valid", cwd: validRoot, repoRoot: validRoot });
      const waitForSession = vi.fn(async (options: { cwd: string; sessionId?: string }) => {
        if (options.sessionId === "valid") {
          return { status: "reviewable", session: validSession } as const;
        }
        return options.cwd === unavailableRoot
          ? ({ status: "not-found" } as const)
          : ({ status: "reviewable", session: validSession } as const);
      });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [validSession], "valid"),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [unavailableRoot, validRoot],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: validRoot,
      });
      expect(coordinator.releaseSurfaceForRouting).toHaveBeenCalledOnce();

      await expect(gate.next(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "session-not-registered",
      });
      await expect(gate.next(ctx)).resolves.toEqual({ status: "no-evidence" });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(3);
      expect(coordinator.releaseSurfaceForRouting).toHaveBeenCalledTimes(2);
      expect(coordinator.state).toBe("closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not release a reused manual surface when its candidate is terminal", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-manual-terminal-route-")));
    const manualRoot = join(root, "manual");
    const validRoot = join(root, "repo");
    try {
      await Promise.all([mkdir(manualRoot), mkdir(validRoot)]);
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      coordinator.launchCwd = manualRoot;
      coordinator.source = "manual";
      coordinator.state = "hidden";
      coordinator.sessionId = "manual";
      coordinator.repoRoot = manualRoot;
      const missingRoot = session({
        sessionId: "manual",
        cwd: manualRoot,
        repoRoot: undefined,
      });
      const manualSession = session({ sessionId: "manual", cwd: manualRoot, repoRoot: manualRoot });
      const validSession = session({ sessionId: "valid", cwd: validRoot, repoRoot: validRoot });
      const waitForSession = vi.fn(async (options: { cwd: string; sessionId?: string }) => {
        if (options.sessionId === "manual") {
          return { status: "reviewable", session: manualSession } as const;
        }
        return options.cwd === manualRoot
          ? ({ status: "reviewable", session: missingRoot } as const)
          : ({ status: "reviewable", session: validSession } as const);
      });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [manualSession], "manual"),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [manualRoot, validRoot],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: validRoot,
      });
      // The valid route deliberately replaces the inspected manual surface;
      // terminal cleanup itself must never release that user-owned surface.
      expect(coordinator.releaseSurfaceForRouting).not.toHaveBeenCalled();
      expect(coordinator.ensureOpen).toHaveBeenCalledOnce();
      expect(coordinator.repoRoot).toBe(validRoot);
      expect(coordinator.state).toBe("visible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retargets a cross-repo existing-file symlink seed to its canonical repository", async () => {
    // repo-a/link.ts → repo-b/src/file.ts. Lexical launch starts in repo A;
    // Hunk reports repo A; the real target lives in repo B and must stay queued.
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-seed-symlink-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    const realFile = join(repoB, "src", "file.ts");
    const repoAFile = join(repoA, "other.ts");
    const linkPath = join(repoA, "link.ts");
    try {
      await Promise.all([
        mkdir(join(repoA), { recursive: true }),
        mkdir(join(repoB, "src"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(realFile, "export const value = 1;\n"),
        writeFile(repoAFile, "export const other = 1;\n"),
      ]);
      await symlink(realFile, linkPath);

      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const sessionA = session({
        sessionId: "repo-a",
        cwd: repoA,
        repoRoot: repoA,
        files: [{ path: "link.ts" }],
      });
      const sessionB = session({
        sessionId: "repo-b",
        cwd: join(repoB, "src"),
        repoRoot: repoB,
        files: [{ path: "src/file.ts" }],
      });
      const waitForSession = vi.fn(async (options: { cwd: string }) => {
        // First launch is near the symlink parent (repo A). After retargeting,
        // resolveLaunchDirectory walks from the real file into repo B.
        const inRepoB =
          options.cwd === repoB ||
          options.cwd.startsWith(`${repoB}/`) ||
          options.cwd.startsWith(`${repoB}\\`);
        return {
          status: "reviewable" as const,
          session: inRepoB ? sessionB : sessionA,
        };
      });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [sessionA, sessionB], "repo-b"),
        waitForSession,
      );
      // Evidence names the symlink path the agent wrote through, not the real file.
      gate.addEvidence({
        mutation: true,
        targets: [linkPath, repoAFile],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: repoA, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: repoB,
        fileCount: 1,
        routing: "opened",
      });

      // Two launches: mismatched repo A (closed), then the covering repo B.
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(2);
      expect(coordinator.ensureOpen.mock.calls[0]?.[4]).toBe(repoA);
      expect(coordinator.ensureOpen.mock.calls[1]?.[4]).toBe(join(repoB, "src"));
      expect(coordinator.repoRoot).toBe(repoB);
      expect(coordinator.state).toBe("visible");

      // Validating the mismatched seed must not consume a separate repo-A
      // candidate before any repo-A surface has actually been presented.
      await expect(gate.next(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: repoA,
        fileCount: 1,
        routing: "rerouted",
      });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(3);
      expect(coordinator.ensureOpen.mock.calls[2]?.[4]).toBe(repoA);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a canonical seed retryable when Hunk reports a non-covering root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-seed-mismatch-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    const realFile = join(repoB, "src", "file.ts");
    try {
      await mkdir(join(repoB, "src"), { recursive: true });
      await writeFile(realFile, "export const value = 1;\n");

      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      // Hunk claims repo A even though the seed is the real path inside repo B.
      const mismatched = session({
        sessionId: "repo-a",
        cwd: repoA,
        repoRoot: repoA,
      });
      const waitForSession = vi.fn(
        async () => ({ status: "reviewable", session: mismatched }) as const,
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [mismatched]),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [realFile],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: repoB, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "repo-root-mismatch",
      });
      // Candidate remains queued for a later retry, while the route-owned
      // non-covering surface is closed instead of misleading the user.
      expect(coordinator.ensureOpen).toHaveBeenCalledOnce();
      expect(coordinator.state).toBe("closed");
      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "repo-root-mismatch",
      });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(2);
      expect(coordinator.state).toBe("closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requeues a current route-owned candidate before closing a mismatched surface", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-current-mismatch-")));
    const repoRoot = join(root, "repo");
    const seedRoot = join(root, "seeds");
    const repoFile = join(repoRoot, "file.ts");
    const seedPath = join(seedRoot, "file.ts");
    try {
      await Promise.all([
        mkdir(repoRoot, { recursive: true }),
        mkdir(seedRoot, { recursive: true }),
      ]);
      await writeFile(repoFile, "export const inside = true;\n");
      await symlink(repoFile, seedPath);

      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const adoptedSession = session({
        sessionId: "adopted",
        cwd: repoRoot,
        repoRoot,
        files: [{ path: "file.ts" }],
      });
      const outsideSession = session({
        sessionId: "outside",
        cwd: seedRoot,
        repoRoot: seedRoot,
        files: [{ path: "file.ts" }],
      });
      let lookup = 0;
      const waitForSession = vi.fn(async () => ({
        status: "reviewable" as const,
        session: lookup++ < 2 ? adoptedSession : outsideSession,
      }));
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [adoptedSession, outsideSession]),
        waitForSession,
      );
      gate.addEvidence({
        mutation: true,
        targets: [seedPath],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      // The external seed initially resolves through its symlink into the
      // adopted repository and becomes the current route-owned candidate.
      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot,
      });
      gate.onLateSubmission(acceptedDelivery);

      // Replacing the symlink with a real external file makes the same current
      // candidate canonical but no longer covered by the adopted repository.
      await rm(seedPath);
      await writeFile(seedPath, "export const outside = true;\n");
      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "repo-root-mismatch",
      });
      expect(coordinator.releaseSurfaceForRouting).toHaveBeenCalledOnce();
      expect(coordinator.state).toBe("closed");

      // The close notification above synchronously runs the production state
      // listener. A later automatic attempt must still retry this exact seed.
      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: seedRoot,
      });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(3);
      // A successful retry consumes the sole queued copy of the candidate.
      await expect(gate.next(ctx)).resolves.toEqual({ status: "no-evidence" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forgets the automatic target when its managed surface closes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-close-")));
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
      gate.onLateSubmission(acceptedDelivery);
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: root,
      });
      const opens = coordinator.ensureOpen.mock.calls.length;
      coordinator.transition("closed");
      gate.addEvidence({ mutation: true, targets: [], unresolved: true, revision: 2 });

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({ status: "target-required" });
      expect(coordinator.ensureOpen).toHaveBeenCalledTimes(opens);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a same-directory manual show surface for automatic review", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-manual-show-reuse-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 202;
      coordinator.launchCwd = root;
      coordinator.args = ["show", "HEAD~1"];
      coordinator.source = "manual";
      coordinator.state = "hidden";
      coordinator.sessionId = "manual-show";
      coordinator.repoRoot = root;

      const automaticSession = session({
        sessionId: "auto-watch",
        pid: 101,
        cwd: root,
        repoRoot: root,
      });
      const manualSession = session({
        sessionId: "manual-show",
        pid: 202,
        cwd: root,
        repoRoot: root,
      });
      const waitForSession = vi.fn(async (options: { managedPid?: number }) => {
        if (options.managedPid === 202) {
          return { status: "reviewable", session: manualSession } as const;
        }
        if (options.managedPid === 101) {
          return { status: "reviewable", session: automaticSession } as const;
        }
        throw new Error(`Unexpected managed pid: ${options.managedPid}`);
      });
      const run = runner(
        [note("Manual note on historical commit")],
        [manualSession, automaticSession],
        "manual-show",
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        run,
        waitForSession,
      );
      const delivery = vi.fn(acceptedDelivery);
      gate.onLateSubmission(delivery);
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      // Simulate ensureOpen replacing the mismatched show surface with the
      // configured automatic watcher before the subsequent session lookup.
      coordinator.ensureOpen.mockImplementation(async (...args: unknown[]) => {
        coordinator.launchCwd = (args[4] as string | undefined) ?? coordinator.launchCwd;
        coordinator.args = (args[2] as string[] | undefined) ?? coordinator.args;
        coordinator.source = (args[3] as typeof coordinator.source | undefined) ?? "auto";
        coordinator.pid = 101;
        coordinator.sessionId = "auto-watch";
        coordinator.repoRoot = root;
        coordinator.state = "visible";
        coordinator.emit();
      });

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: root,
      });

      expect(coordinator.ensureOpen).toHaveBeenCalledWith(
        ctx,
        DEFAULT_CONFIG,
        DEFAULT_CONFIG.hunk.args,
        "auto",
        root,
      );
      expect(coordinator.args).toEqual(DEFAULT_CONFIG.hunk.args);
      expect(coordinator.pid).toBe(101);
      expect(coordinator.showManagedSurface).not.toHaveBeenCalled();
      // Outgoing comments on the mismatched manual surface must be collected
      // before the process is replaced.
      expect(delivery).toHaveBeenCalledWith(
        [expect.objectContaining({ summary: "Manual note on historical commit" })],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(delivery.mock.invocationCallOrder[0]).toBeLessThan(
        coordinator.ensureOpen.mock.invocationCallOrder[0]!,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace a live manual surface that cannot be pinned for comment collection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-manual-unpinned-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.launchCwd = root;
      coordinator.args = ["show", "HEAD~1"];
      coordinator.source = "manual";
      coordinator.state = "hidden";
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
      );
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "outgoing-review-unavailable",
      });
      expect(coordinator.ensureOpen).not.toHaveBeenCalled();
      expect(coordinator.state).toBe("hidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace a mismatched manual surface when its comment probe fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-manual-probe-failure-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 202;
      coordinator.launchCwd = root;
      coordinator.args = ["show", "HEAD~1"];
      coordinator.source = "manual";
      coordinator.state = "hidden";
      coordinator.sessionId = "manual-show";
      coordinator.repoRoot = root;

      const manualSession = session({
        sessionId: "manual-show",
        pid: 202,
        cwd: root,
        repoRoot: root,
      });
      const waitForSession = vi.fn(
        async () => ({ status: "reviewable", session: manualSession }) as const,
      );
      const failedRun = vi.fn(async () => {
        throw new Error("manual comment probe failed");
      });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        failedRun,
        waitForSession,
      );
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "unavailable",
        reason: "comment-probe-failed",
        detail: expect.stringContaining("manual comment probe failed"),
      });

      expect(coordinator.ensureOpen).not.toHaveBeenCalled();
      expect(coordinator.pid).toBe(202);
      expect(coordinator.state).toBe("hidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses a matching manual surface opened through an equivalent symlink cwd", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "pi-hunk-manual-match-reuse-")),
    );
    const root = join(temporaryRoot, "repo");
    const linkedRoot = join(temporaryRoot, "repo-link");
    try {
      await mkdir(root);
      await symlink(root, linkedRoot, "dir");
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      coordinator.launchCwd = linkedRoot;
      coordinator.args = [...DEFAULT_CONFIG.hunk.args];
      coordinator.source = "manual";
      coordinator.state = "hidden";
      coordinator.sessionId = "manual-match";
      coordinator.repoRoot = root;

      const managedSession = session({
        sessionId: "manual-match",
        pid: 101,
        cwd: linkedRoot,
        repoRoot: root,
      });
      const waitForSession = vi.fn(
        async () => ({ status: "reviewable", session: managedSession }) as const,
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [managedSession], "manual-match"),
        waitForSession,
      );
      gate.onLateSubmission(acceptedDelivery);
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: root,
      });

      expect(coordinator.ensureOpen).not.toHaveBeenCalled();
      expect(coordinator.showManagedSurface).toHaveBeenCalledWith(101, "manual-match");
      expect(coordinator.args).toEqual(DEFAULT_CONFIG.hunk.args);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      identity: "PID before session metadata is adopted",
      manualPid: 202,
      activeSessionId: undefined,
    },
    {
      identity: "session when a PID is reused",
      manualPid: 101,
      activeSessionId: "manual",
    },
  ])(
    "probes the active $identity after a manual replacement",
    async ({ manualPid, activeSessionId }) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-replace-")));
      try {
        const coordinator = new FakeCoordinator();
        coordinator.pid = 101;
        const automaticSession = session({ cwd: root, repoRoot: root });
        const manualSession = session({
          sessionId: "manual",
          pid: manualPid,
          cwd: root,
          repoRoot: root,
        });
        const waitForSession = vi.fn(
          async (options: { sessionId?: string; managedPid?: number }) => {
            if (options.managedPid === manualPid && options.sessionId === activeSessionId) {
              return { status: "reviewable", session: manualSession } as const;
            }
            if (
              options.managedPid === 101 &&
              (options.sessionId === undefined || options.sessionId === "s1")
            ) {
              return { status: "reviewable", session: automaticSession } as const;
            }
            throw new Error(`Unexpected review target: ${JSON.stringify(options)}`);
          },
        );
        const gate = new ReviewHandoffGate(
          coordinator as unknown as ReviewCoordinator,
          () => DEFAULT_CONFIG,
          runner([note("Manual note")], [manualSession], "manual"),
          waitForSession,
        );
        const delivery = vi.fn(acceptedDelivery);
        gate.onLateSubmission(delivery);
        gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
        const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

        await expect(gate.presentAutomatic(ctx)).resolves.toMatchObject({
          status: "reviewable",
          repoRoot: root,
        });

        // /hunk show and manual /hunk invocations replace only the coordinator's
        // surface; the automatic routing plan still points at automaticSession.
        coordinator.pid = manualPid;
        coordinator.sessionId = activeSessionId;
        coordinator.repoRoot = root;
        coordinator.launchCwd = root;
        coordinator.state = "visible";

        await expect(gate.submit(ctx)).resolves.toMatchObject({
          status: "submitted",
          notes: [expect.objectContaining({ summary: "Manual note" })],
        });
        expect(waitForSession).toHaveBeenLastCalledWith(
          expect.objectContaining({
            managedPid: manualPid,
            sessionId: activeSessionId,
          }),
        );
        expect(delivery).toHaveBeenCalledWith(
          [expect.objectContaining({ summary: "Manual note" })],
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("abandons an explicit probe when the active surface changes during session lookup", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.state = "visible";
    coordinator.pid = 101;
    let finishLookup!: (value: {
      status: "reviewable";
      session: ReturnType<typeof session>;
    }) => void;
    const waitForSession = vi.fn(
      () =>
        new Promise<{ status: "reviewable"; session: ReturnType<typeof session> }>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const run = runner([note("Stale note")]);
    const gate = new ReviewHandoffGate(
      coordinator as unknown as ReviewCoordinator,
      () => DEFAULT_CONFIG,
      run,
      waitForSession,
    );
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);
    const ctx = { cwd: "/repo", mode: "tui" } as ExtensionContext;

    const pending = gate.submit(ctx);
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf("function"));
    coordinator.pid = 202;
    coordinator.sessionId = "replacement";
    finishLookup({ status: "reviewable", session: session() });

    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      reason: "surface-changed",
    });
    expect(run).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(coordinator.sessionId).toBe("replacement");
  });

  it("does not adopt or deliver an inspection that crosses a Pi session boundary", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.state = "visible";
    coordinator.pid = 101;
    let finishLookup!: (value: {
      status: "reviewable";
      session: ReturnType<typeof session>;
    }) => void;
    const waitForSession = vi.fn(
      () =>
        new Promise<{ status: "reviewable"; session: ReturnType<typeof session> }>((resolve) => {
          finishLookup = resolve;
        }),
    );
    const run = runner([note("Previous session note")]);
    const gate = new ReviewHandoffGate(
      coordinator as unknown as ReviewCoordinator,
      () => DEFAULT_CONFIG,
      run,
      waitForSession,
    );
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);
    const ctx = { cwd: "/repo", mode: "tui" } as ExtensionContext;

    const pending = gate.submit(ctx);
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf("function"));
    coordinator.transition("closed");
    gate.resetSession();
    finishLookup({ status: "reviewable", session: session() });

    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      reason: "session-boundary",
    });
    expect(run).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(coordinator.sessionId).toBeUndefined();
  });

  it("rejects an explicit probe queued across a Pi session boundary", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.state = "visible";
    coordinator.pid = 101;
    coordinator.repoRoot = "/old-repo";
    coordinator.sessionId = "old-session";
    const oldSession = session({
      sessionId: "old-session",
      cwd: "/old-repo",
      repoRoot: "/old-repo",
    });
    const newSession = session({
      sessionId: "new-session",
      pid: 202,
      cwd: "/new-repo",
      repoRoot: "/new-repo",
    });
    let lookup = 0;
    let finishOldProbe!: (value: { status: "reviewable"; session: typeof oldSession }) => void;
    const waitForSession = vi.fn(() => {
      lookup += 1;
      if (lookup === 1) {
        return new Promise<{ status: "reviewable"; session: typeof oldSession }>((resolve) => {
          finishOldProbe = resolve;
        });
      }
      return Promise.resolve({ status: "reviewable" as const, session: newSession });
    });
    const run = runner([note("New session note")], [newSession], "new-session");
    const gate = new ReviewHandoffGate(
      coordinator as unknown as ReviewCoordinator,
      () => DEFAULT_CONFIG,
      run,
      waitForSession,
    );
    const delivery = vi.fn(acceptedDelivery);
    gate.onLateSubmission(delivery);
    const ctx = { cwd: "/old-repo", mode: "tui" } as ExtensionContext;

    coordinator.transition("hidden");
    await vi.waitFor(() => expect(finishOldProbe).toBeTypeOf("function"));
    const queued = gate.submit(ctx);
    gate.resetSession();
    coordinator.pid = 202;
    coordinator.launchCwd = "/new-repo";
    coordinator.repoRoot = "/new-repo";
    coordinator.sessionId = "new-session";
    coordinator.transition("visible");
    finishOldProbe({ status: "reviewable", session: oldSession });

    await expect(queued).resolves.toMatchObject({
      status: "unavailable",
      reason: "session-boundary",
    });
    expect(waitForSession).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });

  it("opens the next queued repository without approval semantics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-next-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const sessionA = session({ sessionId: "repo-a", cwd: repoA, repoRoot: repoA });
      const sessionB = session({ sessionId: "repo-b", cwd: repoB, repoRoot: repoB });
      const waitForSession = vi.fn(async (options: { cwd: string }) => ({
        status: "reviewable" as const,
        session: options.cwd === repoA ? sessionA : sessionB,
      }));
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [sessionA], "repo-a"),
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

  it.each([
    { surface: "visible", hide: false },
    { surface: "hidden with a queued hide probe", hide: true },
  ])("collects notes from a $surface review before /hunk next replaces it", async ({ hide }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-next-probe-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const sessionA = session({ sessionId: "repo-a", cwd: repoA, repoRoot: repoA });
      const sessionB = session({ sessionId: "repo-b", cwd: repoB, repoRoot: repoB });
      let lookup = 0;
      let finishProbe!: (value: { status: "reviewable"; session: typeof sessionA }) => void;
      const waitForSession = vi.fn((options: { cwd: string }) => {
        lookup += 1;
        if (options.cwd === repoB) {
          return Promise.resolve({ status: "reviewable" as const, session: sessionB });
        }
        if (lookup === 1) {
          return Promise.resolve({ status: "reviewable" as const, session: sessionA });
        }
        if (lookup === 2) {
          return new Promise<{ status: "reviewable"; session: typeof sessionA }>((resolve) => {
            finishProbe = resolve;
          });
        }
        return Promise.resolve({ status: "reviewable" as const, session: sessionA });
      });
      const run = runner([note("Review repo A first")], [sessionA], "repo-a");
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        run,
        waitForSession,
      );
      const delivery = vi.fn(acceptedDelivery);
      gate.onLateSubmission(delivery);
      gate.addEvidence({
        mutation: true,
        targets: [repoA, repoB],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await gate.presentAutomatic(ctx);
      if (hide) coordinator.transition("hidden");
      const nextResult = gate.next(ctx);
      await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
      const opensWhileProbePending = coordinator.ensureOpen.mock.calls.length;
      finishProbe({ status: "reviewable", session: sessionA });

      await expect(nextResult).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: repoB,
      });
      expect(opensWhileProbePending).toBe(1);
      expect(run).toHaveBeenCalled();
      expect(delivery).toHaveBeenCalledWith(
        [expect.objectContaining({ summary: "Review repo A first" })],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures newer comments before /hunk next replaces a review after delivery failure", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-async-next-retry-")));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const sessionA = session({ sessionId: "repo-a", cwd: repoA, repoRoot: repoA });
      const sessionB = session({ sessionId: "repo-b", cwd: repoB, repoRoot: repoB });
      const waitForSession = vi.fn(async (options: { cwd: string }) => ({
        status: "reviewable" as const,
        session: options.cwd === repoB ? sessionB : sessionA,
      }));
      let comments: unknown[] = [note("First", { noteId: "user:1" })];
      const run = runner(() => comments, [sessionA], "repo-a");
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        run,
        waitForSession,
      );
      const delivery = vi.fn(async (_notes: HunkReviewNote[]) => {
        if (delivery.mock.calls.length === 1) throw new Error("Pi is busy");
        return { status: "accepted" as const };
      });
      gate.onLateSubmission(delivery);
      gate.addEvidence({
        mutation: true,
        targets: [repoA, repoB],
        unresolved: false,
        revision: 1,
      });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await gate.presentAutomatic(ctx);
      coordinator.transition("hidden");
      await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));

      comments = [...comments, note("Second", { noteId: "user:2", newRange: [10, 10] })];
      coordinator.transition("visible");
      await expect(gate.next(ctx)).resolves.toMatchObject({
        status: "reviewable",
        repoRoot: repoB,
      });

      expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
      expect(delivery).toHaveBeenCalledTimes(3);
      expect(delivery.mock.calls[1]?.[0]).toEqual([
        expect.objectContaining({ noteId: "user:1", summary: "First" }),
      ]);
      expect(delivery.mock.calls[2]?.[0]).toEqual([
        expect.objectContaining({ noteId: "user:2", summary: "Second" }),
      ]);
      expect(delivery.mock.invocationCallOrder[2]).toBeLessThan(
        coordinator.ensureOpen.mock.invocationCallOrder[1]!,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unresolved coverage while opening a known repository", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-mixed-evidence-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const managedSession = session({ cwd: root, repoRoot: root });
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        runner([], [managedSession]),
        vi.fn(async () => ({ status: "reviewable" as const, session: managedSession })),
      );
      gate.addEvidence({ mutation: true, targets: [root], unresolved: true, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: root,
        fileCount: 1,
        routing: "opened",
        unresolved: true,
      });
      await expect(gate.next(ctx)).resolves.toEqual({ status: "target-required" });
      expect(coordinator.ensureOpen).toHaveBeenCalledOnce();
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

  it("keeps a live empty watch open instead of caching terminal no-diff", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-hunk-stale-empty-watch-")));
    try {
      const coordinator = new FakeCoordinator();
      coordinator.pid = 101;
      const emptySession = session({
        cwd: root,
        repoRoot: root,
        fileCount: 0,
        files: [],
      });
      const filledSession = session({
        cwd: root,
        repoRoot: root,
        fileCount: 1,
        files: [{ path: "src/a.ts" }],
      });
      // Match the bug through the production waiter: the managed registration
      // stays empty for the entire first window, then reloads before the next check.
      let lookup = 0;
      const frames = Array.from({ length: 7 }, () => [emptySession]).concat([[filledSession]]);
      const run = runner([], () => frames[Math.min(lookup++, frames.length - 1)]!);
      const waitForSession = vi.fn((options: Parameters<typeof waitForManagedHunkSession>[0]) =>
        waitForManagedHunkSession({
          ...options,
          retryDelaysMs: [0, 0, 0, 0, 0, 0, 0],
        }),
      );
      const gate = new ReviewHandoffGate(
        coordinator as unknown as ReviewCoordinator,
        () => DEFAULT_CONFIG,
        run,
        waitForSession,
      );
      gate.addEvidence({ mutation: true, targets: [root], unresolved: false, revision: 1 });
      const ctx = { cwd: root, mode: "tui" } as ExtensionContext;

      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: root,
        fileCount: 0,
        routing: "opened",
      });
      expect(coordinator.state).toBe("visible");
      expect(coordinator.markReviewCompleteForRun).not.toHaveBeenCalled();

      // A later observation must still be able to publish the delayed reload.
      await expect(gate.presentAutomatic(ctx)).resolves.toEqual({
        status: "reviewable",
        repoRoot: root,
        fileCount: 1,
        routing: "reused",
      });
      expect(waitForSession).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(8);
      expect(coordinator.markReviewCompleteForRun).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
