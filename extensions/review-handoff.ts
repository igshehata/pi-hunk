import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettledEvidence } from "./change-detector.ts";
import type { HunkConfig } from "./config.ts";
import type { DestructiveSurfaceTransition, ReviewCoordinator } from "./coordinator.ts";
import {
  findLiveHunkSession,
  runHunk,
  waitForManagedHunkSession,
  type HunkRunner,
  type LiveHunkSession,
  type ManagedHunkSessionWaitOptions,
  type ManagedHunkSessionWaitResult,
} from "./hunk-session.ts";
import { resolve } from "node:path";
import { canonicalizePotentialPath, pathIsInside, resolveLaunchDirectory } from "./path-routing.ts";
import { argsKey, type SurfaceSessionInfo } from "./overlay/types.ts";

/** The deliberately small, read-only note shape exposed to the agent. */
export interface HunkReviewNote {
  noteId: string;
  file: string;
  oldLine: number | null;
  newLine: number | null;
  oldRange: [number, number] | null;
  newRange: [number, number] | null;
  summary: string;
  rationale: string;
}

export type HunkReviewResult =
  | { status: "no-live-session"; message: string; notes: [] }
  | {
      status: "live";
      sessionId: string;
      pid: number;
      repoRoot?: string;
      fileCount: number;
      message: string;
      notes: HunkReviewNote[];
    };

export type HunkFeedbackResult =
  | { status: "submitted"; message: string; notes: HunkReviewNote[] }
  | { status: "pending"; message: string; notes: [] }
  | { status: "no-diff"; message: string; notes: [] }
  | { status: "unavailable"; reason: string; message: string; notes: [] };

export type AutomaticReviewRouting = "opened" | "recovered" | "reused" | "rerouted" | "replaced";

export type AutomaticReviewResult =
  | {
      status: "reviewable";
      repoRoot: string;
      fileCount: number;
      /** Final surface outcome after presentation, never a provisional policy decision. */
      routing: AutomaticReviewRouting;
      /** A pathless mutation still needs a manually selected review target. */
      unresolved?: true;
    }
  | { status: "no-diff" }
  | { status: "target-required" }
  | { status: "no-evidence" }
  | { status: "unavailable"; reason: string; detail?: string };

export interface ReviewHandoffOptions {
  cwd: string;
  /** Pin subsequent probes to one exact Hunk session. */
  sessionId?: string;
  /** OS pid of the managed Pi-owned PTY leader, when available. */
  managedPid?: number;
  hunkBinary?: string;
  run?: HunkRunner;
  signal?: AbortSignal;
}

interface CurrentComment {
  source: "user";
  noteId: string;
  filePath: string;
  body: string;
  oldRange?: [number, number];
  newRange?: [number, number];
}

function parseRange(value: unknown, field: string): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`Hunk comment JSON drift: ${field} must be a two-number range.`);
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < 1 ||
    end < start
  )
    throw new Error(`Hunk comment JSON drift: ${field} must be an ordered positive range.`);
  return [start, end];
}

function parseComments(stdout: string): CurrentComment[] {
  const value: unknown = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { comments?: unknown }).comments)
  )
    throw new Error("Hunk comment JSON drift: expected a comments array.");
  const noteIds = new Set<string>();
  return (value as { comments: unknown[] }).comments.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`Hunk comment JSON drift: comments[${index}] must be an object.`);
    const comment = entry as Record<string, unknown>;
    if (
      comment.source !== "user" ||
      typeof comment.filePath !== "string" ||
      typeof comment.body !== "string"
    )
      throw new Error(
        `Hunk comment JSON drift: comments[${index}] requires source=user, filePath, and body.`,
      );
    if (typeof comment.noteId !== "string" || comment.noteId.length === 0)
      throw new Error(
        `Hunk comment JSON drift: comments[${index}].noteId must be a non-empty string.`,
      );
    if (noteIds.has(comment.noteId)) {
      throw new Error(
        `Hunk comment JSON drift: comments[${index}].noteId duplicates ${JSON.stringify(comment.noteId)}.`,
      );
    }
    noteIds.add(comment.noteId);
    const oldRange = parseRange(comment.oldRange, `comments[${index}].oldRange`);
    const newRange = parseRange(comment.newRange, `comments[${index}].newRange`);
    if (!oldRange && !newRange)
      throw new Error(`Hunk comment JSON drift: comments[${index}] has no oldRange or newRange.`);
    return {
      source: "user",
      noteId: comment.noteId,
      filePath: comment.filePath,
      body: comment.body,
      oldRange,
      newRange,
    };
  });
}

function shapeComment(comment: CurrentComment): HunkReviewNote {
  const [summary = "", ...detail] = comment.body.trim().split(/\r?\n/);
  return {
    noteId: comment.noteId,
    file: comment.filePath,
    oldLine: comment.oldRange?.[0] ?? null,
    newLine: comment.newRange?.[0] ?? null,
    oldRange: comment.oldRange ?? null,
    newRange: comment.newRange ?? null,
    summary,
    rationale: detail.join("\n").trim(),
  };
}

/** Fresh, strictly parsed, read-only Hunk comment probe pinned to one exact session id. */
export async function readHunkReview(options: ReviewHandoffOptions): Promise<HunkReviewResult> {
  const session = await findLiveHunkSession(options);
  if (!session)
    return {
      status: "no-live-session",
      message: "No live Hunk review session exists for this repository.",
      notes: [],
    };
  return readHunkReviewForSession(session, options);
}

async function readHunkReviewForSession(
  session: LiveHunkSession,
  options: ReviewHandoffOptions,
): Promise<Extract<HunkReviewResult, { status: "live" }>> {
  const stdout = await runHunk(
    ["session", "comment", "list", session.sessionId, "--type", "user", "--json"],
    options,
  );
  const notes = parseComments(stdout).map(shapeComment);
  return {
    status: "live",
    sessionId: session.sessionId,
    pid: session.pid,
    repoRoot: session.repoRoot,
    fileCount: session.fileCount,
    message:
      notes.length === 0
        ? "The live Hunk review has no open user notes."
        : `${notes.length} open Hunk review note(s).`,
    notes,
  };
}

interface RouteSurfaceIdentity {
  argsKey: string;
  launchCwd: string;
  pid?: number;
  source: string;
}

interface ReviewCandidate {
  /** Launch seed; may be retargeted to its canonical path after a root mismatch. */
  target: string;
  /** Durable identity of the original evidence path used for queue de-duplication. */
  key: string;
  /** Preserve current-run surface ownership across transient routing failures. */
  closeWhenEmpty: boolean;
  /** Exact surface that this route may release; ownership never transfers by proximity. */
  ownedSurface?: RouteSurfaceIdentity;
  /** Candidate-local races are retried, but may not pin the queue forever. */
  transientFailures: number;
}

type RouteFailurePolicy = "global" | "retryable" | "bounded" | "terminal";

