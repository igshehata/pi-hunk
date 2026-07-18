import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/config.ts";
import type { ReviewCoordinator } from "../extensions/coordinator.ts";
import { parseLiveHunkSessions } from "../extensions/hunk-session.ts";
import {
  readHunkReview,
  registerHunkReviewTool,
  ReviewHandoffGate,
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
  blocking = false;
  stateListeners = new Set<() => void>();
  cancelListeners = new Set<(reason: string) => void>();
  ensureOpen = vi.fn(async () => {
    this.state = "visible";
    this.emit();
  });
  enterReviewGate() {
    return this.ensureOpen();
  }
  getActiveInfo() {
    return this.state === "closed" ? null : { state: this.state, argsKey: "[]", pid: this.pid };
  }
  onStateChange(fn: () => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  onReviewCancellation(fn: (reason: string) => void) {
    this.cancelListeners.add(fn);
    return () => this.cancelListeners.delete(fn);
  }
  setBlockingReview(value: boolean) {
    this.blocking = value;
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
  cancel(reason: string) {
    for (const fn of this.cancelListeners) fn(reason);
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
  coordinator.pid = options.pid;
  const run = runner(comments, options.sessions, options.expectedSessionId);
  const gate = new ReviewHandoffGate(
    coordinator as unknown as ReviewCoordinator,
    () => DEFAULT_CONFIG,
    run,
  );
  const ctx = { cwd: "/repo", mode: "tui" } as ExtensionContext;
  return { coordinator, run, gate, ctx };
}

async function submitOnce(
  gate: ReviewHandoffGate,
  coordinator: FakeCoordinator,
  ctx: ExtensionContext,
) {
  const pending = gate.wait(ctx);
  await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
  coordinator.transition("hidden");
  return pending;
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
  });
});

