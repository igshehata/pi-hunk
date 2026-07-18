import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HunkConfig } from "./config.ts";
import type { ReviewCoordinator } from "./coordinator.ts";
import { findLiveHunkSession, runHunk, type HunkRunner } from "./hunk-session.ts";

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
  | { status: "live"; sessionId: string; pid: number; message: string; notes: HunkReviewNote[] };

export type BlockingReviewResult =
  | { status: "submitted"; message: string; notes: HunkReviewNote[] }
  | { status: "approved"; message: string; notes: [] }
  | { status: "already-waiting"; message: string; notes: [] }
  | { status: "unavailable"; reason: string; message: string; notes: [] }
  | { status: "cancelled"; reason: string; message: string; notes: [] };

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
  const stdout = await runHunk(
    ["session", "comment", "list", session.sessionId, "--type", "user", "--json"],
    options,
  );
  const notes = parseComments(stdout).map(shapeComment);
  return {
    status: "live",
    sessionId: session.sessionId,
    pid: session.pid,
    message:
      notes.length === 0
        ? "The live Hunk review has no open user notes."
        : `${notes.length} open Hunk review note(s).`,
    notes,
  };
}

type HandoffState = "opening" | "awaiting-live" | "visible" | "hidden" | "probing";
type SurfaceObservation = "absent" | "starting" | "visible" | "hidden" | "closing";
type HandoffAction = "stay" | "visible" | "hidden" | "probe" | "cancel";
const SURFACE_REPLACEMENT_GRACE_MS = 250;

const HANDOFF_TRANSITIONS: Record<HandoffState, Record<SurfaceObservation, HandoffAction>> = {
  opening: {
    absent: "stay",
    starting: "stay",
    visible: "visible",
    hidden: "hidden",
    closing: "cancel",
  },
  "awaiting-live": {
    absent: "cancel",
    starting: "cancel",
    visible: "visible",
    hidden: "hidden",
    closing: "cancel",
  },
  visible: {
    absent: "stay",
    starting: "stay",
    visible: "stay",
    hidden: "probe",
    closing: "stay",
  },
  hidden: {
    absent: "stay",
    starting: "stay",
    visible: "visible",
    hidden: "stay",
    closing: "stay",
  },
  probing: {
    absent: "cancel",
    starting: "cancel",
    visible: "stay",
    hidden: "stay",
    closing: "cancel",
  },
};

interface Waiter {
  cwd: string;
  sessionId?: string;
  managedPid?: number;
  resolve: (result: BlockingReviewResult) => void;
  unsubscribe: () => void;
  removeAbort: () => void;
  state: HandoffState;
  replacementTimer?: ReturnType<typeof setTimeout>;
}

/** One blocking gate per loaded Pi extension/session. */
export class ReviewHandoffGate {
  private waiter: Waiter | null = null;
  private readonly submittedNoteKeys = new Set<string>();
  constructor(
    private readonly coordinator: ReviewCoordinator,
    private readonly getConfig: () => HunkConfig,
    private readonly run?: HunkRunner,
  ) {
    coordinator.onReviewCancellation((reason) => this.cancel(reason));
  }

  isWaiting(): boolean {
    return this.waiter !== null;
  }

  async wait(ctx: ExtensionContext, signal?: AbortSignal): Promise<BlockingReviewResult> {
    if (ctx.mode !== "tui") return this.unavailable("not-tui");
    if (this.waiter)
      return {
        status: "already-waiting",
        message: `A Hunk review is already waiting for ${this.waiter.cwd}.`,
        notes: [],
      };
    if (signal?.aborted) return this.cancelled("abort-signal");

    let resolve!: (value: BlockingReviewResult) => void;
    const result = new Promise<BlockingReviewResult>((done) => {
      resolve = done;
    });
    const onAbort = () => this.cancel("abort-signal");
    signal?.addEventListener("abort", onAbort, { once: true });
    const waiter: Waiter = {
      cwd: ctx.cwd,
      resolve,
      unsubscribe: () => {},
      removeAbort: () => signal?.removeEventListener("abort", onAbort),
      state: "opening",
    };
    this.waiter = waiter;
    this.coordinator.setBlockingReview(true);
    waiter.unsubscribe = this.coordinator.onStateChange(() => this.observe(ctx, waiter));

    // Do not await surface startup here: close/shutdown/AbortSignal must settle the
    // tool even when a provider's open operation is still blocked.  Keep the
    // startup rejection handled, and ignore its eventual outcome after this
    // particular waiter has already been cancelled or replaced.
    void this.coordinator.enterReviewGate(ctx, this.getConfig()).then(
      () => {
        if (this.waiter === waiter) {
          if (waiter.state === "opening") waiter.state = "awaiting-live";
          this.observe(ctx, waiter);
        }
      },
      (error: unknown) => {
        if (this.waiter === waiter)
          this.cancel("open-failed", error instanceof Error ? error.message : String(error));
      },
    );
    return result;
  }

