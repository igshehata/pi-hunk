import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { AutoOpenSuppressionReason, HunkConfig } from "./config.ts";
import { navigateHunkSession, type LiveHunkSession } from "./hunk-session.ts";
import { canonicalizePotentialPath } from "./path-routing.ts";
import type { HunkExit } from "./overlay/embedded.ts";
import { OverlaySurface } from "./overlay/surface.ts";
import type { LaunchSource, OpenRequest, SurfaceSessionInfo } from "./overlay/types.ts";

export interface CoordinatorDeps {
  overlay?: OverlaySurface;
  navigateHunk?: typeof navigateHunkSession;
}

type CoordinatorLifecyclePhase = "active" | "activating" | "shutting-down" | "shutdown";
type CoordinatorLifecycleRequest = "activate" | "shutdown";
interface CoordinatorLifecycleState {
  phase: CoordinatorLifecyclePhase;
  revision: number;
}

const LIFECYCLE_REQUEST_TRANSITIONS: Record<
  CoordinatorLifecyclePhase,
  Record<CoordinatorLifecycleRequest, CoordinatorLifecyclePhase>
> = {
  active: { activate: "activating", shutdown: "shutting-down" },
  activating: { activate: "activating", shutdown: "shutting-down" },
  "shutting-down": { activate: "activating", shutdown: "shutting-down" },
  shutdown: { activate: "activating", shutdown: "shutting-down" },
};

const LIFECYCLE_REVIVE_TRANSITIONS: Record<CoordinatorLifecyclePhase, CoordinatorLifecyclePhase> = {
  active: "active",
  activating: "active",
  "shutting-down": "shutting-down",
  shutdown: "active",
};

function requestLifecycleTransition(
  state: CoordinatorLifecycleState,
  request: CoordinatorLifecycleRequest,
): CoordinatorLifecycleState {
  return {
    phase: LIFECYCLE_REQUEST_TRANSITIONS[state.phase][request],
    revision: state.revision + 1,
  };
}

type EarlySurfaceState = "none" | "owned" | "adopted";
type EarlySurfaceEvent = "opened" | "adopt" | "release";
const EARLY_SURFACE_TRANSITIONS: Record<
  EarlySurfaceState,
  Record<EarlySurfaceEvent, EarlySurfaceState>
> = {
  none: { opened: "owned", adopt: "none", release: "none" },
  owned: { opened: "owned", adopt: "adopted", release: "none" },
  adopted: { opened: "adopted", adopt: "adopted", release: "none" },
};

type EarlyOpenState = { phase: "none" } | { phase: "pending"; promise: Promise<void> };
interface CoordinatorRunState {
  openAttempt: "available" | "attempted";
  earlyOpen: EarlyOpenState;
  earlySurface: EarlySurfaceState;
  suppression: AutoOpenSuppressionReason | null;
}

function initialRunState(): CoordinatorRunState {
  return {
    openAttempt: "available",
    earlyOpen: { phase: "none" },
    earlySurface: "none",
    suppression: null,
  };
}

type CoordinatorRunEvent =
  | { type: "reset" }
  | { type: "mark-open-attempt" }
  | { type: "set-early-open"; promise: Promise<void> | null }
  | { type: "early-surface"; event: EarlySurfaceEvent }
  | { type: "suppress"; reason: AutoOpenSuppressionReason };

function transitionRunState(
  state: CoordinatorRunState,
  event: CoordinatorRunEvent,
): CoordinatorRunState {
  switch (event.type) {
    case "reset":
      return initialRunState();
    case "mark-open-attempt":
      return { ...state, openAttempt: "attempted" };
    case "set-early-open":
      return {
        ...state,
        earlyOpen: event.promise ? { phase: "pending", promise: event.promise } : { phase: "none" },
      };
    case "early-surface":
      return {
        ...state,
        earlySurface: EARLY_SURFACE_TRANSITIONS[state.earlySurface][event.event],
      };
    case "suppress":
      if (state.suppression === "review-complete" && event.reason !== "review-complete")
        return state;
      return { ...state, suppression: event.reason };
  }
}

/**
 * Owns the single persistent overlay and serializes every lifecycle transition.
 * The small promise queue keeps concurrent lifecycle, command, and shortcut
 * events from opening or disposing two PTYs at once.
 */
