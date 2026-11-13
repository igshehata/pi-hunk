export type View = "diff" | "show" | "log";

export type Delivery = "steer" | "followUp" | "interrupt";

export interface Config {
  readonly prefix: string;
  readonly diff: string;
  readonly show: string;
  readonly log: string;
  readonly delivery: Delivery;
}

/** Private launch data passed only to the Hunk process owned by this extension. */
export interface ReviewLaunch {
  readonly cwd: string;
  readonly view: View;
  readonly config: Config;
  readonly journal: string;
}

export const REVIEW_ENV = "PI_HUNK_REVIEW";

/** The exact code version a comment's line ranges refer to. */
export type Revision =
  /** `hunk diff`: old side is the index (staged content), new side is the working tree. */
  | { readonly kind: "working-tree" }
  | {
      readonly kind: "commit";
      /** Full commit SHA. */
      readonly commit: string;
      /** Full parent SHA; absent for a root commit. */
      readonly parent?: string;
      /** Git's unique abbreviation length for these SHAs; the handoff shows them this short. */
      readonly abbrev: number;
    }
  | {
      readonly kind: "range";
      /** Full `from` SHA; absent when the range starts at the empty tree (root commit). */
      readonly from?: string;
      /** Full `to` SHA. */
      readonly to: string;
      /** Git's unique abbreviation length for these SHAs; the handoff shows them this short. */
      readonly abbrev: number;
    }
  /** Hunk's own description, verbatim, when the revision could not be verified. */
  | { readonly kind: "unresolved"; readonly description: string };

export interface ReviewNote {
  readonly id: string;
  readonly parentId?: string;
  /** The view where this comment was first saved. */
  readonly view: View;
  /** The revision recorded when this comment was first saved, kept across later edits. */
  readonly revision: Revision;
  readonly path: string;
  /** The path this file had in the reviewed revision, for a renamed file. */
  readonly previousPath?: string;
  readonly oldRange?: readonly [number, number];
  readonly newRange?: readonly [number, number];
  /** Unified-diff lines of the reviewed patch around this comment. */
  readonly excerpt?: string;
  readonly body: string;
}

/** Saved mutations, not visible-note snapshots: switching can hide retained notes. */
export type ReviewEvent =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Upsert"; readonly note: ReviewNote }
  | { readonly _tag: "Remove"; readonly id: string }
  | { readonly _tag: "Failure"; readonly message: string };

/** Private child status: capture failed, so a partial journal must not be submitted. */
export const CAPTURE_FAILURE_EXIT_CODE = 74;
