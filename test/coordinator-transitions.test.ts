import { describe, expect, it, vi } from "vitest";
import { ReviewCoordinator } from "../extensions/coordinator.ts";
import { cloneConfig, DEFAULT_CONFIG } from "../extensions/config.ts";
import type { OverlaySurface } from "../extensions/overlay/surface.ts";

function fakeOverlay(): OverlaySurface & { calls: string[] } {
  let state: "closed" | "visible" | "hidden" = "closed";
  let listener: (() => void) | undefined;
  const calls: string[] = [];

  return {
    calls,
    setStateListener(next: () => void) {
      listener = next;
    },
    getState: () => state,
    isLive: () => state !== "closed",
    getInfo: () => (state === "closed" ? null : { state, argsKey: "[]", pid: 4242 }),
    async ensure() {
      calls.push("ensure:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = "visible";
      calls.push("ensure:end");
      listener?.();
    },
    async show() {
      calls.push("show");
      state = "visible";
      listener?.();
    },
    async toggle() {
      calls.push("toggle");
      state = state === "visible" ? "hidden" : "visible";
      listener?.();
    },
    async release() {
      calls.push("release");
      state = "closed";
      return true;
    },
    async close() {
      state = "closed";
    },
  } as unknown as OverlaySurface & { calls: string[] };
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

  it("enters the review gate without replacing an existing manual review", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const config = cloneConfig(DEFAULT_CONFIG);

    await coordinator.ensureOpen(ctx, config, ["show", "HEAD~1"], "manual");
    overlay.calls.length = 0;
    await coordinator.enterReviewGate(ctx, config);

    expect(overlay.calls).toEqual(["show"]);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");
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

  it("notifies cancellation listeners on close", async () => {
    const overlay = fakeOverlay();
    const coordinator = new ReviewCoordinator({ overlay });
    const cancellation = vi.fn();
    coordinator.onReviewCancellation(cancellation);
    const config = cloneConfig(DEFAULT_CONFIG);

    await coordinator.ensureOpen(ctx, config, [], "manual");
    await coordinator.closeActive();

    expect(cancellation).toHaveBeenCalledWith("close");
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
});
