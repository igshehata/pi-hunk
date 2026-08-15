import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewCoordinator } from "../extensions/coordinator.ts";
import { cloneConfig, DEFAULT_CONFIG } from "../extensions/config.ts";
import type { OverlaySurface } from "../extensions/overlay/surface.ts";

interface FakeOverlay extends OverlaySurface {
  calls: string[];
  requestCwds: string[];
  simulateChildExit(result?: { exitCode: number; signal?: number }): Promise<void>;
}

function fakeOverlay(options: { nextPid?: () => number } = {}): FakeOverlay {
  let state: "closed" | "visible" | "hidden" = "closed";
  let listener: (() => void) | undefined;
  let childExitListener:
    | ((result: { exitCode: number; signal?: number }) => Promise<void> | void)
    | undefined;
  let replacementGuard: (() => Promise<void>) | undefined;
  let launchCwd = "/repo";
  let sessionId: string | undefined;
  let repoRoot: string | undefined;
  let pid = 4242;
  let argsKey = "[]";
  const calls: string[] = [];
  const requestCwds: string[] = [];
  let pidSequence = 4242;

  return {
    calls,
    requestCwds,
    setStateListener(next: () => void) {
      listener = next;
    },
    setChildExitListener(
      next: (result: { exitCode: number; signal?: number }) => Promise<void> | void,
    ) {
      childExitListener = next;
    },
    setReplacementGuard(next: () => Promise<void>) {
      replacementGuard = next;
    },
    getState: () => state,
    isLive: () => state !== "closed",
    getInfo: () =>
      state === "closed"
        ? null
        : {
            state,
            argsKey,
            launchCwd,
            source: "manual",
            pid,
            sessionId,
            repoRoot,
          },
    async ensure(_ctx: unknown, request: { cwd: string; command?: string; args?: string[] }) {
      calls.push("ensure:start");
      requestCwds.push(request.cwd);
      const nextArgsKey = JSON.stringify([
        request.cwd,
        request.command ?? "hunk",
        ...(request.args ?? []),
      ]);
      const replaces = state === "closed" || nextArgsKey !== argsKey;
      if (state !== "closed" && replaces) await replacementGuard?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      launchCwd = request.cwd;
      argsKey = nextArgsKey;
      if (replaces) {
        pid = options.nextPid?.() ?? pidSequence++;
        sessionId = undefined;
        repoRoot = undefined;
      }
      state = "visible";
      calls.push("ensure:end");
      listener?.();
    },
    adoptManagedSession(session: { sessionId: string; repoRoot?: string; pid?: number }) {
      sessionId = session.sessionId;
      repoRoot = session.repoRoot;
      if (session.pid !== undefined) pid = session.pid;
      return true;
    },
    async show() {
      calls.push("show");
      state = "visible";
      listener?.();
    },
    async toggle(_ctx: unknown, request: { cwd: string; command?: string; args?: string[] }) {
      calls.push("toggle");
      requestCwds.push(request.cwd);
      const nextArgsKey = JSON.stringify([
        request.cwd,
        request.command ?? "hunk",
        ...(request.args ?? []),
      ]);
      if (state === "closed" || nextArgsKey !== argsKey) {
        if (state !== "closed") await replacementGuard?.();
        launchCwd = request.cwd;
        argsKey = nextArgsKey;
        pid = options.nextPid?.() ?? pidSequence++;
        sessionId = undefined;
        repoRoot = undefined;
        state = "visible";
      } else {
        state = state === "visible" ? "hidden" : "visible";
      }
      listener?.();
    },
    async release() {
      calls.push("release");
      state = "closed";
      sessionId = undefined;
      repoRoot = undefined;
      return true;
    },
    async close() {
      calls.push("close");
      state = "closed";
      sessionId = undefined;
      repoRoot = undefined;
      listener?.();
    },
    /** Test helper: simulate natural child exit. */
    async simulateChildExit(result: { exitCode: number; signal?: number } = { exitCode: 0 }) {
      // Surface reports the result before owned removal, then publishes closed.
      await childExitListener?.(result);
      state = "closed";
      sessionId = undefined;
      repoRoot = undefined;
      listener?.();
    },
  } as unknown as FakeOverlay;
}

