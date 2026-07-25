import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettledEvidence } from "./change-detector.ts";
import type { HunkConfig } from "./config.ts";
import type { ReviewCoordinator } from "./coordinator.ts";
import {
  findLiveHunkSession,
  runHunk,
  waitForManagedHunkSession,
  type HunkRunner,
  type LiveHunkSession,
  type ManagedHunkSessionWaitOptions,
  type ManagedHunkSessionWaitResult,
} from "./hunk-session.ts";
import { canonicalizePotentialPath, pathIsInside, resolveLaunchDirectory } from "./path-routing.ts";

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

export type AutomaticReviewResult =
  | { status: "reviewable"; repoRoot: string; fileCount: number }
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

interface ReviewCandidate {
  target: string;
  key: string;
  /** Preserve current-run surface ownership across transient routing failures. */
  closeWhenEmpty: boolean;
}

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
}

interface PendingReviewNote {
  note: HunkReviewNote;
}

type ManagedReviewInspection =
  | { status: "not-found" }
  | { status: "no-diff" }
  | {
      status: "reviewable";
      sessionId: string;
      pid: number;
      fileCount: number;
      notes: HunkReviewNote[];
    };

export type LateReviewSubmissionHandler = (notes: HunkReviewNote[]) => Promise<void> | void;

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
  private readonly pendingReviewNotes = new Map<string, PendingReviewNote>();
  private lateSubmissionHandler: LateReviewSubmissionHandler | null = null;
  private lateStateUnsubscribe: (() => void) | null = null;
  private lateSurfaceSnapshot: { key: string; state: string } | null = null;
  private lateDelivery: Promise<void> | null = null;

  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly getConfig: () => HunkConfig,
    private readonly run?: HunkRunner,
    private readonly waitForSession: ReviewSessionWaiter = waitForManagedHunkSession,
  ) {}

  /** Deliver unseen comments whenever a managed Hunk surface is hidden. */
  onLateSubmission(handler: LateReviewSubmissionHandler): () => void {
    this.lateSubmissionHandler = handler;
    if (!this.lateStateUnsubscribe) {
      this.lateSurfaceSnapshot = this.currentSurfaceSnapshot();
      this.lateStateUnsubscribe = this.coordinator.onStateChange(() => this.observeLateSurface());
    }
    void this.dispatchLateNotes();
    return () => {
      if (this.lateSubmissionHandler !== handler) return;
      this.lateSubmissionHandler = null;
      this.lateStateUnsubscribe?.();
      this.lateStateUnsubscribe = null;
      this.lateSurfaceSnapshot = null;
    };
  }

  resetSession(): void {
    this.sessionEpoch += 1;
    this.evidenceRevision = 0;
    this.pendingReviewNotes.clear();
    this.lateSurfaceSnapshot = this.currentSurfaceSnapshot();
    this.resetPlan();
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

    for (;;) {
      const routed = await this.routeNext(ctx, source);
      if (routed.status === "unavailable") return routed;
      if (routed.status === "reviewable") {
        this.coordinator.adoptEarlySurfaceForRun();
        return {
          status: "reviewable",
          repoRoot: routed.repository.repoRoot,
          fileCount: routed.repository.fileCount,
        };
      }

      this.current = null;
      if (routed.closeSurface) await this.coordinator.releaseSurfaceForRouting();
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
    if (this.pending.length === 0) return { status: "no-evidence" };
    this.current = null;
    return this.presentAutomatic(ctx, "auto");
  }

  private addCandidate(target: string): void {
    const key = target;
    if (this.current?.candidate.key === key || this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.pending.push({ target, key, closeWhenEmpty: false });
  }

  private removeCandidate(candidate: ReviewCandidate): void {
    const index = this.pending.findIndex((entry) => entry.key === candidate.key);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.pendingKeys.delete(candidate.key);
  }

  private async routeNext(
    ctx: ExtensionContext,
    source: "auto" | "live" | "recover",
  ): Promise<
    | { status: "reviewable"; repository: CurrentRepository }
    | { status: "no-diff"; closeSurface: boolean }
    | { status: "unavailable"; reason: string; detail?: string }
  > {
    const routeEpoch = this.sessionEpoch;
    const staleRoute = () =>
      ({
        status: "unavailable",
        reason: "session-boundary",
        detail: "The Pi session changed while Hunk routing was in progress.",
      }) as const;
    const isCurrentRoute = () => routeEpoch === this.sessionEpoch;

    const existing = this.current;
    // Peek rather than consume: launch/session-registration failures must leave
    // the target available for a later routing retry.
    const candidate = existing?.candidate ?? this.pending[0];
    if (!candidate) {
      return { status: "unavailable", reason: "no-review-target" };
    }

    let launchCwd: string;
    try {
      launchCwd = await resolveLaunchDirectory(candidate.target);
    } catch (error) {
      return {
        status: "unavailable",
        reason: "invalid-target",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!isCurrentRoute()) return staleRoute();

    const before = this.coordinator.getActiveInfo();
    const beforeLaunchCwd = before ? await canonicalizePotentialPath(before.launchCwd) : undefined;
    if (!isCurrentRoute()) return staleRoute();
    const config = this.getConfig();
    const reuseManualSurface =
      (before?.source === "manual" || before?.source === "shortcut") &&
      beforeLaunchCwd === launchCwd;
    if (!reuseManualSurface) {
      await this.coordinator.ensureOpen(ctx, config, config.hunk.args, source, launchCwd);
    }
    if (!isCurrentRoute()) return staleRoute();
    const info = this.coordinator.getActiveInfo();
    if (!info || (info.state !== "visible" && info.state !== "hidden")) {
      return { status: "unavailable", reason: "surface-not-live" };
    }
    candidate.closeWhenEmpty =
      candidate.closeWhenEmpty ||
      existing?.closeWhenEmpty === true ||
      !before ||
      before.argsKey !== info.argsKey ||
      (before.pid !== undefined && info.pid !== undefined && before.pid !== info.pid) ||
      this.coordinator.isEarlySurfaceOwnedForRun();

    const managedPid = info.pid;
    if (managedPid === undefined || !Number.isInteger(managedPid) || managedPid <= 0) {
      return {
        status: "unavailable",
        reason: "managed-pid-missing",
        detail: "The Pi-owned Hunk process did not expose a valid PID.",
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
      };
    }

    const session = lookup.session;
    if (session.pid !== managedPid) {
      return {
        status: "unavailable",
        reason: "managed-session-mismatch",
        detail: `Hunk reported pid ${session.pid} for managed pid ${managedPid}.`,
      };
    }
    if (!session.repoRoot) {
      return {
        status: "unavailable",
        reason: "repo-root-missing",
        detail: `Managed Hunk session ${session.sessionId} did not report a repository root.`,
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
      };
    }

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
      return { status: "no-diff", closeSurface: repository.closeWhenEmpty };
    }
    return { status: "reviewable", repository };
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

    target.sessionId = refreshed.session.sessionId;
    target.repoRoot = refreshed.session.repoRoot;
    target.fileCount = refreshed.session.fileCount;
    this.coordinator.adoptManagedSession(refreshed.session);
    if (refreshed.status === "no-diff") return { status: "no-diff" };

    const review = await readHunkReviewForSession(refreshed.session, {
      cwd: refreshed.session.repoRoot ?? refreshed.session.cwd,
      sessionId: refreshed.session.sessionId,
      managedPid: refreshed.session.pid,
      hunkBinary: config.hunk.command,
      run: this.run,
      signal,
    });
    return {
      status: "reviewable",
      sessionId: review.sessionId,
      pid: review.pid,
      fileCount: review.fileCount,
      notes: review.notes,
    };
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
        this.pendingReviewNotes.set(key, { note });
      }
    }
    void this.dispatchLateNotes();
    return result;
  }

  private async runReviewAction(ctx: ExtensionContext): Promise<HunkFeedbackResult> {
    if (ctx.mode !== "tui") return this.unavailable("not-tui");
    if (this.lateDelivery) await this.lateDelivery;

    const queuedEntries = [...this.pendingReviewNotes.entries()];
    if (queuedEntries.length > 0) {
      await this.dispatchLateNotes();
      const delivered = queuedEntries.every(
        ([key, entry]) => this.pendingReviewNotes.get(key) !== entry,
      );
      return delivered
        ? this.submittedResult(queuedEntries.map(([, entry]) => entry.note))
        : this.pendingResult(
            "Fresh Hunk notes remain queued; run /hunk feedback if automatic delivery keeps failing.",
          );
    }

    return this.runInspection(async () => {
      const actionEpoch = this.sessionEpoch;
      const target: ManagedReviewTarget | null = this.current ?? this.activeReviewTarget();
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
        if (inspected.status === "no-diff") {
          if (this.current === target) {
            const current = this.current;
            this.current = null;
            if (current.closeWhenEmpty) await this.coordinator.releaseSurfaceForRouting();
            if (this.pending.length === 0 && !this.unresolved) this.completeNoDiff();
          }
          return this.noDiffResult();
        }

        target.sessionId = inspected.sessionId;
        target.managedPid = inspected.pid;
        target.fileCount = inspected.fileCount;
        const unseen = this.unseenNotes(inspected.sessionId, inspected.notes);
        if (unseen.length === 0) {
          return this.pendingResult("No new Hunk notes were found.");
        }

        const result = this.submitDetectedNotes(
          inspected.sessionId,
          unseen,
          inspected.notes.length,
        );
        if (this.lateDelivery) await this.lateDelivery;
        return unseen.some((note) =>
          this.pendingReviewNotes.has(this.noteKey(inspected.sessionId, note)),
        )
          ? this.pendingResult(
              "Fresh Hunk notes remain queued; run /hunk feedback if automatic delivery keeps failing.",
            )
          : result;
      } catch (error) {
        return this.unavailable(
          "comment-probe-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
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

  private observeLateSurface(): void {
    const previous = this.lateSurfaceSnapshot;
    const current = this.currentSurfaceSnapshot();
    this.lateSurfaceSnapshot = current;
    if (
      !previous ||
      !current ||
      previous.key !== current.key ||
      previous.state !== "visible" ||
      current.state !== "hidden"
    ) {
      return;
    }
    const target = this.activeReviewTarget();
    if (!target) return;
    const epoch = this.sessionEpoch;
    void this.runInspection(() => this.probeLateTarget(target, epoch));
  }

  private async probeLateTarget(target: ManagedReviewTarget, epoch: number): Promise<void> {
    try {
      const inspected = await this.inspectTarget(target);
      if (epoch !== this.sessionEpoch || inspected.status !== "reviewable") return;
      const active = this.activeReviewTarget();
      if (
        !active ||
        active.managedPid !== inspected.pid ||
        (active.sessionId !== undefined && active.sessionId !== inspected.sessionId)
      ) {
        return;
      }
      const unseen = this.unseenNotes(inspected.sessionId, inspected.notes);
      if (unseen.length > 0) {
        this.submitDetectedNotes(inspected.sessionId, unseen, inspected.notes.length);
      }
    } catch {
      // /hunk feedback remains the explicit recovery path after a failed late probe.
    }
  }

  private async dispatchLateNotes(): Promise<void> {
    const handler = this.lateSubmissionHandler;
    if (!handler || this.lateDelivery || this.pendingReviewNotes.size === 0) return;
    const batch = [...this.pendingReviewNotes.entries()];
    let delivered = false;
    const delivery = (async () => {
      try {
        await handler(batch.map(([, entry]) => entry.note));
        delivered = true;
        for (const [key, entry] of batch) {
          if (this.pendingReviewNotes.get(key) !== entry) continue;
          this.pendingReviewNotes.delete(key);
          this.submittedNoteKeys.add(key);
        }
      } catch {
        // Keep the notes queued so /hunk feedback can recover them.
      }
    })();
    this.lateDelivery = delivery;
    await delivery;
    if (this.lateDelivery === delivery) this.lateDelivery = null;
    if (delivered && this.pendingReviewNotes.size > 0) void this.dispatchLateNotes();
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