type RouteNextResult =
  | {
      status: "reviewable";
      repository: CurrentRepository;
      routing: AutomaticReviewRouting;
    }
  | { status: "no-diff"; candidate: ReviewCandidate }
  | {
      status: "unavailable";
      reason: string;
      detail?: string;
      candidate?: ReviewCandidate;
      policy: RouteFailurePolicy;
    };

interface CurrentRepository {
  candidate: ReviewCandidate;
  launchCwd: string;
  repoRoot: string;
  sessionId: string;
  managedPid: number;
  fileCount: number;
  closeWhenEmpty: boolean;
}

export type ReviewSessionWaiter = (
  options: ManagedHunkSessionWaitOptions,
) => Promise<ManagedHunkSessionWaitResult>;

interface ManagedReviewTarget {
  launchCwd: string;
  repoRoot?: string;
  sessionId?: string;
  managedPid: number;
  fileCount: number;
  /** Present for a coordinator-captured destructive-transition identity. */
  argsKey?: string;
  source?: string;
}

interface PendingReviewNote {
  note: HunkReviewNote;
  /** Delivery was attempted without confirmed host acceptance. */
  attempted: boolean;
}

type ManagedReviewInspection =
  | { status: "not-found" }
  | { status: "surface-changed" }
  | { status: "no-diff"; session: LiveHunkSession }
  | { status: "reviewable"; session: LiveHunkSession; notes: HunkReviewNote[] };

/** Acceptance is for the host turn only; it never implies model completion. */
export type LateReviewSubmissionResult = { status: "accepted" } | { status: "unconfirmed" };

export type ReviewHandoffBarrierBehavior = "block" | "continue-best-effort";

export type ReviewHandoffBarrierResult =
  | {
      status: "ready";
      transition: DestructiveSurfaceTransition;
      sessionId?: string;
      pid?: number;
      /** Notes discovered by this final exact-session probe. */
      notes: HunkReviewNote[];
      /** Collected notes whose host acceptance remains unconfirmed. */
      retainedNotes: number;
    }
  | {
      status: "unavailable";
      transition: DestructiveSurfaceTransition;
      behavior: ReviewHandoffBarrierBehavior;
      reason: string;
      detail: string;
    };

/** A user-destructive transition is fail-closed when its exact probe fails. */
export class ReviewTransitionBlockedError extends Error {
  readonly name = "ReviewTransitionBlockedError";

  constructor(readonly result: Extract<ReviewHandoffBarrierResult, { status: "unavailable" }>) {
    super(
      `Hunk ${result.transition} was blocked because comments could not be preserved ` +
        `(${result.reason}): ${result.detail}`,
    );
  }
}

export interface LateReviewDeliveryContext {
  /** Pi-session epoch that discovered and owns this batch. */
  epoch: number;
  /** Aborted synchronously when that session is reset or shut down. */
  signal: AbortSignal;
}

export type LateReviewSubmissionHandler = (
  notes: HunkReviewNote[],
  context: LateReviewDeliveryContext,
) => Promise<LateReviewSubmissionResult> | LateReviewSubmissionResult;

export type LateReviewProbeWarningHandler = (message: string) => void;

interface LateProbeFailureState {
  epoch: number;
  surfaceKey: string;
  lifecycle: number;
  detail: string;
  warned: boolean;
}

/** Pending notes deliberately handed back to the lifecycle owner at a boundary. */
export interface ReviewSessionDrain {
  epoch: number;
  notes: HunkReviewNote[];
  abortedInFlight: boolean;
}

interface LateDelivery {
  epoch: number;
  controller: AbortController;
  promise: Promise<void>;
}

const LATE_HIDE_RECHECK_MS = 150;