describe("blocking hunk_review gate", () => {
  it("returns unavailable outside TUI without opening a surface", async () => {
    const { gate, coordinator } = setup([]);
    await expect(
      gate.wait({ cwd: "/repo", mode: "rpc" } as ExtensionContext),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "not-tui",
    });
    expect(coordinator.ensureOpen).not.toHaveBeenCalled();
    expect(coordinator.blocking).toBe(false);
  });

  it("ensures the configured surface and submits existing unseen notes on one visible→hidden edge", async () => {
    const { gate, coordinator, ctx, run } = setup([note()]);
    const pending = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    expect(coordinator.blocking).toBe(true);
    coordinator.transition("hidden", true); // overlay may duplicate state notifications
    await expect(pending).resolves.toMatchObject({
      status: "submitted",
      notes: [{ noteId: "user:1", summary: "Fix this" }],
    });
    expect(run).toHaveBeenCalledTimes(2); // one list + one comment probe, exactly once
    expect(coordinator.state).toBe("hidden");
    expect(coordinator.blocking).toBe(false);
    expect(coordinator.stateListeners.size).toBe(0);
  });

  it("keeps waiting while a live review is replaced through closing and closed states", async () => {
    const { gate, coordinator, ctx } = setup([note()]);
    let settled = false;
    const pending = gate.wait(ctx).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));

    coordinator.transition("closing");
    coordinator.transition("closed");
    coordinator.transition("starting");
    coordinator.transition("visible");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.blocking).toBe(true);

    coordinator.transition("hidden");
    await expect(pending).resolves.toMatchObject({ status: "submitted" });
  });

  it("ignores pre-live starting and transient close while ensureOpen restarts the managed surface", async () => {
    const { gate, coordinator, ctx } = setup([note()]);
    let releaseRestart!: () => void;
    coordinator.ensureOpen = vi.fn(async () => {
      coordinator.transition("starting");
      coordinator.transition("closed");
      await new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      coordinator.transition("visible");
    });
    let settled = false;
    const pending = gate.wait(ctx).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(releaseRestart).toBeTypeOf("function"));
    expect(settled).toBe(false);
    expect(coordinator.blocking).toBe(true);
    releaseRestart();
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    coordinator.transition("hidden");
    await expect(pending).resolves.toMatchObject({ status: "submitted" });
  });

  it.each(["closed", "starting"] as const)(
    "cancels if ensureOpen resolves in non-live state %s",
    async (state) => {
      const { gate, coordinator, ctx } = setup([]);
      coordinator.ensureOpen = vi.fn(async () => {
        coordinator.transition(state);
      });
      await expect(gate.wait(ctx)).resolves.toMatchObject({
        status: "cancelled",
        reason: "hunk-closed",
      });
      expect(coordinator.blocking).toBe(false);
    },
  );

  it("cancels promptly on explicit closing during startup", async () => {
    const { gate, coordinator, ctx } = setup([]);
    coordinator.ensureOpen = vi.fn(() => new Promise<void>(() => {}));
    const pending = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.ensureOpen).toHaveBeenCalled());
    coordinator.transition("closing");
    await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: "hunk-closed" });
  });

  it("turns ensureOpen rejection into prompt cancellation", async () => {
    const { gate, coordinator, ctx } = setup([]);
    coordinator.ensureOpen = vi.fn(async () => {
      throw new Error("open exploded");
    });
    await expect(gate.wait(ctx)).resolves.toMatchObject({
      status: "cancelled",
      reason: "open-failed",
      message: expect.stringContaining("open exploded"),
    });
    expect(coordinator.stateListeners.size).toBe(0);
  });

  it("passes the managed surface PID through to select the exact Hunk session", async () => {
    const sessions = [
      session({ sessionId: "managed", pid: 4242, launchedAt: "2026-01-01T00:00:00.000Z" }),
      session({ sessionId: "newer", pid: 5252, launchedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const { gate, coordinator, ctx, run } = setup([note()], {
      sessions,
      expectedSessionId: "managed",
      pid: 4242,
    });
    const pending = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    coordinator.transition("hidden");
    await expect(pending).resolves.toMatchObject({ status: "submitted" });
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

  it("returns approved on an empty first hide", async () => {
    const { gate, coordinator, ctx, run } = setup([]);
    const pending = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    coordinator.transition("hidden", true);
    await expect(pending).resolves.toMatchObject({ status: "approved", notes: [] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(coordinator.blocking).toBe(false);
    expect(coordinator.markReviewCompleteForRun).toHaveBeenCalledOnce();
  });

  it("returns approved on a second wait when notes are unchanged", async () => {
    const comments = [note()];
    const { gate, coordinator, ctx, run } = setup(comments);

    await expect(await submitOnce(gate, coordinator, ctx)).toMatchObject({ status: "submitted" });
    await expect(await submitOnce(gate, coordinator, ctx)).toMatchObject({
      status: "approved",
      notes: [],
    });
    expect(run.mock.calls.filter(([argv]) => argv.includes("comment"))).toHaveLength(2);
  });

  it("submits a newly created note after a prior submission", async () => {
    let comments: unknown[] = [note("First note", { noteId: "user:1" })];
    const { gate, coordinator, ctx } = setup(() => comments);

    await expect(await submitOnce(gate, coordinator, ctx)).toMatchObject({
      status: "submitted",
      notes: [{ noteId: "user:1" }],
    });

    comments = [
      note("First note", { noteId: "user:1" }),
      note("Fresh at submit", { noteId: "user:2", oldRange: [10, 10], newRange: [11, 12] }),
    ];
    await expect(await submitOnce(gate, coordinator, ctx)).toMatchObject({
      status: "submitted",
      notes: [{ noteId: "user:2", summary: "Fresh at submit", newRange: [11, 12] }],
    });
  });

  it("returns already-waiting for a duplicate call", async () => {
    const { gate, coordinator, ctx } = setup([]);
    const first = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    await expect(gate.wait(ctx)).resolves.toMatchObject({ status: "already-waiting" });
    coordinator.cancel("close");
    await expect(first).resolves.toMatchObject({ status: "cancelled", reason: "close" });
  });

  it.each(["close", "force-replacement", "session-boundary", "hunk-died"])(
    "cancels and cleans listeners on %s",
    async (reason) => {
      const { gate, coordinator, ctx } = setup([]);
      const pending = gate.wait(ctx);
      await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
      coordinator.cancel(reason);
      await expect(pending).resolves.toMatchObject({ status: "cancelled", reason });
      expect(coordinator.blocking).toBe(false);
      expect(coordinator.stateListeners.size).toBe(0);
    },
  );

  it("settles AbortSignal promptly even while surface startup is still blocked", async () => {
    const { gate, coordinator, ctx } = setup([]);
    let finishOpen!: () => void;
    coordinator.ensureOpen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = gate.wait(ctx, controller.signal);
    await vi.waitFor(() => expect(coordinator.ensureOpen).toHaveBeenCalled());
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: "abort-signal" });
    expect(coordinator.stateListeners.size).toBe(0);
    finishOpen();
    await Promise.resolve();
    expect(coordinator.stateListeners.size).toBe(0);
  });

  it("turns a comment probe failure into cancellation with full cleanup", async () => {
    const { gate, coordinator, ctx, run } = setup([]);
    run.mockRejectedValueOnce(new Error("probe exploded"));
    const pending = gate.wait(ctx);
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    coordinator.transition("hidden");
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      reason: "comment-probe-failed",
    });
    expect(coordinator.blocking).toBe(false);
    expect(coordinator.stateListeners.size).toBe(0);
  });

  it("cancels on Hunk natural death and AbortSignal", async () => {
    const a = setup([]);
    const death = a.gate.wait(a.ctx);
    await vi.waitFor(() => expect(a.coordinator.state).toBe("visible"));
    a.coordinator.transition("closed");
    await expect(death).resolves.toMatchObject({ status: "cancelled", reason: "hunk-closed" });

    const b = setup([]);
    const controller = new AbortController();
    const aborted = b.gate.wait(b.ctx, controller.signal);
    await vi.waitFor(() => expect(b.coordinator.state).toBe("visible"));
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ status: "cancelled", reason: "abort-signal" });
    expect(b.coordinator.stateListeners.size).toBe(0);
  });

  it("registers an actually blocking read-only tool", async () => {
    const { gate, coordinator } = setup([note()]);
    let tool: any;
    registerHunkReviewTool(
      {
        registerTool: (value: unknown) => {
          tool = value;
        },
      } as unknown as ExtensionAPI,
      gate,
    );
    expect(tool.description).toContain("Read-only");
    expect(tool.promptGuidelines.join("\n")).toContain("status=approved");
    const result = tool.execute("call", {}, undefined, undefined, { cwd: "/repo", mode: "tui" });
    await vi.waitFor(() => expect(coordinator.state).toBe("visible"));
    coordinator.transition("hidden");
    await expect(result).resolves.toMatchObject({ details: { status: "submitted" } });
  });

  it("registered tool returns unavailable immediately outside TUI", async () => {
    const { gate, coordinator } = setup([]);
    let tool: any;
    registerHunkReviewTool(
      {
        registerTool: (value: unknown) => {
          tool = value;
        },
      } as unknown as ExtensionAPI,
      gate,
    );

    await expect(
      tool.execute("call", {}, undefined, undefined, { cwd: "/repo", mode: "print" }),
    ).resolves.toMatchObject({ details: { status: "unavailable", reason: "not-tui" } });
    expect(coordinator.ensureOpen).not.toHaveBeenCalled();
  });
});
