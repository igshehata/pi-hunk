import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { AutoOpenSuppressionReason, HunkConfig } from "./config.ts";
import { navigateHunkSession, type LiveHunkSession } from "./hunk-session.ts";
import type { HunkExit } from "./overlay/embedded.ts";
import { canonicalPathIsInside } from "./path-routing.ts";
import type { ExclusiveFrameStats } from "./overlay/exclusive-frame.ts";
import { OverlaySurface } from "./overlay/surface.ts";
import type { LaunchSource, OpenRequest, SurfaceSessionInfo } from "./overlay/types.ts";

export interface CoordinatorDeps {
  overlay?: OverlaySurface;
  navigateHunk?: typeof navigateHunkSession;
}

/** Surface identity captured when a follow-edit is scheduled. */
interface FollowSurfaceIdentity {
  pid?: number;
  sessionId?: string;
  argsKey: string;
  launchCwd: string;
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
  /** Set only by the owned child's natural-exit callback until closed publishes. */
  private naturalClosePending = false;
  private transitionQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private followRevision = 0;
  private followCandidateRevision = 0;
  private followNavigationQueue: Promise<void> = Promise.resolve();
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFollowPath: string | undefined;
  private pendingFollowIdentity: FollowSurfaceIdentity | null = null;
  /** Identity published by the exact live preflight open a pending follow awaits. */
  private earlyFollowIdentity: FollowSurfaceIdentity | null = null;
  private runState = initialRunState();
  private lifecycle: CoordinatorLifecycleState = { phase: "active", revision: 0 };
  private readonly stateListeners = new Set<() => void>();