export class ReviewCoordinator {
  private readonly overlay: OverlaySurface;
  private readonly navigateHunk: typeof navigateHunkSession;
  private active: OverlaySurface | null = null;
  private transitionQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private followRevision = 0;
  private followNavigationQueue: Promise<void> = Promise.resolve();
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFollowPath: string | undefined;
  private runState = initialRunState();
  private lifecycle: CoordinatorLifecycleState = { phase: "active", revision: 0 };
  private readonly stateListeners = new Set<() => void>();
  private readonly cancellationListeners = new Set<(reason: string) => void>();
  private blockingState: "idle" | "blocking" = "idle";

  constructor(deps: CoordinatorDeps = {}) {
    this.overlay = deps.overlay ?? new OverlaySurface();
    this.navigateHunk = deps.navigateHunk ?? navigateHunkSession;
    this.overlay.setStateListener(() => this.notifyStateChange());
    this.overlay.setChildExitListener?.((result) => this.onChildExit(result));
    this.overlay.setTransitionScheduler?.((operation) => {
      // A focused-component shortcut is an explicit user action; once queued,
      // an early-live surface is no longer disposable as an unused run artifact.
      this.transitionRun({ type: "early-surface", event: "adopt" });
      return this.exclusive(operation);
    });
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private notifyStateChange(): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener();
      } catch {
        // Listener failures must not corrupt overlay state.
      }
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private transitionRun(event: CoordinatorRunEvent): void {
    this.runState = transitionRunState(this.runState, event);
  }

  private requestLifecycle(request: CoordinatorLifecycleRequest): number {
    this.lifecycle = requestLifecycleTransition(this.lifecycle, request);
    return this.lifecycle.revision;
  }

  private completeLifecycle(
    revision: number,
    expected: "activating" | "shutting-down",
    completed: "active" | "shutdown",
  ): void {
    if (revision !== this.lifecycle.revision) return;
    if (this.lifecycle.phase !== expected) {
      throw new Error(
        `Invalid Hunk coordinator lifecycle completion: ${this.lifecycle.phase} -> ${completed}.`,
      );
    }
    this.lifecycle = { phase: completed, revision };
  }

  private isActiveLifecycle(): boolean {
    return this.lifecycle.phase === "active";
  }

  resetRunFlags(): void {
    this.transitionRun({ type: "reset" });
  }

  hasOpenedForRun(): boolean {
    return this.runState.openAttempt === "attempted";
  }

  markOpenedForRun(): void {
    this.transitionRun({ type: "mark-open-attempt" });
  }

  hasEarlySurfaceOpenedForRun(): boolean {
    return this.runState.earlySurface !== "none";
  }

  getAutoOpenSuppressionReason(): AutoOpenSuppressionReason | null {
    return this.runState.suppression;
  }

  markReviewCompleteForRun(): void {
    this.transitionRun({ type: "suppress", reason: "review-complete" });
  }

  suppressAutoOpenForRun(reason: AutoOpenSuppressionReason = "dismissed"): void {
    this.transitionRun({ type: "suppress", reason });
  }

  isBlocking(): boolean {
    return this.blockingState === "blocking";
  }

  setBlockingReview(blocking: boolean): void {
    this.blockingState = blocking ? "blocking" : "idle";
  }

  onReviewCancellation(listener: (reason: string) => void): () => void {
    this.cancellationListeners.add(listener);
    return () => this.cancellationListeners.delete(listener);
  }

  private notifyReviewCancellation(reason: string): void {
    for (const listener of [...this.cancellationListeners]) {
      try {
        listener(reason);
      } catch {
        // Cancellation delivery is best-effort; cleanup still proceeds.
      }
    }
  }

  hasLiveSurface(): boolean {
    return Boolean(this.active?.isLive());
  }

  getActiveInfo(): SurfaceSessionInfo | null {
    return this.active?.getInfo() ?? null;
  }

  getEarlyOpenPromise(): Promise<void> | null {
    return this.runState.earlyOpen.phase === "pending" ? this.runState.earlyOpen.promise : null;
  }

  setEarlyOpenPromise(promise: Promise<void> | null): void {
    this.transitionRun({ type: "set-early-open", promise });
  }

  async ensureOpen(
    ctx: ExtensionContext,
    config: HunkConfig,
    args: string[],
    source: LaunchSource,
    launchCwd: string = ctx.cwd,
  ): Promise<void> {
    await this.exclusive(async () => {
      this.assertAlive();
      const hadLiveSurface = this.overlay.isLive();
      await this.overlay.ensure(ctx, this.buildRequest(config, args, source, launchCwd), config);
      if (!this.overlay.isLive()) {
        if (this.overlay.getState() === "closed") return;
        throw new Error("Hunk overlay did not become live.");
      }
      this.active = this.overlay;
      if (source === "live" && !hadLiveSurface) {
        this.transitionRun({ type: "early-surface", event: "opened" });
      } else if (source !== "live") {
        this.transitionRun({ type: "early-surface", event: "adopt" });
      }
    });
    this.notifyStateChange();
  }