  cancel(reason: string, detail?: string): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.finish(waiter, this.cancelled(reason, detail));
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

  private unavailable(reason: string): BlockingReviewResult {
    return {
      status: "unavailable",
      reason,
      message: "Hunk review is available only in Pi's interactive TUI mode.",
      notes: [],
    };
  }

  private observe(ctx: ExtensionContext, waiter: Waiter): void {
    if (this.waiter !== waiter) return;
    const info = this.coordinator.getActiveInfo();
    const surfaceState = info?.state;
    const observation: SurfaceObservation =
      !info || surfaceState === undefined || surfaceState === "closed" ? "absent" : surfaceState;
    const pid = info?.pid;
    if (!waiter.sessionId && pid !== undefined && Number.isInteger(pid) && pid > 0) {
      waiter.managedPid = pid;
    }

    if (observation === "starting" || observation === "visible" || observation === "hidden") {
      this.clearReplacementTimer(waiter);
    } else if (
      (waiter.state === "visible" || waiter.state === "hidden") &&
      (observation === "absent" || observation === "closing")
    ) {
      this.armReplacementTimer(waiter);
    }

    const action = HANDOFF_TRANSITIONS[waiter.state][observation];
    switch (action) {
      case "stay":
        return;
      case "visible":
        waiter.state = "visible";
        return;
      case "hidden":
        waiter.state = "hidden";
        return;
      case "probe":
        waiter.state = "probing";
        void this.probe(ctx, waiter);
        return;
      case "cancel":
        this.cancel("hunk-closed");
        return;
    }
  }

  private armReplacementTimer(waiter: Waiter): void {
    if (waiter.replacementTimer) return;
    waiter.replacementTimer = setTimeout(() => {
      waiter.replacementTimer = undefined;
      if (this.waiter !== waiter) return;
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

  private async probe(ctx: ExtensionContext, waiter: Waiter): Promise<void> {
    if (this.waiter !== waiter || waiter.state !== "probing") return;
    try {
      const review = await readHunkReview({
        cwd: waiter.cwd,
        sessionId: waiter.sessionId,
        managedPid: waiter.managedPid,
        hunkBinary: this.getConfig().hunk.command,
        run: this.run,
      });
      if (this.waiter !== waiter) return;
      if (review.status === "no-live-session") {
        this.cancel("hunk-died");
        return;
      }
      waiter.sessionId = review.sessionId;
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
      this.coordinator.markReviewCompleteForRun();
      this.finish(waiter, {
        status: "approved",
        message:
          review.notes.length === 0
            ? "No Hunk user notes were found; hiding Hunk is treated as approval."
            : "No new Hunk user notes were found; hiding Hunk is treated as approval.",
        notes: [],
      });
    } catch (error) {
      this.cancel("comment-probe-failed", error instanceof Error ? error.message : String(error));
    }
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
      "Open Hunk and wait for the human to hide it. Returns only previously unseen user notes; hiding with no new notes returns approved. Read-only: never create, edit, apply, resolve, or clear comments.",
    promptSnippet: "Wait for fresh human review notes in Hunk (read-only)",
    promptGuidelines: [
      "Call hunk_review when review is requested and address every returned note comment-by-comment.",
      "Treat status=approved as the human's no-new-findings approval; do not keep waiting or retry unless a new review is requested.",
      "Never create, edit, apply, resolve, or clear Hunk comments; hunk_review is read-only.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false } as const,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const value = await gate.wait(ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
    },
  });
}
