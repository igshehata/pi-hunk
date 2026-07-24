import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import {
  canonicalizePotentialPath,
  normalizeCandidatePath,
  pathIsInside,
  resolveLaunchDirectory,
} from "./path-routing.ts";

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

export type BlockingReviewResult =
  | { status: "submitted"; message: string; notes: HunkReviewNote[] }
  | { status: "approved"; message: string; notes: [] }
  | { status: "no-diff"; message: string; notes: [] }
  | { status: "target-required"; reason: string; message: string; notes: [] }
  | { status: "already-waiting"; message: string; notes: [] }
  | { status: "unavailable"; reason: string; message: string; notes: [] }
  | { status: "cancelled"; reason: string; message: string; notes: [] };

export type AutomaticReviewResult =
  | { status: "reviewable"; repoRoot: string; fileCount: number }
  | { status: "no-diff" }
  | { status: "target-required" }
  | { status: "no-evidence" }
  | { status: "unavailable"; reason: string; detail?: string };

export interface ReviewHandoffOptions {
  cwd: string;
  /** Pin subsequent probes to the exact Hunk session selected for this gate. */
  sessionId?: string;
  /** OS pid of the managed Pi-owned PTY leader, when available. */
  managedPid?: number;
  hunkBinary?: string;
  run?: HunkRunner;
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

type WaiterState = "routing" | "visible" | "probing";

interface Waiter {
  ctx: ExtensionContext;
  resolve: (result: BlockingReviewResult) => void;
  unsubscribe: () => void;
  removeAbort: () => void;
  state: WaiterState;
  signal?: AbortSignal;
  replacementTimer?: ReturnType<typeof setTimeout>;
}

export type ReviewSessionWaiter = (
  options: ManagedHunkSessionWaitOptions,
) => Promise<ManagedHunkSessionWaitResult>;

const SURFACE_REPLACEMENT_GRACE_MS = 250;

/** One blocking gate and one repository queue per loaded Pi extension/session. */
export class ReviewHandoffGate {
  private waiter: Waiter | null = null;
  private readonly submittedNoteKeys = new Set<string>();
  private readonly pending: ReviewCandidate[] = [];
  private readonly pendingKeys = new Set<string>();
  private current: CurrentRepository | null = null;
  private unresolved = false;
  private evidenceRevision = 0;
  private reviewedAny = false;
  private terminalNoDiffRevision: number | null = null;
  private sessionEpoch = 0;

  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly getConfig: () => HunkConfig,
    private readonly run?: HunkRunner,
    private readonly waitForSession: ReviewSessionWaiter = waitForManagedHunkSession,
  ) {
    coordinator.onReviewCancellation((reason) => this.cancel(reason));
  }

  isWaiting(): boolean {
    return this.waiter !== null;
  }

