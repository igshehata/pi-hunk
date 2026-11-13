export type View = "diff" | "show" | "log" | "branch" | "codebase";

export type Delivery = "steer" | "followUp" | "interrupt";

/**
 * `static`: Hunk takes over the host's terminal and comments are handed off when it closes.
 * `multiplexer`: Hunk opens in a sibling pane (Tern, Rex, or Herdr) and every comment change is
 * delivered as it is saved.
 */
export type Mode = "static" | "multiplexer";

export interface Config {
  readonly prefix: string;
  readonly diff: string;
  readonly show: string;
  readonly log: string;
  readonly branch: string;
  readonly codebase: string;
  readonly delivery: Delivery;
  readonly mode: Mode;
  /** Base branch the `branch` view compares against; absent means detect it at launch. */
  readonly base?: string;
}

/** Private launch data passed only to the Hunk process owned by this extension. */
export interface ReviewLaunch {
  readonly cwd: string;
  readonly view: View;
  readonly config: Config;
  readonly journal: string;
  /** The merge-base SHA resolved at launch; absent when no base branch could be found. */
  readonly base?: string;
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
  /**
   * `hunk diff <merge-base>`: old side is the commit where the branch left its base, new side is
   * the working tree.
   */
  | {
      readonly kind: "branch";
      /** Full merge-base SHA of the branch and its base branch. */
      readonly base: string;
      /** Git's unique abbreviation length for `base`; the handoff shows it this short. */
      readonly abbrev: number;
    }
  /** `hunk diff <empty tree>`: old side is empty, new side is the working tree. */
  | { readonly kind: "codebase" }
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
  /**
   * Multiplexer mode only: the working-tree file no longer matched the reviewed lines when this
   * comment was saved, so its line numbers refer to the reviewed version, not the file on disk.
   */
  readonly stale?: true;
  readonly body: string;
}

/** Saved mutations, not visible-note snapshots: switching can hide retained notes. */
export type ReviewEvent =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Upsert"; readonly note: ReviewNote }
  | { readonly _tag: "Remove"; readonly id: string }
  | { readonly _tag: "Failure"; readonly message: string }
  /** Multiplexer mode only: written by the pane's launcher script after Hunk exits. */
  | { readonly _tag: "Exited"; readonly status: number };

/** Private child status: capture failed, so a partial journal must not be submitted. */
export const CAPTURE_FAILURE_EXIT_CODE = 74;