  /** Enter the blocking gate, preserving a live review from the same canonical cwd. */
  async enterReviewGate(
    ctx: ExtensionContext,
    config: HunkConfig,
    launchCwd: string = ctx.cwd,
  ): Promise<void> {
    await this.exclusive(async () => {
      this.assertAlive();
      const activeInfo = this.active?.getInfo();
      if (this.active?.isLive() && activeInfo) {
        const [activeCwd, requestedCwd] = await Promise.all([
          canonicalizePotentialPath(activeInfo.launchCwd),
          canonicalizePotentialPath(launchCwd),
        ]);
        if (activeCwd === requestedCwd) {
          await this.active.show();
          return;
        }
      }
      await this.overlay.ensure(
        ctx,
        this.buildRequest(config, config.hunk.args, "handoff", launchCwd),
        config,
      );
      if (!this.overlay.isLive()) {
        if (this.overlay.getState() === "closed") return;
        throw new Error("Hunk overlay did not become live.");
      }
      this.active = this.overlay;
    });
    this.notifyStateChange();
  }

  adoptManagedSession(session: LiveHunkSession): boolean {
    const adopted = this.active?.adoptManagedSession(session) ?? false;
    if (adopted) this.notifyStateChange();
    return adopted;
  }

  adoptEarlySurfaceForRun(): void {
    this.transitionRun({ type: "early-surface", event: "adopt" });
  }

  isEarlySurfaceOwnedForRun(): boolean {
    return this.runState.earlySurface === "owned";
  }

  async toggleOverlay(
    ctx: ExtensionContext,
    config: HunkConfig,
    args: string[],
    source: LaunchSource = "shortcut",
  ): Promise<void> {
    await this.exclusive(async () => {
      this.assertAlive();
      const request = this.buildRequest(config, args, source, ctx.cwd);
      if (this.active?.isLive()) {
        await this.active.toggle(ctx, request, config);
        this.transitionRun({ type: "early-surface", event: "adopt" });
        return;
      }

      await this.overlay.toggle(ctx, request, config);
      if (!this.overlay.isLive()) {
        if (this.overlay.getState() === "closed") return;
        throw new Error("Hunk overlay did not become live.");
      }
      this.active = this.overlay;
      this.transitionRun({ type: "early-surface", event: "adopt" });
    });
    this.notifyStateChange();
  }

  async closeActive(): Promise<boolean> {
    this.suppressAutoOpenForRun("dismissed");
    this.notifyReviewCancellation("close");
    const closed = await this.exclusive(() => this.closeActiveUnlocked());
    this.notifyStateChange();
    return closed;
  }

  /** Internal queue transition: close without dismissal/cancellation semantics. */
  async releaseSurfaceForRouting(): Promise<boolean> {
    const closed = await this.exclusive(async () => {
      const surface = this.active;
      if (!surface || (!surface.isLive() && surface.getState() === "closed")) {
        this.active = null;
        return false;
      }
      const didClose = await surface.release();
      this.active = null;
      return didClose;
    });
    if (closed) this.notifyStateChange();
    return closed;
  }

  async closeEarlySurfaceOpenedForRun(): Promise<boolean> {
    const closed = await this.exclusive(async () => {
      if (this.runState.earlySurface !== "owned") return false;
      const surface = this.active;
      if (!surface || (!surface.isLive() && surface.getState() === "closed")) {
        this.active = null;
        this.transitionRun({ type: "early-surface", event: "release" });
        return false;
      }
      const didClose = await surface.release();
      this.active = null;
      this.transitionRun({ type: "early-surface", event: "release" });
      return didClose;
    });
    if (closed) this.notifyStateChange();
    return closed;
  }