  resetSession(): void {
    this.sessionEpoch += 1;
    this.cancel("session-boundary");
    this.evidenceRevision = 0;
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

  async wait(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    explicitCwd?: string,
  ): Promise<BlockingReviewResult> {
    if (ctx.mode !== "tui") return this.unavailable("not-tui");
    if (this.waiter) return this.alreadyWaiting(ctx);
    if (signal?.aborted) return this.cancelled("abort-signal");
    const waitEpoch = this.sessionEpoch;

    if (explicitCwd !== undefined) {
      let target: string;
      try {
        target = normalizeCandidatePath(explicitCwd, ctx.cwd);
        // Validate that a safe existing launch directory can be derived before
        // mutating queue state.
        await resolveLaunchDirectory(target);
      } catch (error) {
        return this.unavailable(
          "invalid-target",
          error instanceof Error ? error.message : String(error),
        );
      }
      // Validation yields to the event loop. Recheck every admission condition
      // before mutating queue state or installing the single waiter.
      if (this.waiter) return this.alreadyWaiting(ctx);
      if (signal?.aborted) return this.cancelled("abort-signal");
      if (waitEpoch !== this.sessionEpoch) return this.cancelled("session-boundary");

      const key = target;
      if (this.terminalNoDiffRevision !== null && !this.pendingKeys.has(key)) {
        this.terminalNoDiffRevision = null;
        this.resetPlan();
      }
      this.addCandidate(target);
      // Explicit cwd is the agent's resolution for all pathless evidence seen
      // so far; later pathless mutations will set this flag again.
      this.unresolved = false;
    } else if (this.terminalNoDiffRevision !== null && this.pending.length === 0 && !this.current) {
      return this.noDiffResult();
    }

    if (!this.current && this.pending.length === 0) {
      if (this.unresolved) return this.targetRequired();
      // Preserve direct/manual hunk_review and /hunk feedback behavior when no
      // mutation evidence exists at all. Automatic pathless evidence takes the
      // explicit target-required branch above instead.
      this.addCandidate(ctx.cwd);
    }

    let resolveResult!: (value: BlockingReviewResult) => void;
    const result = new Promise<BlockingReviewResult>((done) => {
      resolveResult = done;
    });
    const onAbort = () => this.cancel("abort-signal");
    signal?.addEventListener("abort", onAbort, { once: true });
    const waiter: Waiter = {
      ctx,
      resolve: resolveResult,
      unsubscribe: () => {},
      removeAbort: () => signal?.removeEventListener("abort", onAbort),
      state: "routing",
      signal,
    };
    this.waiter = waiter;
    this.coordinator.setBlockingReview(true);
    waiter.unsubscribe = this.coordinator.onStateChange(() => this.observe(waiter));
    void this.advance(waiter);
    return result;
  }

  cancel(reason: string, detail?: string): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.finish(waiter, this.cancelled(reason, detail));
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

  private async advance(waiter: Waiter): Promise<void> {
    while (this.waiter === waiter) {
      waiter.state = "routing";
      try {
        const routed = await this.routeNext(waiter.ctx, "handoff", waiter.signal);
        if (this.waiter !== waiter) return;
        if (routed.status === "unavailable") {
          this.finish(
            waiter,
            routed.reason === "surface-not-live"
              ? this.cancelled("hunk-closed")
              : this.unavailable(routed.reason, routed.detail),
          );
          return;
        }
        if (routed.status === "no-diff") {
          this.current = null;
          if (routed.closeSurface) await this.coordinator.releaseSurfaceForRouting();
          if (this.waiter !== waiter) return;
          if (this.pending.length > 0) continue;
          if (this.unresolved) {
            this.finish(waiter, this.targetRequired());
            return;
          }
          if (this.reviewedAny) {
            this.completeApproved(waiter);
          } else {
            this.completeNoDiff();
            this.finish(waiter, this.noDiffResult());
          }
          return;
        }

        this.coordinator.adoptEarlySurfaceForRun();
        waiter.state = "visible";
        this.observe(waiter);
        return;
      } catch (error) {
        if (this.waiter !== waiter) return;
        this.finish(
          waiter,
          this.cancelled("open-failed", error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }
  }

  private async routeNext(
    ctx: ExtensionContext,
    source: "auto" | "live" | "recover" | "handoff",
    signal?: AbortSignal,
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
    // the target available for a later hunk_review retry.
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
      source !== "handoff" &&
      (before?.source === "manual" || before?.source === "shortcut") &&
      beforeLaunchCwd === launchCwd;
    if (source === "handoff") {
      await this.coordinator.enterReviewGate(ctx, config, launchCwd);
    } else if (!reuseManualSurface) {
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
      signal,
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

  private observe(waiter: Waiter): void {
    if (this.waiter !== waiter) return;
    const state = this.coordinator.getActiveInfo()?.state;
    if (waiter.state === "routing") return;
    if (waiter.state !== "visible") return;
    if (state === "hidden") {
      this.clearReplacementTimer(waiter);
      waiter.state = "probing";
      void this.probe(waiter);
      return;
    }
    if (state === "visible" || state === "starting") {
      this.clearReplacementTimer(waiter);
      return;
    }
    this.armReplacementTimer(waiter);
  }

  private armReplacementTimer(waiter: Waiter): void {
    if (waiter.replacementTimer) return;
    waiter.replacementTimer = setTimeout(() => {
      waiter.replacementTimer = undefined;
      if (this.waiter !== waiter || waiter.state !== "visible") return;
      const state = this.coordinator.getActiveInfo()?.state;
      if (!state || state === "closed" || state === "closing") this.cancel("hunk-closed");
    }, SURFACE_REPLACEMENT_GRACE_MS);
    waiter.replacementTimer.unref?.();
  }

  private clearReplacementTimer(waiter: Waiter): void {
    if (!waiter.replacementTimer) return;
    clearTimeout(waiter.replacementTimer);
    waiter.replacementTimer = undefined;
  }

  private noteKey(sessionId: string, note: HunkReviewNote): string {
    return `${sessionId}\0${note.noteId}`;
  }

  private async probe(waiter: Waiter): Promise<void> {
    const current = this.current;
    if (this.waiter !== waiter || waiter.state !== "probing" || !current) return;
    try {
      const config = this.getConfig();
      const refreshed = await this.waitForSession({
        cwd: current.repoRoot,
        sessionId: current.sessionId,
        managedPid: current.managedPid,
        hunkBinary: config.hunk.command,
        run: this.run,
        signal: waiter.signal,
      });
      if (this.waiter !== waiter) return;
      if (refreshed.status === "not-found") {
        this.cancel("hunk-died");
        return;
      }
      if (refreshed.status === "no-diff") {
        this.current = null;
        if (current.closeWhenEmpty) await this.coordinator.releaseSurfaceForRouting();
        if (this.waiter !== waiter) return;
        if (this.pending.length > 0) {
          waiter.state = "routing";
          void this.advance(waiter);
          return;
        }
        if (this.unresolved) {
          this.finish(waiter, this.targetRequired());
          return;
        }
        if (this.reviewedAny) this.completeApproved(waiter);
        else {
          this.completeNoDiff();
          this.finish(waiter, this.noDiffResult());
        }
        return;
      }

      const review = await readHunkReviewForSession(refreshed.session, {
        cwd: current.repoRoot,
        sessionId: current.sessionId,
        managedPid: current.managedPid,
        hunkBinary: config.hunk.command,
        run: this.run,
      });
      if (this.waiter !== waiter) return;
      current.sessionId = review.sessionId;
      current.managedPid = review.pid;
      current.fileCount = review.fileCount;
      const unseenNotes = review.notes.filter(
        (note) => !this.submittedNoteKeys.has(this.noteKey(review.sessionId, note)),
      );
      if (unseenNotes.length > 0) {
        for (const note of unseenNotes) {
          this.submittedNoteKeys.add(this.noteKey(review.sessionId, note));
        }
        this.finish(waiter, {
          status: "submitted",
          message:
            unseenNotes.length === review.notes.length
              ? review.message
              : `${unseenNotes.length} new Hunk review note(s); ${
                  review.notes.length - unseenNotes.length
                } already submitted in this Pi extension.`,
          notes: unseenNotes,
        });
        return;
      }

      this.reviewedAny = true;
      this.current = null;
      if (this.pending.length > 0) {
        waiter.state = "routing";
        void this.advance(waiter);
        return;
      }
      if (this.unresolved) {
        this.finish(waiter, this.targetRequired());
        return;
      }
      this.completeApproved(waiter);
    } catch (error) {
      this.cancel("comment-probe-failed", error instanceof Error ? error.message : String(error));
    }
  }

  private completeApproved(waiter: Waiter): void {
    this.coordinator.markReviewCompleteForRun();
    this.resetPlan();
    this.finish(waiter, {
      status: "approved",
      message:
        "No new Hunk user notes were found across all discovered repositories; hiding Hunk is treated as approval.",
      notes: [],
    });
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
    this.reviewedAny = false;
    if (!preserveNoDiff) this.terminalNoDiffRevision = null;
  }

  private alreadyWaiting(ctx: ExtensionContext): BlockingReviewResult {
    return {
      status: "already-waiting",
      message: `A Hunk review is already waiting for ${this.current?.repoRoot ?? ctx.cwd}.`,
      notes: [],
    };
  }

  private noDiffResult(): BlockingReviewResult {
    return {
      status: "no-diff",
      message: "Hunk reported no reviewable changes for any discovered repository.",
      notes: [],
    };
  }

  private targetRequired(): BlockingReviewResult {
    return {
      status: "target-required",
      reason: "pathless-mutation",
      message:
        "Successful pathless mutation evidence has no safe review target. Call hunk_review again with cwd set to the repository or a path inside it.",
      notes: [],
    };
  }

  private cancelled(reason: string, detail?: string): BlockingReviewResult {
    return {
      status: "cancelled",
      reason,
      message: detail
        ? `Hunk review cancelled (${reason}): ${detail}`
        : `Hunk review cancelled (${reason}).`,
      notes: [],
    };
  }

  private unavailable(reason: string, detail?: string): BlockingReviewResult {
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

  private finish(waiter: Waiter, value: BlockingReviewResult): void {
    if (this.waiter !== waiter) return;
    this.waiter = null;
    this.clearReplacementTimer(waiter);
    waiter.unsubscribe();
    waiter.removeAbort();
    this.coordinator.setBlockingReview(false);
    waiter.resolve(value);
  }
}

/** Register the blocking, read-only review gate tool. */
export function registerHunkReviewTool(pi: ExtensionAPI, gate: ReviewHandoffGate): void {
  pi.registerTool({
    name: "hunk_review",
    label: "Hunk Review",
    description:
      "Open Hunk for inferred mutation targets (or an explicit cwd) and wait for the human to hide it. Returns only previously unseen user notes. Read-only: never create, edit, apply, resolve, or clear comments.",
    promptSnippet: "Wait for fresh human review notes in Hunk (read-only)",
    promptGuidelines: [
      "Call hunk_review when review is requested and address every returned note comment-by-comment.",
      "Pass cwd when changes came from a pathless shell command or after changing directories and the target cannot be inferred.",
      "Treat status=approved or status=no-diff as terminal; do not keep waiting or retry unless new changes need review.",
      "Never create, edit, apply, resolve, or clear Hunk comments; hunk_review is read-only.",
    ],
    parameters: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Optional repository or path to review. Relative values resolve from Pi's startup cwd.",
        },
      },
      additionalProperties: false,
    } as const,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = (params as { cwd?: string }).cwd;
      const value = await gate.wait(ctx, signal, cwd);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });
}