/** One asynchronous comment handoff and repository queue per Pi session. */
export class ReviewHandoffGate {
  private readonly submittedNoteKeys = new Set<string>();
  private readonly pending: ReviewCandidate[] = [];
  private readonly pendingKeys = new Set<string>();
  private current: CurrentRepository | null = null;
  private unresolved = false;
  private evidenceRevision = 0;
  private terminalNoDiffRevision: number | null = null;
  private sessionEpoch = 0;
  private inspectionQueue: Promise<void> = Promise.resolve();
  private pendingReviewNotes = new Map<string, PendingReviewNote>();
  private lateSubmissionHandler: LateReviewSubmissionHandler | null = null;
  private lateProbeWarningHandler: LateReviewProbeWarningHandler | null = null;
  private lateStateUnsubscribe: (() => void) | null = null;
  private lateSurfaceSnapshot: { key: string; state: string } | null = null;
  private lateSurfaceLifecycle = 0;
  /** Recoverable automatic inspection failure, retained until a successful retry/reset. */
  private lateProbeFailure: LateProbeFailureState | null = null;
  private lateDelivery: LateDelivery | null = null;
  private lateHideRecheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly getConfig: () => HunkConfig,
    private readonly run?: HunkRunner,
    private readonly waitForSession: ReviewSessionWaiter = waitForManagedHunkSession,
  ) {
    // The coordinator owns transition serialization; this callback performs no
    // queued coordinator operation, so holding that queue while probing cannot
    // deadlock. User close/replace/release is fail-closed. Lifecycle teardown
    // and a child that has already exited are necessarily best-effort.
    this.coordinator.setDestructiveTransitionGuard?.(async (transition, surface) => {
      const result = await this.beforeDestructiveTransition(transition, surface);
      if (result.status === "unavailable" && result.behavior === "block") {
        throw new ReviewTransitionBlockedError(result);
      }
    });
  }

  /**
   * Inspect and drain the exact active PID/session before its surface is lost.
   * The caller-provided identity is captured by the coordinator while its
   * transition queue owns that surface; no repository-nearest fallback occurs.
   */
  async beforeDestructiveTransition(
    transition: DestructiveSurfaceTransition,
    surface: SurfaceSessionInfo | null = this.coordinator.getActiveInfo(),
  ): Promise<ReviewHandoffBarrierResult> {
    const behavior = this.barrierBehavior(transition);
    if (!surface) {
      return { status: "ready", transition, notes: [], retainedNotes: 0 };
    }
    if (surface.pid === undefined || !Number.isInteger(surface.pid) || surface.pid <= 0) {
      return this.barrierUnavailable(
        transition,
        behavior,
        "managed-pid-missing",
        "the active Pi-owned Hunk surface has no valid managed PID",
      );
    }

    const epoch = this.sessionEpoch;
    const target: ManagedReviewTarget = {
      launchCwd: surface.launchCwd,
      repoRoot: surface.repoRoot,
      sessionId: surface.sessionId,
      managedPid: surface.pid,
      fileCount: surface.fileCount ?? 0,
      argsKey: surface.argsKey,
      source: surface.source,
    };
    const allowClosing = transition === "natural-exit";
    const inspected = await this.runInspection(async (): Promise<ReviewHandoffBarrierResult> => {
      if (epoch !== this.sessionEpoch) {
        return this.barrierUnavailable(
          transition,
          behavior,
          "session-boundary",
          "the Pi session changed before its Hunk comments could be inspected",
        );
      }
      if (!this.targetMatchesActiveSurface(target, allowClosing)) {
        return this.barrierUnavailable(
          transition,
          behavior,
          "surface-changed",
          "the exact active Hunk surface changed before its comments could be inspected",
        );
      }

      try {
        const review = await this.inspectTarget(target, undefined, allowClosing);
        if (epoch !== this.sessionEpoch) {
          return this.barrierUnavailable(
            transition,
            behavior,
            "session-boundary",
            "the Pi session changed while its Hunk comments were being inspected",
          );
        }
        if (review.status === "not-found") {
          return this.barrierUnavailable(
            transition,
            behavior,
            "hunk-died",
            "the exact managed Hunk session was not found",
          );
        }
        if (review.status === "surface-changed") {
          return this.barrierUnavailable(
            transition,
            behavior,
            "surface-changed",
            "the exact active Hunk surface changed while its comments were being inspected",
          );
        }
        if (!allowClosing && !this.adoptInspectedSession(target, review.session)) {
          return this.barrierUnavailable(
            transition,
            behavior,
            "surface-changed",
            "the exact managed Hunk session could not be adopted by its active surface",
          );
        }

        this.lateProbeFailure = null;
        const notes: HunkReviewNote[] = [];
        if (review.status === "reviewable") {
          notes.push(...this.unseenNotes(review.session.sessionId, review.notes));
          if (notes.length > 0) {
            this.submitDetectedNotes(review.session.sessionId, notes, review.notes.length);
          }
        }
        return {
          status: "ready",
          transition,
          sessionId: review.session.sessionId,
          pid: review.session.pid,
          notes,
          retainedNotes: this.pendingReviewNotes.size,
        };
      } catch (error) {
        return this.barrierUnavailable(
          transition,
          behavior,
          "comment-probe-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    // Host delivery is deliberately awaited outside inspectionQueue. A host
    // callback can therefore trigger /hunk feedback without creating a queue
    // cycle, while the coordinator still holds the exact destructive surface.
    await this.awaitCurrentDelivery(epoch);
    if (epoch !== this.sessionEpoch) {
      return this.barrierUnavailable(
        transition,
        behavior,
        "session-boundary",
        "the Pi session changed while collected Hunk comments were being delivered",
      );
    }
    if (inspected.status === "ready") {
      return { ...inspected, retainedNotes: this.pendingReviewNotes.size };
    }
    return inspected;
  }

  private barrierBehavior(transition: DestructiveSurfaceTransition): ReviewHandoffBarrierBehavior {
    return transition === "shutdown" ||
      transition === "activate" ||
      transition === "natural-exit" ||
      transition === "automatic-release"
      ? "continue-best-effort"
      : "block";
  }

  private barrierUnavailable(
    transition: DestructiveSurfaceTransition,
    behavior: ReviewHandoffBarrierBehavior,
    reason: string,
    detail: string,
  ): Extract<ReviewHandoffBarrierResult, { status: "unavailable" }> {
    const result = { status: "unavailable" as const, transition, behavior, reason, detail };
    if (behavior === "continue-best-effort") {
      const handler = this.lateProbeWarningHandler;
      try {
        handler?.(
          `Hunk comments could not be inspected before ${transition} (${detail}); ` +
            "teardown will continue because this transition cannot safely be blocked.",
        );
      } catch {
        // A lifecycle warning must never prevent unavoidable teardown.
      }
    }
    return result;
  }

  /** Report a failed hide probe once, with `/hunk feedback` as its recovery action. */
  onLateProbeWarning(handler: LateReviewProbeWarningHandler): () => void {
    this.lateProbeWarningHandler = handler;
    this.emitLateProbeWarning();
    return () => {
      if (this.lateProbeWarningHandler === handler) this.lateProbeWarningHandler = null;
    };
  }

  /** Deliver unseen comments whenever a managed Hunk surface is hidden. */
  onLateSubmission(handler: LateReviewSubmissionHandler): () => void {
    this.lateSubmissionHandler = handler;
    if (!this.lateStateUnsubscribe) {
      this.lateSurfaceSnapshot = this.currentSurfaceSnapshot();
      this.lateStateUnsubscribe = this.coordinator.onStateChange(() =>
        this.observeCoordinatorState(),
      );
    }
    void this.dispatchLateNotes();
    return () => {
      if (this.lateSubmissionHandler !== handler) return;
      this.lateSubmissionHandler = null;
      this.lateStateUnsubscribe?.();
      this.lateStateUnsubscribe = null;
      this.lateSurfaceSnapshot = null;
      this.clearLateHideRecheck();
    };
  }

  resetSession(): ReviewSessionDrain {
    const epoch = this.sessionEpoch;
    const retiringNotes = [...this.pendingReviewNotes.values()].map((entry) => entry.note);
    const delivery = this.lateDelivery;

    // Advance first: every asynchronous inspection/delivery completion checks
    // this identity before it can mutate dedupe state. Abort is advisory for
    // handlers that can cancel; the detached epoch guard remains authoritative.
    this.sessionEpoch += 1;
    if (delivery?.epoch === epoch) delivery.controller.abort();
    this.lateDelivery = null;

    // Replace, rather than clear, the map captured by an old delivery. The
    // returned snapshot is the explicit lifecycle handoff for failed,
    // unconfirmed, or aborted notes and can never join the new epoch's queue.
    this.pendingReviewNotes = new Map();
    this.clearLateHideRecheck();
    this.evidenceRevision = 0;
    this.submittedNoteKeys.clear();
    this.lateSurfaceSnapshot = this.currentSurfaceSnapshot();
    this.lateSurfaceLifecycle = 0;
    this.lateProbeFailure = null;
    this.resetPlan();
    return {
      epoch,
      notes: retiringNotes,
      abortedInFlight: delivery?.epoch === epoch,
    };
  }

  /** Merge one successful tool-completion delta into the deterministic queue. */
  addEvidence(evidence: SettledEvidence): void {
    if (!evidence.mutation) return;
    if (this.terminalNoDiffRevision !== null && evidence.revision > this.terminalNoDiffRevision) {
      this.terminalNoDiffRevision = null;
      this.resetPlan();
    }
    this.evidenceRevision = Math.max(this.evidenceRevision, evidence.revision);
    for (const target of evidence.targets) this.addCandidate(target);
    if (evidence.unresolved) this.unresolved = true;
  }

  /** Route a non-blocking automatic surface and skip Hunk-confirmed empty roots. */
  async presentAutomatic(
    ctx: ExtensionContext,
    source: "auto" | "live" | "recover" = "auto",
  ): Promise<AutomaticReviewResult> {
    if (this.terminalNoDiffRevision !== null && this.pending.length === 0 && !this.current) {
      return { status: "no-diff" };
    }
    if (!this.current && this.pending.length === 0) {
      return this.unresolved ? { status: "target-required" } : { status: "no-evidence" };
    }

    const attemptedTransientCandidates = new Set<string>();
    for (;;) {
      const routed = await this.routeNext(ctx, source);
      if (routed.status === "unavailable") {
        const candidate = routed.candidate;
        if (!candidate || routed.policy === "global") return this.publicRouteFailure(routed);

        if (routed.policy === "bounded") candidate.transientFailures += 1;
        const terminal =
          routed.policy === "terminal" ||
          (routed.policy === "bounded" && candidate.transientFailures >= 2);
        if (terminal) {
          this.discardCandidate(candidate);
          await this.releaseCandidateSurface(candidate);
          if (this.pending.length > 0) continue;
          return this.publicRouteFailure(routed);
        }

        // A retryable head may yield to candidates not yet attempted by this
        // operation. Release only its exact route-owned surface before moving on.
        attemptedTransientCandidates.add(candidate.key);
        const canProgress = this.pending.some(
          (entry) => entry.key !== candidate.key && !attemptedTransientCandidates.has(entry.key),
        );
        if (!canProgress) return this.publicRouteFailure(routed);
        this.deferCandidate(candidate);
        await this.releaseCandidateSurface(candidate);
        continue;
      }
      if (routed.status === "reviewable") {
        this.coordinator.adoptEarlySurfaceForRun();
        return {
          status: "reviewable",
          repoRoot: routed.repository.repoRoot,
          fileCount: routed.repository.fileCount,
          routing: routed.routing,
          ...(this.unresolved ? { unresolved: true as const } : {}),
        };
      }

      this.current = null;
      await this.releaseCandidateSurface(routed.candidate);
      if (this.pending.length > 0) continue;
      if (this.unresolved) return { status: "target-required" };
      this.completeNoDiff();
      return { status: "no-diff" };
    }
  }

  /** Force the same fresh-comment probe that normally runs on hide. */
  async submit(ctx: ExtensionContext): Promise<HunkFeedbackResult> {
    return this.runReviewAction(ctx);
  }

  /** Move to the next repository without implying human approval. */
  async next(ctx: ExtensionContext): Promise<AutomaticReviewResult> {
    if (ctx.mode !== "tui") {
      return { status: "unavailable", reason: "not-tui" };
    }
    if (this.pending.length === 0) {
      return this.unresolved ? { status: "target-required" } : { status: "no-evidence" };
    }

    // Probe even a still-visible review, then wait behind every inspection that
    // was already queued by a hide. Replacing the process earlier could make
    // its inline comments permanently unreachable.
    const actionEpoch = this.sessionEpoch;
    const routeOwnsUnregisteredSurface = Boolean(
      !this.current &&
      this.pending[0]?.ownedSurface &&
      this.surfaceMatches(this.pending[0].ownedSurface),
    );
    const probe =
      this.activeReviewTarget() && !routeOwnsUnregisteredSurface
        ? await this.runReviewAction(ctx)
        : null;
    await this.runInspection(async () => undefined);
    if (actionEpoch !== this.sessionEpoch) {
      return { status: "unavailable", reason: "session-boundary" };
    }
    if (probe?.status === "unavailable") {
      return { status: "unavailable", reason: probe.reason, detail: probe.message };
    }
    if (this.pending.length === 0) return { status: "no-evidence" };
    this.current = null;
    return this.presentAutomatic(ctx, "auto");
  }

  private publicRouteFailure(
    failure: Extract<RouteNextResult, { status: "unavailable" }>,
  ): Extract<AutomaticReviewResult, { status: "unavailable" }> {
    return {
      status: "unavailable",
      reason: failure.reason,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    };
  }

  private addCandidate(target: string): void {
    const key = target;
    if (this.current?.candidate.key === key || this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.pending.push({ target, key, closeWhenEmpty: false, transientFailures: 0 });
  }

  private removeCandidate(candidate: ReviewCandidate): void {
    const index = this.pending.findIndex((entry) => entry.key === candidate.key);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.pendingKeys.delete(candidate.key);
  }

  private discardCandidate(candidate: ReviewCandidate): void {
    if (this.current?.candidate === candidate) this.current = null;
    this.removeCandidate(candidate);
  }

  private deferCandidate(candidate: ReviewCandidate): void {
    if (this.current?.candidate === candidate) this.current = null;
    this.removeCandidate(candidate);
    this.pendingKeys.add(candidate.key);
    this.pending.push(candidate);
  }

  private requeueCurrentCandidate(candidate: ReviewCandidate): void {
    if (this.current?.candidate === candidate) this.current = null;
    if (this.pendingKeys.has(candidate.key)) return;
    this.pendingKeys.add(candidate.key);
    this.pending.unshift(candidate);
  }

  private surfaceMatches(identity: RouteSurfaceIdentity): boolean {
    const info = this.coordinator.getActiveInfo();
    return Boolean(
      info &&
      info.argsKey === identity.argsKey &&
      info.launchCwd === identity.launchCwd &&
      info.pid === identity.pid &&
      info.source === identity.source,
    );
  }

  private async releaseCandidateSurface(candidate: ReviewCandidate): Promise<void> {
    if (!candidate.closeWhenEmpty || !candidate.ownedSurface) return;
    if (this.surfaceMatches(candidate.ownedSurface)) {
      await this.coordinator.releaseSurfaceForRouting();
    }
    candidate.closeWhenEmpty = false;
    candidate.ownedSurface = undefined;
  }

  private async routeNext(
    ctx: ExtensionContext,
    source: "auto" | "live" | "recover",
  ): Promise<RouteNextResult> {
    const routeEpoch = this.sessionEpoch;
    const staleRoute = () =>
      ({
        status: "unavailable",
        reason: "session-boundary",
        detail: "The Pi session changed while Hunk routing was in progress.",
        policy: "global",
      }) as const;
    const isCurrentRoute = () => routeEpoch === this.sessionEpoch;

    const existing = this.current;
    // Peek rather than consume: the caller commits terminal removal or
    // deterministic retry/defer only after the failure has been classified.
    const candidate = existing?.candidate ?? this.pending[0];
    if (!candidate) {
      return { status: "unavailable", reason: "no-review-target", policy: "global" };
    }

    let launchCwd: string;
    try {
      launchCwd = await resolveLaunchDirectory(candidate.target);
    } catch (error) {
      return {
        status: "unavailable",
        reason: "invalid-target",
        detail: error instanceof Error ? error.message : String(error),
        candidate,
        policy: "terminal",
      };
    }
    if (!isCurrentRoute()) return staleRoute();

    const before = this.coordinator.getActiveInfo();
    const beforeLaunchCwd = before ? await canonicalizePotentialPath(before.launchCwd) : undefined;
    const beforeRepoRoot = before?.repoRoot
      ? await canonicalizePotentialPath(before.repoRoot)
      : undefined;
    if (!isCurrentRoute()) return staleRoute();
    const config = this.getConfig();
    // Manual/shortcut surfaces may only stand in for automatic review when their
    // full launch identity already matches the configured automatic request.
    // Matching launchCwd alone is not enough: `/hunk show HEAD~1` must not be
    // treated as the working-copy watcher after a same-directory mutation.
    // Build the desired key with the surface's own normalized cwd spelling.
    // launchCwd is realpathed, while an existing surface may have been opened
    // through an equivalent symlink; the canonical cwd comparison below owns
    // path equivalence and argsKey owns command/argv identity.
    const desiredArgsKey = before
      ? argsKey(config.hunk.command, config.hunk.args, before.launchCwd)
      : undefined;
    const reuseManualSurface =
      (before?.source === "manual" || before?.source === "shortcut") &&
      beforeLaunchCwd === launchCwd &&
      before.argsKey === desiredArgsKey;
    const restoreManualSurface = reuseManualSurface && before?.state === "hidden";
    if (!reuseManualSurface) {
      // Replacing a live manual/shortcut surface can permanently drop its inline
      // comments unless we probe first (same guarantee as `/hunk next`).
      if (
        before &&
        (before.source === "manual" || before.source === "shortcut") &&
        (before.state === "visible" || before.state === "hidden")
      ) {
        if (!this.activeReviewTarget()) {
          return {
            status: "unavailable",
            reason: "outgoing-review-unavailable",
            detail: "The existing manual Hunk surface could not be inspected before replacement.",
            policy: "global",
          };
        }
        const probe = await this.runReviewAction(ctx);
        await this.runInspection(async () => undefined);
        if (!isCurrentRoute()) return staleRoute();
        if (probe.status === "unavailable") {
          return {
            status: "unavailable",
            reason: probe.reason,
            detail: probe.message,
            policy: "global",
          };
        }
      }
      await this.coordinator.ensureOpen(ctx, config, config.hunk.args, source, launchCwd);
    }
    if (!isCurrentRoute()) return staleRoute();
    const info = this.coordinator.getActiveInfo();
    if (!info || (info.state !== "visible" && info.state !== "hidden")) {
      return {
        status: "unavailable",
        reason: "surface-not-live",
        candidate,
        policy: "bounded",
      };
    }
    // Record ownership before session lookup so transient registration failures
    // cannot make a route-opened surface look user-owned on the next attempt.
    const ownsActiveSurface =
      (candidate.closeWhenEmpty &&
        candidate.ownedSurface !== undefined &&
        this.surfaceMatches(candidate.ownedSurface)) ||
      !before ||
      before.argsKey !== info.argsKey ||
      (before.pid !== undefined && info.pid !== undefined && before.pid !== info.pid) ||
      this.coordinator.isEarlySurfaceOwnedForRun();
    if (ownsActiveSurface) {
      candidate.closeWhenEmpty = true;
      candidate.ownedSurface = {
        argsKey: info.argsKey,
        launchCwd: info.launchCwd,
        pid: info.pid,
        source: info.source,
      };
    }

    const managedPid = info.pid;
    if (managedPid === undefined || !Number.isInteger(managedPid) || managedPid <= 0) {
      return {
        status: "unavailable",
        reason: "managed-pid-missing",
        detail: "The Pi-owned Hunk process did not expose a valid PID.",
        candidate,
        policy: "terminal",
      };
    }

    const lookup = await this.waitForSession({
      cwd: info.launchCwd || launchCwd,
      managedPid,
      hunkBinary: config.hunk.command,
      run: this.run,
    });
    if (!isCurrentRoute()) return staleRoute();
    if (lookup.status === "not-found") {
      return {
        status: "unavailable",
        reason: "session-not-registered",
        detail: "Hunk did not register the managed process within the bounded retry window.",
        candidate,
        policy: "bounded",
      };
    }

    const session = lookup.session;
    if (session.pid !== managedPid) {
      return {
        status: "unavailable",
        reason: "managed-session-mismatch",
        detail: `Hunk reported pid ${session.pid} for managed pid ${managedPid}.`,
        candidate,
        policy: "terminal",
      };
    }
    if (!session.repoRoot) {
      return {
        status: "unavailable",
        reason: "repo-root-missing",
        detail: `Managed Hunk session ${session.sessionId} did not report a repository root.`,
        candidate,
        policy: "terminal",
      };
    }
    const repoRoot = await canonicalizePotentialPath(session.repoRoot);
    if (!isCurrentRoute()) return staleRoute();
    const adoptedSession: LiveHunkSession = { ...session, repoRoot };
    if (!this.coordinator.adoptManagedSession(adoptedSession)) {
      return {
        status: "unavailable",
        reason: "surface-changed",
        detail: "The managed Hunk surface changed while its session metadata was loading.",
        candidate,
        policy: "bounded",
      };
    }

    const after = this.coordinator.getActiveInfo();
    if (
      !after ||
      (after.state !== "visible" && after.state !== "hidden") ||
      after.pid !== managedPid
    ) {
      return {
        status: "unavailable",
        reason: "surface-changed",
        detail: "The managed Hunk surface changed while its session metadata was loading.",
        candidate,
        policy: "bounded",
      };
    }

    // Validate the seed before removing any covered pending targets. A route
    // launched from a cross-repository symlink may report repo A while the seed
    // belongs to repo B; consuming other repo-A candidates here would mark a
    // surface as covered even though this mismatched route is never presented.
    const seedCanonical = await canonicalizePotentialPath(candidate.target);
    if (!isCurrentRoute()) return staleRoute();
    if (!pathIsInside(seedCanonical, repoRoot)) {
      // Already aimed at the real path and Hunk still reported a non-covering
      // root: leave the candidate retryable and surface an explicit mismatch.
      if (resolve(candidate.target) === seedCanonical) {
        // Do not leave a route-owned surface showing an unrelated repository.
        // A matching pre-existing manual surface remains intact and retryable.
        if (candidate.closeWhenEmpty) {
          // Closing emits synchronously; preserve a candidate that came from
          // current before the production state listener clears that pointer.
          if (existing) this.requeueCurrentCandidate(candidate);
          await this.releaseCandidateSurface(candidate);
          if (!isCurrentRoute()) return staleRoute();
        }
        return {
          status: "unavailable",
          reason: "repo-root-mismatch",
          detail: `Hunk reported ${repoRoot}, which does not contain ${seedCanonical}.`,
          candidate,
          policy: "retryable",
        };
      }
      // Retarget so the next attempt launches near the real file (repo B),
      // then close the mismatched surface and continue the routing loop.
      candidate.target = seedCanonical;
      if (existing) this.requeueCurrentCandidate(candidate);
      return { status: "no-diff", candidate };
    }

    candidate.transientFailures = 0;
    if (!(await this.coverPendingTargets(repoRoot, routeEpoch))) return staleRoute();
    if (!existing) this.removeCandidate(candidate);
    const repository: CurrentRepository = {
      candidate,
      launchCwd,
      repoRoot,
      sessionId: session.sessionId,
      managedPid: session.pid,
      fileCount: session.fileCount,
      closeWhenEmpty: candidate.closeWhenEmpty,
    };
    this.current = repository;

    if (lookup.status === "no-diff") {
      return { status: "no-diff", candidate };
    }
    if (
      restoreManualSurface &&
      !(await this.coordinator.showManagedSurface(repository.managedPid, repository.sessionId))
    ) {
      return {
        status: "unavailable",
        reason: "surface-changed",
        detail: "The reused Hunk surface changed before it could be restored.",
        candidate,
        policy: "bounded",
      };
    }
    if (!isCurrentRoute()) return staleRoute();

    const sameSurface = Boolean(
      before &&
      before.pid === after.pid &&
      before.argsKey === after.argsKey &&
      beforeLaunchCwd === (await canonicalizePotentialPath(after.launchCwd)),
    );
    if (!isCurrentRoute()) return staleRoute();
    const routing: AutomaticReviewRouting = sameSurface
      ? "reused"
      : !before
        ? source === "recover"
          ? "recovered"
          : "opened"
        : (beforeRepoRoot !== undefined && beforeRepoRoot !== repoRoot) ||
            (beforeLaunchCwd !== undefined && !pathIsInside(beforeLaunchCwd, repoRoot))
          ? "rerouted"
          : "replaced";
    return { status: "reviewable", repository, routing };
  }

  private async coverPendingTargets(repoRoot: string, routeEpoch: number): Promise<boolean> {
    const coveredKeys = new Set<string>();
    const candidatesAtRouteStart = this.pending.slice();
    for (const candidate of candidatesAtRouteStart) {
      const canonicalTarget = await canonicalizePotentialPath(candidate.target);
      if (pathIsInside(canonicalTarget, repoRoot)) coveredKeys.add(candidate.key);
      if (routeEpoch !== this.sessionEpoch) return false;
    }

    const remaining = this.pending.filter((candidate) => !coveredKeys.has(candidate.key));

    // Commit only after every asynchronous containment check succeeds. Targets
    // added concurrently are absent from coveredKeys and therefore retained.
    this.pending.length = 0;
    this.pending.push(...remaining);
    this.pendingKeys.clear();
    for (const candidate of remaining) this.pendingKeys.add(candidate.key);
    return true;
  }

  private noteKey(sessionId: string, note: HunkReviewNote): string {
    return `${sessionId}\0${note.noteId}`;
  }

  private runInspection<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inspectionQueue.then(operation);
    this.inspectionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async inspectTarget(
    target: ManagedReviewTarget,
    signal?: AbortSignal,
    allowClosing = false,
  ): Promise<ManagedReviewInspection> {
    const config = this.getConfig();
    const refreshed = await this.waitForSession({
      cwd: target.repoRoot ?? target.launchCwd,
      sessionId: target.sessionId,
      managedPid: target.managedPid,
      hunkBinary: config.hunk.command,
      run: this.run,
      signal,
    });
    if (refreshed.status === "not-found") return { status: "not-found" };
    if (
      (target.sessionId !== undefined && refreshed.session.sessionId !== target.sessionId) ||
      refreshed.session.pid !== target.managedPid
    ) {
      throw new Error("The managed Hunk session changed while comments were being collected.");
    }

    if (!this.targetMatchesActiveSurface(target, allowClosing)) {
      return { status: "surface-changed" };
    }
    if (refreshed.status === "no-diff") {
      return { status: "no-diff", session: refreshed.session };
    }

    const review = await readHunkReviewForSession(refreshed.session, {
      cwd: refreshed.session.repoRoot ?? refreshed.session.cwd,
      sessionId: refreshed.session.sessionId,
      managedPid: refreshed.session.pid,
      hunkBinary: config.hunk.command,
      run: this.run,
      signal,
    });
    // Comment-list is pinned to the refreshed session id, but delivery also
    // requires that the coordinator still owns the same exact PTY afterward.
    if (!this.targetMatchesActiveSurface(target, allowClosing)) {
      return { status: "surface-changed" };
    }
    return { status: "reviewable", session: refreshed.session, notes: review.notes };
  }

  private unseenNotes(sessionId: string, notes: HunkReviewNote[]): HunkReviewNote[] {
    return notes.filter((note) => {
      const key = this.noteKey(sessionId, note);
      return !this.submittedNoteKeys.has(key) && !this.pendingReviewNotes.has(key);
    });
  }

  private submittedResult(
    notes: HunkReviewNote[],
    totalOpenNotes = notes.length,
  ): Extract<HunkFeedbackResult, { status: "submitted" }> {
    return {
      status: "submitted",
      message:
        notes.length === totalOpenNotes
          ? `${notes.length} open Hunk review note(s).`
          : `${notes.length} new Hunk review note(s); ${totalOpenNotes - notes.length} already submitted in this Pi extension.`,
      notes,
    };
  }

  private pendingResult(message: string): Extract<HunkFeedbackResult, { status: "pending" }> {
    return { status: "pending", message, notes: [] };
  }

  private submitDetectedNotes(
    sessionId: string,
    notes: HunkReviewNote[],
    totalOpenNotes: number,
  ): HunkFeedbackResult {
    const result = this.submittedResult(notes, totalOpenNotes);
    this.terminalNoDiffRevision = null;
    for (const note of notes) {
      const key = this.noteKey(sessionId, note);
      if (!this.submittedNoteKeys.has(key) && !this.pendingReviewNotes.has(key)) {
        this.pendingReviewNotes.set(key, { note, attempted: false });
      }
    }
    void this.dispatchLateNotes();
    return result;
  }

  private async runReviewAction(ctx: ExtensionContext): Promise<HunkFeedbackResult> {
    if (ctx.mode !== "tui") return this.unavailable("not-tui");
    const actionEpoch = this.sessionEpoch;
    await this.awaitCurrentDelivery(actionEpoch);
    if (actionEpoch !== this.sessionEpoch) return this.unavailable("session-boundary");

    // Retry known notes first, but still perform the promised fresh probe. New
    // comments may have been added while an earlier delivery remained queued;
    // returning immediately here would let /hunk next replace their only live
    // process before they had ever been collected.
    const queuedEntries = [...this.pendingReviewNotes.entries()];
    if (queuedEntries.length > 0) {
      // An explicit action is the recovery path for every retained note,
      // including notes whose earlier host acceptance was unconfirmed.
      await this.dispatchLateNotes(true);
      if (actionEpoch !== this.sessionEpoch) return this.unavailable("session-boundary");
    }

    const probed = await this.runInspection(async () => {
      if (actionEpoch !== this.sessionEpoch) {
        return this.unavailable("session-boundary");
      }
      const target = this.reviewActionTarget();
      if (!target) {
        return this.unavailable(
          "no-managed-review",
          "No managed Hunk review is available to inspect for comments.",
        );
      }

      try {
        const inspected = await this.inspectTarget(target);
        if (actionEpoch !== this.sessionEpoch) {
          return this.unavailable("session-boundary");
        }
        if (inspected.status === "not-found") return this.unavailable("hunk-died");
        if (inspected.status === "surface-changed") {
          return this.unavailable("surface-changed");
        }
        if (!this.adoptInspectedSession(target, inspected.session)) {
          return this.unavailable("surface-changed");
        }
        // A fresh explicit probe is the recovery boundary for a failed hide
        // inspection. Delivery remains independently queued/unconfirmed below.
        this.lateProbeFailure = null;
        if (inspected.status === "no-diff") {
          if (this.current === target) {
            const current = this.current;
            this.current = null;
            await this.releaseCandidateSurface(current.candidate);
            if (this.pending.length === 0 && !this.unresolved) this.completeNoDiff();
          }
          return this.noDiffResult();
        }

        const sessionId = inspected.session.sessionId;
        const unseen = this.unseenNotes(sessionId, inspected.notes);
        if (unseen.length === 0) {
          return this.pendingResult("No new Hunk notes were found.");
        }

        return this.submitDetectedNotes(sessionId, unseen, inspected.notes.length);
      } catch (error) {
        return this.unavailable(
          "comment-probe-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    await this.awaitCurrentDelivery(actionEpoch);
    if (actionEpoch !== this.sessionEpoch) return this.unavailable("session-boundary");

    const deliveredQueuedNotes = queuedEntries
      .filter(([key, entry]) => this.pendingReviewNotes.get(key) !== entry)
      .map(([, entry]) => entry.note);
    if (probed.status === "unavailable") {
      return probed.reason === "no-managed-review" && deliveredQueuedNotes.length > 0
        ? this.submittedResult(deliveredQueuedNotes)
        : probed;
    }
    if (this.pendingReviewNotes.size > 0) {
      return this.pendingResult(
        "Fresh Hunk notes remain queued; run /hunk feedback if automatic delivery keeps failing.",
      );
    }
    if (probed.status === "submitted" && deliveredQueuedNotes.length > 0) {
      return this.submittedResult([...deliveredQueuedNotes, ...probed.notes]);
    }
    if (deliveredQueuedNotes.length > 0) return this.submittedResult(deliveredQueuedNotes);
    return probed;
  }

  private targetMatchesActiveSurface(target: ManagedReviewTarget, allowClosing = false): boolean {
    const info = this.coordinator.getActiveInfo();
    if (
      !info ||
      (info.state !== "visible" &&
        info.state !== "hidden" &&
        !(allowClosing && info.state === "closing")) ||
      info.pid !== target.managedPid
    ) {
      return false;
    }
    if (target.sessionId !== undefined && info.sessionId !== target.sessionId) return false;
    if (target.argsKey !== undefined && info.argsKey !== target.argsKey) return false;
    if (target.source !== undefined && info.source !== target.source) return false;
    return info.launchCwd === target.launchCwd;
  }

  private sessionMatchesActiveSurface(session: LiveHunkSession): boolean {
    const active = this.activeReviewTarget();
    return Boolean(
      active &&
      active.managedPid === session.pid &&
      (active.sessionId === undefined || active.sessionId === session.sessionId),
    );
  }

  private adoptInspectedSession(target: ManagedReviewTarget, session: LiveHunkSession): boolean {
    if (!this.sessionMatchesActiveSurface(session)) return false;
    if (!this.coordinator.adoptManagedSession(session)) return false;
    target.sessionId = session.sessionId;
    target.repoRoot = session.repoRoot;
    target.managedPid = session.pid;
    target.fileCount = session.fileCount;
    return true;
  }

  private currentMatchesActiveTarget(active: ManagedReviewTarget | null): boolean {
    return Boolean(
      active &&
      this.current?.managedPid === active.managedPid &&
      this.current.sessionId === active.sessionId,
    );
  }

  private reviewActionTarget(): ManagedReviewTarget | null {
    const active = this.activeReviewTarget();
    return this.currentMatchesActiveTarget(active) ? this.current : active;
  }

  private activeReviewTarget(): ManagedReviewTarget | null {
    const info = this.coordinator.getActiveInfo();
    if (
      !info ||
      (info.state !== "visible" && info.state !== "hidden") ||
      info.pid === undefined ||
      !Number.isInteger(info.pid) ||
      info.pid <= 0
    ) {
      return null;
    }
    return {
      launchCwd: info.launchCwd,
      repoRoot: info.repoRoot,
      sessionId: info.sessionId,
      managedPid: info.pid,
      fileCount: info.fileCount ?? 0,
    };
  }

  private currentSurfaceSnapshot(): { key: string; state: string } | null {
    const info = this.coordinator.getActiveInfo();
    if (!info) return null;
    return {
      // Session metadata may be adopted between visible and hidden without a
      // distinct surface transition. The managed PID + argv identity remains
      // stable for that same persistent review.
      key: `${info.argsKey}\0${info.pid ?? ""}`,
      state: info.state,
    };
  }

  private observeCoordinatorState(): void {
    if (this.current && !this.currentMatchesActiveTarget(this.activeReviewTarget())) {
      this.current = null;
    }
    this.observeLateSurface();
  }

  private observeLateSurface(): void {
    const previous = this.lateSurfaceSnapshot;
    const current = this.currentSurfaceSnapshot();
    this.lateSurfaceSnapshot = current;
    if (!previous || !current || previous.key !== current.key) {
      this.clearLateHideRecheck();
      return;
    }

    const hidden = previous.state === "visible" && current.state === "hidden";
    const restored = previous.state === "hidden" && current.state === "visible";
    const hadPendingEmptyRecheck = this.lateHideRecheckTimer !== null;
    // Restore needs a fresh probe only when the successful hide probe found no
    // notes and armed its persistence debounce. Failed probes retain their one
    // warning; discovered notes retain their explicit delivery/retry semantics.
    if (!hidden && !(restored && hadPendingEmptyRecheck)) return;

    const target = this.activeReviewTarget();
    if (!target) return;
    const epoch = this.sessionEpoch;
    const lifecycle = ++this.lateSurfaceLifecycle;
    const probe = this.runInspection(() =>
      this.probeLateTarget(target, epoch, current.key, lifecycle),
    );

    this.clearLateHideRecheck();
    if (!hidden) {
      void probe;
      return;
    }
    // Hunk may persist a just-saved note shortly after Pi observes the hide.
    // Recheck only when the immediate exact-session probe succeeded but found
    // nothing; failures keep their one warning and discovered notes must not
    // cause an unsolicited retry after a delivery failure.
    void probe.then((result) => {
      if (
        result !== "empty" ||
        epoch !== this.sessionEpoch ||
        lifecycle !== this.lateSurfaceLifecycle
      ) {
        return;
      }
      const snapshot = this.currentSurfaceSnapshot();
      if (!snapshot || snapshot.key !== current.key) return;
      if (snapshot.state === "visible") {
        const latest = this.activeReviewTarget();
        if (latest) {
          void this.runInspection(() =>
            this.probeLateTarget(latest, epoch, current.key, lifecycle),
          );
        }
        return;
      }
      if (snapshot.state !== "hidden") return;
      this.lateHideRecheckTimer = setTimeout(() => {
        this.lateHideRecheckTimer = null;
        if (epoch !== this.sessionEpoch || lifecycle !== this.lateSurfaceLifecycle) return;
        const latestSnapshot = this.currentSurfaceSnapshot();
        if (
          !latestSnapshot ||
          latestSnapshot.key !== current.key ||
          latestSnapshot.state !== "hidden"
        ) {
          return;
        }
        const latest = this.activeReviewTarget();
        if (!latest) return;
        void this.runInspection(() => this.probeLateTarget(latest, epoch, current.key, lifecycle));
      }, LATE_HIDE_RECHECK_MS);
      this.lateHideRecheckTimer.unref?.();
    });
  }

  private clearLateHideRecheck(): void {
    if (this.lateHideRecheckTimer) clearTimeout(this.lateHideRecheckTimer);
    this.lateHideRecheckTimer = null;
  }

  private async probeLateTarget(
    target: ManagedReviewTarget,
    epoch: number,
    surfaceKey: string,
    lifecycle: number,
  ): Promise<"empty" | "handled" | "failed" | "stale"> {
    try {
      const inspected = await this.inspectTarget(target);
      if (epoch !== this.sessionEpoch) return "stale";
      if (inspected.status === "not-found") {
        this.recordLateProbeFailure(
          epoch,
          surfaceKey,
          lifecycle,
          "the managed Hunk session was not found",
        );
        return "failed";
      }
      if (inspected.status === "surface-changed") {
        this.recordLateProbeFailure(
          epoch,
          surfaceKey,
          lifecycle,
          "the managed Hunk surface changed",
        );
        return "failed";
      }
      if (!this.adoptInspectedSession(target, inspected.session)) {
        this.recordLateProbeFailure(
          epoch,
          surfaceKey,
          lifecycle,
          "the managed Hunk surface changed",
        );
        return "failed";
      }
      this.lateProbeFailure = null;
      if (inspected.status === "no-diff") return "empty";
      const sessionId = inspected.session.sessionId;
      const unseen = this.unseenNotes(sessionId, inspected.notes);
      if (unseen.length > 0) {
        this.submitDetectedNotes(sessionId, unseen, inspected.notes.length);
        return "handled";
      }
      return "empty";
    } catch (error) {
      if (epoch !== this.sessionEpoch) return "stale";
      this.recordLateProbeFailure(
        epoch,
        surfaceKey,
        lifecycle,
        error instanceof Error ? error.message : String(error),
      );
      return "failed";
    }
  }

  private recordLateProbeFailure(
    epoch: number,
    surfaceKey: string,
    lifecycle: number,
    detail: string,
  ): void {
    const existing = this.lateProbeFailure;
    if (
      existing?.epoch === epoch &&
      existing.surfaceKey === surfaceKey &&
      existing.lifecycle === lifecycle
    ) {
      return;
    }
    this.lateProbeFailure = { epoch, surfaceKey, lifecycle, detail, warned: false };
    this.emitLateProbeWarning();
  }

  private emitLateProbeWarning(): void {
    const failure = this.lateProbeFailure;
    const handler = this.lateProbeWarningHandler;
    if (!failure || failure.warned || !handler) return;
    failure.warned = true;
    try {
      handler(
        `Hunk comments were not inspected when the review was hidden (${failure.detail}); ` +
          "run /hunk feedback to retry before closing or replacing Hunk.",
      );
    } catch {
      // Notification failure must not affect probe recovery or create a retry loop.
    }
  }

  private async awaitCurrentDelivery(epoch: number): Promise<void> {
    for (;;) {
      const delivery = this.lateDelivery;
      if (!delivery || delivery.epoch !== epoch) return;
      await delivery.promise;
      if (this.lateDelivery === delivery) this.lateDelivery = null;
    }
  }

  private async dispatchLateNotes(retryUnconfirmed = false): Promise<void> {
    const handler = this.lateSubmissionHandler;
    if (!handler || this.lateDelivery || this.pendingReviewNotes.size === 0) return;
    const epoch = this.sessionEpoch;
    const pending = this.pendingReviewNotes;
    const batch = [...pending.entries()].filter(
      ([, entry]) => retryUnconfirmed || !entry.attempted,
    );
    if (batch.length === 0) return;

    // Mark before calling the fire-and-forget host boundary. A rejection or an
    // unconfirmed return must remain recoverable without immediately resending
    // the same batch in a tight loop. `/hunk feedback` opts into a retry.
    for (const [key, entry] of batch) {
      if (pending.get(key) === entry) entry.attempted = true;
    }

    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await handler(
          batch.map(([, entry]) => entry.note),
          {
            epoch,
            signal: controller.signal,
          },
        );
        // A retired completion may resolve successfully, but ownership of its
        // queue and dedupe records ended at the boundary.
        if (
          result.status !== "accepted" ||
          controller.signal.aborted ||
          epoch !== this.sessionEpoch ||
          pending !== this.pendingReviewNotes
        ) {
          return;
        }
        for (const [key, entry] of batch) {
          if (pending.get(key) !== entry) continue;
          pending.delete(key);
          this.submittedNoteKeys.add(key);
        }
      } catch {
        // Keep notes queued so /hunk feedback or session drain can recover them.
      }
    })();
    const delivery: LateDelivery = { epoch, controller, promise };
    this.lateDelivery = delivery;
    await promise;
    if (this.lateDelivery === delivery) this.lateDelivery = null;

    // Notes can be discovered while a delivery is in flight. Dispatch only
    // current-epoch entries never attempted; retired maps are never revisited.
    if (
      epoch === this.sessionEpoch &&
      pending === this.pendingReviewNotes &&
      [...pending.values()].some((entry) => !entry.attempted)
    ) {
      void this.dispatchLateNotes();
    }
  }

  private completeNoDiff(): void {
    this.coordinator.markReviewCompleteForRun();
    this.terminalNoDiffRevision = this.evidenceRevision;
    this.resetPlan(true);
  }

  private resetPlan(preserveNoDiff = false): void {
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.current = null;
    this.unresolved = false;
    if (!preserveNoDiff) this.terminalNoDiffRevision = null;
  }

  private noDiffResult(): HunkFeedbackResult {
    return {
      status: "no-diff",
      message: "Hunk reported no reviewable changes for any discovered repository.",
      notes: [],
    };
  }

  private unavailable(reason: string, detail?: string): HunkFeedbackResult {
    return {
      status: "unavailable",
      reason,
      message:
        reason === "not-tui"
          ? "Hunk review is available only in Pi's interactive TUI mode."
          : detail
            ? `Hunk review is unavailable (${reason}): ${detail}`
            : `Hunk review is unavailable (${reason}).`,
      notes: [],
    };
  }
}