const ctx = { cwd: "/repo", mode: "tui", ui: {} } as any;

describe("ReviewCoordinator overlay lifecycle", () => {
  it("serializes concurrent transitions and preserves the PTY while toggling", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);

    const open = coordinator.ensureOpen(ctx, config, config.hunk.args, "manual");
    const toggle = coordinator.toggleOverlay(ctx, config, config.hunk.args);
    await Promise.all([open, toggle]);

    expect(overlay.calls).toEqual(["ensure:start", "ensure:end", "toggle"]);
    expect(coordinator.getActiveInfo()?.state).toBe("hidden");
    expect(coordinator.hasLiveSurface()).toBe(true);
  });

  it("holds the exact surface behind the destructive guard before close", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.ensureOpen(ctx, config, config.hunk.args, "manual");

    let release!: () => void;
    const guard = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    coordinator.setDestructiveTransitionGuard(guard);

    const closing = coordinator.closeActive();
    await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
    expect(guard).toHaveBeenCalledWith(
      "close",
      expect.objectContaining({ pid: 4242, state: "visible" }),
    );
    expect(coordinator.getActiveInfo()?.pid).toBe(4242);
    expect(overlay.calls).not.toContain("release");

    release();
    await expect(closing).resolves.toBe(true);
    expect(coordinator.getActiveInfo()).toBeNull();
  });

  it("blocks direct diff-to-show replacement when the exact-session guard fails", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.ensureOpen(ctx, config, config.hunk.args, "manual");
    const original = coordinator.getActiveInfo();
    coordinator.setDestructiveTransitionGuard(
      vi.fn(async () => {
        throw new Error("comment probe failed");
      }),
    );

    await expect(coordinator.ensureOpen(ctx, config, ["show"], "manual")).rejects.toThrow(
      "comment probe failed",
    );
    expect(coordinator.getActiveInfo()).toEqual(original);
    expect(overlay.calls.filter((call) => call === "ensure:start")).toHaveLength(2);
    expect(overlay.calls.filter((call) => call === "ensure:end")).toHaveLength(1);
  });

  it("waits for the best-effort natural-exit guard before dropping ownership", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.ensureOpen(ctx, config, [], "manual");

    let release!: () => void;
    const guard = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    coordinator.setDestructiveTransitionGuard(guard);
    const exited = overlay.simulateChildExit({ exitCode: 0 });

    await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
    expect(guard).toHaveBeenCalledWith("natural-exit", expect.objectContaining({ pid: 4242 }));
    expect(coordinator.getActiveInfo()?.pid).toBe(4242);

    release();
    await exited;
    expect(coordinator.getActiveInfo()).toBeNull();
  });

  it("keeps a routed repository cwd when Pi toggles the active review", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    const repoACtx = { ...ctx, cwd: "/repo-a" };

    await coordinator.ensureOpen(repoACtx, config, config.hunk.args, "auto", "/repo-b");
    overlay.requestCwds.length = 0;

    await coordinator.toggleOverlay(repoACtx, config, config.hunk.args);
    expect(coordinator.getActiveInfo()).toMatchObject({
      state: "hidden",
      launchCwd: "/repo-b",
    });

    await coordinator.toggleOverlay(repoACtx, config, config.hunk.args);
    expect(coordinator.getActiveInfo()).toMatchObject({
      state: "visible",
      launchCwd: "/repo-b",
    });
    expect(overlay.requestCwds).toEqual(["/repo-b", "/repo-b"]);
  });

  it("keeps a routed repository cwd when a shortcut switches review arguments", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    const repoACtx = { ...ctx, cwd: "/repo-a" };

    await coordinator.ensureOpen(repoACtx, config, config.hunk.args, "auto", "/repo-b");
    overlay.requestCwds.length = 0;
    await coordinator.ensureOpen(repoACtx, config, ["show"], "shortcut");

    expect(overlay.requestCwds).toEqual(["/repo-b"]);
    expect(coordinator.getActiveInfo()?.launchCwd).toBe("/repo-b");
  });

  it("recovers after a rejected queued transition", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);

    await coordinator.shutdown();
    await expect(coordinator.ensureOpen(ctx, config, [], "manual")).rejects.toThrow("shut down");
    await coordinator.activateSession();
    await coordinator.ensureOpen(ctx, config, [], "manual");

    expect(coordinator.hasLiveSurface()).toBe(true);
  });

  it("drops ownership only after natural close and cannot adopt the exited process", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.ensureOpen(ctx, config, [], "manual");

    await overlay.simulateChildExit({ exitCode: 0 });

    expect(coordinator.getActiveInfo()).toBeNull();
    expect(coordinator.hasLiveSurface()).toBe(false);
    expect(
      coordinator.adoptManagedSession({
        sessionId: "stale",
        pid: 4242,
        cwd: "/repo",
        launchedAt: "2026-01-01T00:00:00.000Z",
        fileCount: 0,
        files: [],
      }),
    ).toBe(false);
  });

  it("revive serially closes a live surface before clearing ownership", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.ensureOpen(ctx, config, [], "manual");

    const close = overlay.close;
    overlay.close = async () => {
      throw new Error("close interrupted");
    };
    await expect(coordinator.revive()).rejects.toThrow("close interrupted");
    expect(coordinator.hasLiveSurface()).toBe(true);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");

    overlay.close = close;
    await coordinator.revive();

    expect(overlay.calls.at(-1)).toBe("close");
    expect(coordinator.getActiveInfo()).toBeNull();
    expect(coordinator.hasLiveSurface()).toBe(false);
    await coordinator.ensureOpen(ctx, config, [], "manual");
    expect(coordinator.hasLiveSurface()).toBe(true);
  });

  it("passes the managed PID and reports one final follow-edit failure", async () => {
    const overlay = fakeOverlay();
    const navigateHunk = vi.fn(async () => {
      throw new Error("ambiguous managed session");
    });
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const notify = vi.fn();
    const followCtx = { ...ctx, ui: { notify } } as any;
    await coordinator.ensureOpen(followCtx, config, [], "manual");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/a.ts");
      await vi.advanceTimersByTimeAsync(750);
      await Promise.resolve();

      expect(navigateHunk).toHaveBeenCalledTimes(2);
      expect(navigateHunk).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo",
          filePath: "src/a.ts",
          managedPid: 4242,
        }),
      );
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("ambiguous managed session"),
        "warning",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the adopted Hunk repo root and exact session for follow-edit navigation", async () => {
    const overlay = fakeOverlay();
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;
    await coordinator.ensureOpen(followCtx, config, [], "manual", "/repo-b/packages/app");
    coordinator.adoptManagedSession({
      sessionId: "repo-b-session",
      pid: 4242,
      cwd: "/repo-b/packages/app",
      repoRoot: "/repo-b",
      launchedAt: "2026-01-01T00:00:00.000Z",
      fileCount: 1,
      files: [{ path: "packages/app/src/a.ts" }],
    });

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "/repo-b/packages/app/src/a.ts");
      await vi.advanceTimersByTimeAsync(350);

      expect(navigateHunk).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo-b",
          filePath: "/repo-b/packages/app/src/a.ts",
          sessionId: "repo-b-session",
          managedPid: 4242,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform !== "win32")(
    "selects the first canonically covered target for the active managed session",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-follow-candidates-"));
      const repo = join(root, "repo");
      const linkedRepo = join(root, "linked-repo");
      const outside = join(root, "outside.ts");
      await mkdir(join(repo, "src"), { recursive: true });
      await symlink(repo, linkedRepo);

      const overlay = fakeOverlay();
      const navigateHunk = vi.fn(async () => undefined);
      const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
      const config = cloneConfig(DEFAULT_CONFIG);
      const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

      try {
        await coordinator.ensureOpen(followCtx, config, [], "manual", repo);
        coordinator.adoptManagedSession({
          sessionId: "managed-repo",
          pid: 4242,
          cwd: repo,
          repoRoot: repo,
          launchedAt: "2026-01-01T00:00:00.000Z",
          fileCount: 1,
          files: [{ path: "src/inside.ts" }],
        });

        vi.useFakeTimers();
        try {
          await coordinator.scheduleFollowEditCandidates(followCtx, config, [
            outside,
            join(linkedRepo, "src", "inside.ts"),
          ]);

          await vi.advanceTimersByTimeAsync(350);
          expect(navigateHunk).toHaveBeenCalledOnce();
          expect(navigateHunk).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: repo,
              filePath: join(linkedRepo, "src", "inside.ts"),
              sessionId: "managed-repo",
              managedPid: 4242,
            }),
          );
          expect(followCtx.ui.notify).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      } finally {
        await coordinator.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not report a detached follow-edit failure after session shutdown", async () => {
    const overlay = fakeOverlay();
    let rejectRetry: ((error: Error) => void) | undefined;
    const navigateHunk = vi
      .fn()
      .mockRejectedValueOnce(new Error("session not ready"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRetry = reject;
          }),
      );
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const notify = vi.fn();
    const followCtx = { ...ctx, ui: { notify } } as any;
    await coordinator.ensureOpen(followCtx, config, [], "manual");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/a.ts");
      await vi.advanceTimersByTimeAsync(750);
      expect(navigateHunk).toHaveBeenCalledTimes(2);

      await coordinator.shutdown();
      rejectRetry?.(new Error("old session disappeared"));
      await vi.advanceTimersByTimeAsync(0);

      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes follow-edit navigation so an older slow request cannot win", async () => {
    const overlay = fakeOverlay();
    const completionOrder: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const navigateHunk = vi.fn(({ filePath }: { filePath: string }) => {
      if (filePath === "src/first.ts") {
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            completionOrder.push(filePath);
            resolve();
          };
        });
      }
      completionOrder.push(filePath);
      return Promise.resolve();
    });
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;
    await coordinator.ensureOpen(followCtx, config, [], "manual");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/first.ts");
      await vi.advanceTimersByTimeAsync(350);
      expect(navigateHunk).toHaveBeenCalledTimes(1);

      coordinator.scheduleFollowEdit(followCtx, config, "src/latest.ts");
      await vi.advanceTimersByTimeAsync(350);

      // The latest request is ready, but must wait for the in-flight request so
      // it is guaranteed to be the final navigation applied to Hunk.
      expect(navigateHunk).toHaveBeenCalledTimes(1);
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(navigateHunk.mock.calls.map(([options]) => options.filePath)).toEqual([
        "src/first.ts",
        "src/latest.ts",
      ]);
      expect(completionOrder).toEqual(["src/first.ts", "src/latest.ts"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not navigate a replacement surface scheduled before the debounce fires", async () => {
    let nextPid = 1000;
    const overlay = fakeOverlay({ nextPid: () => ++nextPid });
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    await coordinator.ensureOpen(followCtx, config, [], "manual", "/repo-a");
    const processA = coordinator.getActiveInfo();
    expect(processA?.pid).toBe(1001);

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/from-a.ts");

      // Replace A with B before the 150 ms debounce completes. Lifecycle
      // operations use short real delays, so advance only enough for them.
      const closePromise = coordinator.closeActive();
      await vi.advanceTimersByTimeAsync(0);
      await closePromise;

      const openB = coordinator.ensureOpen(followCtx, config, ["show"], "manual", "/repo-b");
      await vi.advanceTimersByTimeAsync(20);
      await openB;
      const processB = coordinator.getActiveInfo();
      expect(processB?.pid).toBe(1002);
      expect(processB?.launchCwd).toBe("/repo-b");

      await vi.advanceTimersByTimeAsync(750);
      await Promise.resolve();

      expect(navigateHunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending follow-edit when ensureOpen replaces the live surface", async () => {
    let nextPid = 2000;
    const overlay = fakeOverlay({ nextPid: () => ++nextPid });
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    await coordinator.ensureOpen(followCtx, config, [], "auto", "/repo-a");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/from-a.ts");

      // Direct replacement without an intermediate closeActive path.
      const openB = coordinator.ensureOpen(followCtx, config, ["show"], "manual", "/repo-b");
      await vi.advanceTimersByTimeAsync(20);
      await openB;
      expect(coordinator.getActiveInfo()?.pid).toBe(2002);

      await vi.advanceTimersByTimeAsync(750);
      await Promise.resolve();

      expect(navigateHunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pending follow-edit when ensureOpen preserves the same surface", async () => {
    let nextPid = 3000;
    const overlay = fakeOverlay({ nextPid: () => ++nextPid });
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    await coordinator.ensureOpen(followCtx, config, config.hunk.args, "manual", "/repo-a");
    expect(coordinator.getActiveInfo()?.pid).toBe(3001);

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/from-a.ts");
      const sameOpen = coordinator.ensureOpen(
        followCtx,
        config,
        config.hunk.args,
        "auto",
        "/repo-a",
      );
      await vi.advanceTimersByTimeAsync(20);
      await sameOpen;
      expect(coordinator.getActiveInfo()?.pid).toBe(3001);

      await vi.advanceTimersByTimeAsync(350);
      expect(navigateHunk).toHaveBeenCalledOnce();
      expect(navigateHunk).toHaveBeenCalledWith(
        expect.objectContaining({ managedPid: 3001, filePath: "src/from-a.ts" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending follow-edit when toggleOverlay replaces the surface", async () => {
    let nextPid = 4000;
    const overlay = fakeOverlay({ nextPid: () => ++nextPid });
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    await coordinator.ensureOpen(followCtx, config, config.hunk.args, "manual", "/repo-a");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/from-a.ts");
      await coordinator.toggleOverlay(followCtx, config, ["show"], "shortcut");
      expect(coordinator.getActiveInfo()?.pid).toBe(4002);

      await vi.advanceTimersByTimeAsync(750);
      expect(navigateHunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bind an early-open follow-edit to a later toggle replacement", async () => {
    let nextPid = 5000;
    const overlay = fakeOverlay({ nextPid: () => ++nextPid });
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    vi.useFakeTimers();
    try {
      const earlyOpen = coordinator.ensureOpen(
        followCtx,
        config,
        config.hunk.args,
        "live",
        "/repo-a",
      );
      coordinator.setEarlyOpenPromise(earlyOpen);
      coordinator.scheduleFollowEdit(followCtx, config, "src/from-a.ts");

      await vi.advanceTimersByTimeAsync(20);
      await earlyOpen;
      coordinator.setEarlyOpenPromise(null);
      expect(coordinator.getActiveInfo()?.pid).toBe(5001);

      await coordinator.toggleOverlay(followCtx, config, ["show"], "shortcut");
      expect(coordinator.getActiveInfo()?.pid).toBe(5002);
      await vi.advanceTimersByTimeAsync(750);

      expect(navigateHunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending follow-edit on routing release and natural child exit", async () => {
    const overlay = fakeOverlay();
    const navigateHunk = vi.fn(async () => undefined);
    const coordinator = new ReviewCoordinator({ overlay, navigateHunk });
    const config = cloneConfig(DEFAULT_CONFIG);
    const followCtx = { ...ctx, ui: { notify: vi.fn() } } as any;

    await coordinator.ensureOpen(followCtx, config, [], "manual");

    vi.useFakeTimers();
    try {
      coordinator.scheduleFollowEdit(followCtx, config, "src/release.ts");
      await coordinator.releaseSurfaceForRouting();
      await vi.advanceTimersByTimeAsync(750);
      expect(navigateHunk).not.toHaveBeenCalled();

      const reopen = coordinator.ensureOpen(followCtx, config, [], "manual");
      await vi.advanceTimersByTimeAsync(20);
      await reopen;
      coordinator.scheduleFollowEdit(followCtx, config, "src/exit.ts");
      await overlay.simulateChildExit({ exitCode: 0, signal: 0 });
      await vi.advanceTimersByTimeAsync(750);
      expect(navigateHunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