  scheduleFollowEdit(ctx: ExtensionContext, config: HunkConfig, filePath: string): void {
    if (!this.hasLiveSurface() && !this.getEarlyOpenPromise()) return;

    this.pendingFollowPath = filePath;
    const revision = ++this.followRevision;
    if (this.followTimer) clearTimeout(this.followTimer);
    const generation = this.generation;
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      const target = this.pendingFollowPath;
      this.pendingFollowPath = undefined;
      if (!target || !this.isActiveLifecycle() || generation !== this.generation) return;
      void this.runFollow(ctx, config, target, generation, revision);
    }, 150);
  }

  async shutdown(): Promise<void> {
    // Close admission immediately so already-queued opens fail when they run.
    const revision = this.requestLifecycle("shutdown");
    await this.exclusive(() => this.cleanupAll());
    this.completeLifecycle(revision, "shutting-down", "shutdown");
    this.notifyStateChange();
  }

  async activateSession(): Promise<void> {
    const revision = this.requestLifecycle("activate");
    await this.exclusive(async () => {
      if (this.overlay.isLive() || this.active) await this.cleanupAll();
      this.generation += 1;
      this.active = null;
      this.transitionRun({ type: "reset" });
    });
    this.completeLifecycle(revision, "activating", "active");
    this.notifyStateChange();
  }

  revive(): void {
    const next = LIFECYCLE_REVIVE_TRANSITIONS[this.lifecycle.phase];
    if (next !== "active") return;
    this.lifecycle = { phase: next, revision: this.lifecycle.revision + 1 };
    this.generation += 1;
    this.active = null;
    this.transitionRun({ type: "reset" });
  }

  private async cleanupAll(): Promise<void> {
    this.notifyReviewCancellation("session-boundary");
    this.blockingState = "idle";
    this.generation += 1;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    this.pendingFollowPath = undefined;
    this.transitionRun({ type: "reset" });

    try {
      await this.overlay.close();
    } catch {
      // Best-effort session cleanup.
    }
    this.active = null;
  }

  private assertAlive(): void {
    if (!this.isActiveLifecycle()) {
      throw new Error(`Hunk coordinator is shut down or transitioning (${this.lifecycle.phase}).`);
    }
  }

  private async closeActiveUnlocked(): Promise<boolean> {
    const surface = this.active;
    if (!surface || (!surface.isLive() && surface.getState() === "closed")) {
      this.active = null;
      this.transitionRun({ type: "early-surface", event: "adopt" });
      return false;
    }
    const closed = await surface.release();
    this.active = null;
    this.transitionRun({ type: "early-surface", event: "adopt" });
    return closed;
  }

  private onChildExit(result: HunkExit): void {
    this.notifyReviewCancellation("hunk-died");
    this.transitionRun({ type: "early-surface", event: "adopt" });
    if (result.exitCode === 0 && (result.signal ?? 0) === 0) {
      this.suppressAutoOpenForRun("dismissed");
    }
  }

  private buildRequest(
    config: HunkConfig,
    args: string[],
    source: LaunchSource,
    launchCwd: string,
  ): OpenRequest {
    return {
      cwd: resolve(launchCwd),
      command: config.hunk.command,
      args,
      source,
      focus: source === "manual" || source === "shortcut",
    };
  }

  private isCurrentFollow(generation: number, revision: number): boolean {
    return (
      this.isActiveLifecycle() && generation === this.generation && revision === this.followRevision
    );
  }

  private async runFollow(
    ctx: ExtensionContext,
    config: HunkConfig,
    filePath: string,
    generation: number,
    revision: number,
  ): Promise<void> {
    if (!this.isCurrentFollow(generation, revision)) return;
    const earlyOpenPromise = this.getEarlyOpenPromise();
    if (earlyOpenPromise) {
      try {
        await earlyOpenPromise;
      } catch {
        return;
      }
    }
    if (!this.hasLiveSurface()) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!this.isCurrentFollow(generation, revision)) return;

    await this.queueFollowNavigation(async () => {
      if (!this.isCurrentFollow(generation, revision)) return;

      const navigate = () => {
        const info = this.getActiveInfo();
        return this.navigateHunk({
          cwd: info?.repoRoot ?? info?.launchCwd ?? ctx.cwd,
          filePath,
          hunkBinary: config.hunk.command,
          sessionId: info?.sessionId,
          managedPid: info?.pid,
        });
      };

      try {
        await navigate();
      } catch {
        try {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (!this.isCurrentFollow(generation, revision)) return;
          await navigate();
        } catch (error) {
          if (!this.isCurrentFollow(generation, revision)) return;
          const message = error instanceof Error ? error.message : String(error);
          try {
            ctx.ui.notify(`Hunk follow-edit navigation failed: ${message}`, "warning");
          } catch {
            // Navigation failure must not escape a detached follow-edit task.
          }
        }
      }
    });
  }

  private queueFollowNavigation(operation: () => Promise<void>): Promise<void> {
    const result = this.followNavigationQueue.then(operation);
    this.followNavigationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
