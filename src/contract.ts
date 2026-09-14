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

export interface ReviewNote {
  readonly id: string;
  readonly parentId?: string;
  /** The view where this comment was first saved. */
  readonly view: View;
  /** Hunk's original changeset context for a history-selected review. */
  readonly source?: { readonly title: string; readonly label: string };
  readonly path: string;
  readonly oldRange?: readonly [number, number];
  readonly newRange?: readonly [number, number];
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