  constructor(deps: CoordinatorDeps = {}) {
    this.overlay = deps.overlay ?? new OverlaySurface();
    this.navigateHunk = deps.navigateHunk ?? navigateHunkSession;
    this.overlay.setStateListener(() => this.onOverlayStateChange());
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
    this.earlyFollowIdentity = null;
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

  hasLiveSurface(): boolean {
    return Boolean(this.active?.isLive());
  }

  getActiveInfo(): SurfaceSessionInfo | null {
    return this.active?.getInfo() ?? null;
  }

  getExclusiveFrameStats(): ExclusiveFrameStats | null {
    return this.active?.getExclusiveFrameStats() ?? null;
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
      const priorIdentity = this.captureFollowIdentity();
      const hadLiveSurface = this.overlay.isLive();
      const requestCwd =
        source === "shortcut" && hadLiveSurface
          ? (this.active?.getInfo()?.launchCwd ?? launchCwd)
          : launchCwd;
      await this.overlay.ensure(ctx, this.buildRequest(config, args, source, requestCwd), config);
      if (!this.overlay.isLive()) {
        this.cancelPendingFollow();
        if (this.overlay.getState() === "closed") return;
        throw new Error("Hunk overlay did not become live.");
      }
      this.active = this.overlay;
      // A different managed surface must not inherit follow work from its predecessor.
      const nextIdentity = this.captureFollowIdentity();
      if (
        (priorIdentity &&
          (!nextIdentity || !this.sameFollowIdentity(priorIdentity, nextIdentity))) ||
        (!priorIdentity && !(source === "live" && !hadLiveSurface))
      ) {
        this.cancelPendingFollow();
      }
      if (source === "live" && !hadLiveSurface) {
        this.earlyFollowIdentity = nextIdentity;
        this.transitionRun({ type: "early-surface", event: "opened" });
      } else if (source !== "live") {
        this.transitionRun({ type: "early-surface", event: "adopt" });
      }
    });
    this.notifyStateChange();
  }

  adoptManagedSession(session: LiveHunkSession): boolean {
    const adopted = this.active?.adoptManagedSession(session) ?? false;
    if (adopted) this.notifyStateChange();
    return adopted;
  }

  /** Restore one exact hidden managed review without changing its argv or source. */
  async showManagedSurface(managedPid: number, sessionId?: string): Promise<boolean> {
    const shown = await this.exclusive(async () => {
      this.assertAlive();
      const surface = this.active;
      const info = surface?.getInfo();
      if (
        !surface?.isLive() ||
        info?.pid !== managedPid ||
        (sessionId !== undefined && info.sessionId !== sessionId)
      ) {
        return false;
      }
      await surface.show();
      if (surface.getState() !== "visible") return false;
      this.transitionRun({ type: "early-surface", event: "adopt" });
      return true;
    });
    if (shown) this.notifyStateChange();
    return shown;
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
      const priorIdentity = this.captureFollowIdentity();
      const request = this.buildRequest(
        config,
        args,
        source,
        this.active?.isLive() ? (this.active.getInfo()?.launchCwd ?? ctx.cwd) : ctx.cwd,
      );
      if (this.active?.isLive()) {
        await this.active.toggle(ctx, request, config);
        const nextIdentity = this.captureFollowIdentity();
        if (!nextIdentity || !this.sameFollowIdentity(priorIdentity, nextIdentity)) {
          this.cancelPendingFollow();
        }
        this.transitionRun({ type: "early-surface", event: "adopt" });
        return;
      }

      await this.overlay.toggle(ctx, request, config);
      if (!this.overlay.isLive()) {
        this.cancelPendingFollow();
        if (this.overlay.getState() === "closed") return;
        throw new Error("Hunk overlay did not become live.");
      }
      this.active = this.overlay;
      // A cold user toggle cannot be the live preflight surface awaited by a
      // null-identity follow request.
      this.cancelPendingFollow();
      this.transitionRun({ type: "early-surface", event: "adopt" });
    });
    this.notifyStateChange();
  }

  async closeActive(): Promise<boolean> {
    this.suppressAutoOpenForRun("dismissed");
    const closed = await this.exclusive(async () => {
      this.cancelPendingFollow();
      return this.closeActiveUnlocked();
    });
    this.notifyStateChange();
    return closed;
  }

  /** Internal queue transition: close without dismissal/cancellation semantics. */
  async releaseSurfaceForRouting(): Promise<boolean> {
    const closed = await this.exclusive(async () => {
      this.cancelPendingFollow();
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
      this.cancelPendingFollow();
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

  /**
   * Select the first mutation target canonically contained by the repository
   * adopted for the active managed session. If metadata is not available, or
   * none is covered, preserve the previous first-target navigation so its
   * intentional outside-repository diagnostic still reaches the user.
   */
  async scheduleFollowEditCandidates(
    ctx: ExtensionContext,
    config: HunkConfig,
    filePaths: readonly string[],
  ): Promise<void> {
    const fallback = filePaths[0];
    if (!fallback || (!this.hasLiveSurface() && !this.getEarlyOpenPromise())) return;

    const candidateRevision = ++this.followCandidateRevision;
    const identity = this.captureFollowIdentity();
    const repoRoot = this.getActiveInfo()?.repoRoot;
    if (!identity || !repoRoot) {
      if (candidateRevision === this.followCandidateRevision) {
        this.scheduleFollowEditResolved(ctx, config, fallback);
      }
      return;
    }

    let target = fallback;
    try {
      const covered = await Promise.all(
        filePaths.map((filePath) => canonicalPathIsInside(filePath, repoRoot)),
      );
      const coveredIndex = covered.indexOf(true);
      if (coveredIndex >= 0) target = filePaths[coveredIndex]!;
    } catch {
      // Preserve the existing navigation diagnostic when canonical inspection
      // itself fails rather than silently dropping successful mutation evidence.
    }

    if (
      candidateRevision !== this.followCandidateRevision ||
      !this.isFollowTargetSurface(identity)
    ) {
      return;
    }
    this.scheduleFollowEditResolved(ctx, config, target);
  }

  scheduleFollowEdit(ctx: ExtensionContext, config: HunkConfig, filePath: string): void {
    this.followCandidateRevision += 1;
    this.scheduleFollowEditResolved(ctx, config, filePath);
  }

  private scheduleFollowEditResolved(
    ctx: ExtensionContext,
    config: HunkConfig,
    filePath: string,
  ): void {
    if (!this.hasLiveSurface() && !this.getEarlyOpenPromise()) return;

    this.pendingFollowPath = filePath;
    // Capture the active surface at schedule time so a later replacement cannot
    // inherit delayed navigation for a previous review.
    this.pendingFollowIdentity = this.captureFollowIdentity();
    const revision = ++this.followRevision;
    if (this.followTimer) clearTimeout(this.followTimer);
    const generation = this.generation;
    const identity = this.pendingFollowIdentity;
    const earlyOpenPromise = identity ? null : this.getEarlyOpenPromise();
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      const target = this.pendingFollowPath;
      this.pendingFollowPath = undefined;
      this.pendingFollowIdentity = null;
      if (!target || !this.isActiveLifecycle() || generation !== this.generation) return;
      void this.runFollow(ctx, config, target, generation, revision, identity, earlyOpenPromise);
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
      if (this.overlay.getState() !== "closed" || this.active) await this.cleanupAll();
      this.generation += 1;
      this.active = null;
      this.naturalClosePending = false;
      this.transitionRun({ type: "reset" });
    });
    this.completeLifecycle(revision, "activating", "active");
    this.notifyStateChange();
  }

  async revive(): Promise<void> {
    const next = LIFECYCLE_REVIVE_TRANSITIONS[this.lifecycle.phase];
    if (next !== "active") return;
    // Recovery is a real queued activation, not a metadata reset. This ensures
    // an overlay which survived an interrupted lifecycle is closed and disposed
    // before ownership references are cleared or a later open is admitted.
    await this.activateSession();
  }

  private async cleanupAll(): Promise<void> {
    this.generation += 1;
    this.cancelPendingFollow();
    this.transitionRun({ type: "reset" });

    try {
      await this.overlay.close();
    } catch (error) {
      // Never orphan a surface after failed recovery. A close which actually
      // reached the definitive terminal state may still have thrown from an
      // observer, but otherwise retain ownership so a later recovery can retry.
      if (this.overlay.getState() !== "closed" || this.overlay.isLive()) throw error;
    }
    if (this.overlay.getState() !== "closed" || this.overlay.isLive()) {
      throw new Error("Hunk overlay cleanup did not reach the closed state.");
    }
    this.active = null;
    this.naturalClosePending = false;
  }

  private cancelPendingFollow(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    this.pendingFollowPath = undefined;
    this.pendingFollowIdentity = null;
    this.earlyFollowIdentity = null;
    this.followRevision += 1;
    this.followCandidateRevision += 1;
  }

  private captureFollowIdentity(): FollowSurfaceIdentity | null {
    const info = this.getActiveInfo();
    if (!info) return null;
    return {
      pid: info.pid,
      sessionId: info.sessionId,
      argsKey: info.argsKey,
      launchCwd: info.launchCwd,
    };
  }

  private sameFollowIdentity(
    expected: FollowSurfaceIdentity | null,
    actual: FollowSurfaceIdentity | null,
  ): boolean {
    if (!expected || !actual) return false;
    if (expected.argsKey !== actual.argsKey) return false;
    if (expected.launchCwd !== actual.launchCwd) return false;
    // When both sides know a pid/session, they must match. Missing values are
    // allowed so an early open can still adopt metadata later without false
    // cancellation, but a known identity must never target a different process.
    if (expected.pid !== undefined && actual.pid !== undefined && expected.pid !== actual.pid) {
      return false;
    }
    if (
      expected.sessionId !== undefined &&
      actual.sessionId !== undefined &&
      expected.sessionId !== actual.sessionId
    ) {
      return false;
    }
    return true;
  }

  private isFollowTargetSurface(identity: FollowSurfaceIdentity | null): boolean {
    return Boolean(identity && this.sameFollowIdentity(identity, this.captureFollowIdentity()));
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

  private onOverlayStateChange(): void {
    // A child-exit callback is emitted immediately before owned removal. Keep
    // ownership until the surface publishes its definitive closed transition;
    // a close event can then never clear a replacement opened afterward.
    if (
      this.naturalClosePending &&
      this.active === this.overlay &&
      this.overlay.getState() === "closed"
    ) {
      this.naturalClosePending = false;
      this.active = null;
      this.transitionRun({ type: "early-surface", event: "adopt" });
    }
    this.notifyStateChange();
  }

  private onChildExit(result: HunkExit): void {
    this.cancelPendingFollow();
    this.naturalClosePending = this.active === this.overlay;
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

  private isCurrentFollow(
    generation: number,
    revision: number,
    identity: FollowSurfaceIdentity | null,
  ): boolean {
    return (
      this.isActiveLifecycle() &&
      generation === this.generation &&
      revision === this.followRevision &&
      this.isFollowTargetSurface(identity)
    );
  }

  private async runFollow(
    ctx: ExtensionContext,
    config: HunkConfig,
    filePath: string,
    generation: number,
    revision: number,
    initialIdentity: FollowSurfaceIdentity | null,
    earlyOpenPromise: Promise<void> | null,
  ): Promise<void> {
    if (
      !this.isActiveLifecycle() ||
      generation !== this.generation ||
      revision !== this.followRevision
    ) {
      return;
    }

    let identity = initialIdentity;
    if (!identity) {
      if (!earlyOpenPromise) return;
      try {
        await earlyOpenPromise;
      } catch {
        return;
      }
      identity = this.earlyFollowIdentity;
    }
    if (!this.isCurrentFollow(generation, revision, identity)) return;
    if (!this.hasLiveSurface()) return;

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!this.isCurrentFollow(generation, revision, identity)) return;

    await this.queueFollowNavigation(async () => {
      if (!this.isCurrentFollow(generation, revision, identity)) return;

      const navigate = () => {
        const info = this.getActiveInfo();
        // Always navigate with the captured surface identity when known so a
        // concurrent active-info swap cannot redirect the RPC.
        return this.navigateHunk({
          cwd: info?.repoRoot ?? identity?.launchCwd ?? info?.launchCwd ?? ctx.cwd,
          filePath,
          hunkBinary: config.hunk.command,
          sessionId: identity?.sessionId ?? info?.sessionId,
          managedPid: identity?.pid ?? info?.pid,
        });
      };

      try {
        await navigate();
      } catch {
        try {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (!this.isCurrentFollow(generation, revision, identity)) return;
          await navigate();
        } catch (error) {
          if (!this.isCurrentFollow(generation, revision, identity)) return;
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
