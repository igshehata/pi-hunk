import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  matchesKeyChord,
  parseKeyChord,
  type ExtensionContext,
  type ExtensionKeyEvent,
  type ExtensionReviewNote,
  type ExtensionReviewSnapshotNote,
  type ExtensionStatusLineControls,
  type ExtensionStatusSpan,
  type HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  CAPTURE_FAILURE_EXIT_CODE,
  REVIEW_ENV,
  type ReviewEvent,
  type ReviewLaunch,
  type ReviewNote,
  type Revision,
  type View,
} from "./contract.js";
import { parseConfig } from "./config.js";
import { excerptFor, newSideLines } from "./excerpt.js";

/**
 * View lifecycle of one review.
 *
 * `Reviewing` holds the mounted view. `Switching` means a reconciler is reloading Hunk; it is
 * also the single-slot inbox for newer requests, so a newer request supersedes the in-flight
 * reload instead of queueing behind it. `Switching` always belongs to a `Running` registration:
 * one torn down mid-reload leaves the switch pending, and the registration that replaces it
 * resumes the reconciler, confirming first whatever Hunk reports as mounted. `Failed` is
 * terminal capture failure: the journal must not be submitted and no view may be requested
 * anymore.
 */
type ReviewState =
  | { readonly _tag: "Reviewing"; readonly view: View }
  | {
      readonly _tag: "Switching";
      /** View Hunk has confirmed mounted; the previous review until a replacement mounts. */
      readonly mounted: View;
      /** View the in-flight reload was asked to load. */
      readonly target: View;
      /** Latest requested view; a newer request replaces it, nothing queues. */
      readonly requested: View;
    }
  | { readonly _tag: "Failed"; readonly message: string };

/** A review state that can still capture notes and accept view requests. */
type ActiveReviewState = Exclude<ReviewState, { readonly _tag: "Failed" }>;

/** One view request either starts a reconciler, feeds the running one, or changes nothing. */
type SwitchRequest =
  | { readonly _tag: "Started"; readonly state: ReviewState }
  | { readonly _tag: "Queued"; readonly state: ReviewState }
  | { readonly _tag: "Ignored" };

/**
 * How a switch enters its reconciler. `Known` means the view the state records is the one Hunk
 * shows; `Interrupted` means the reload a torn-down registration abandoned may have mounted a
 * different view, so that record cannot be trusted until the reconciler reloads again.
 */
type SwitchEntry = { readonly _tag: "Known" } | { readonly _tag: "Interrupted" };

/**
 * Registration lifecycle of this extension instance inside Hunk's registry. Only a `Running`
 * registration writes journal events, records notes, or switches views. `Stopped` is terminal:
 * every handler this registration registered becomes a no-op and its in-flight CLI work is
 * cancelled, so a registry replacement starts from a registration that cannot act again.
 */
type BridgeState =
  | { readonly _tag: "Registered" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Stopped" };

/**
 * Navigation model of a review, fixed at launch. A history-selected (`log`) review is a dead
 * end: Hunk opened the reviewer on a past range, so diff/show would misdescribe what is loaded,
 * and the log key is the way back to the host. Diff and show reviews switch between both.
 */
type Navigation = { readonly _tag: "History" } | { readonly _tag: "SwitchableViews" };

/** The Hunk session owned by this process; resolved once, then reused by every reload. */
type SessionState = { readonly _tag: "Unknown" } | { readonly _tag: "Owned"; readonly id: string };

/** One file of the mounted changeset: its exact patch, and its path in the reviewed revision. */
interface ReviewedFile {
  readonly patch: string;
  readonly previousPath?: string;
}

/**
 * Changeset lifecycle. Nothing can be captured before Hunk mounts one: a saved note needs the
 * revision it was saved against and the patch its excerpt is cut from. One transition replaces
 * the whole table, so a revision can never disagree with the files it describes.
 *
 * `Reading` is the mounted changeset whose revision git is still resolving. Hunk mounts and
 * paints it immediately, so a note can be saved before the revision lands; such a save waits for
 * this exact resolution rather than reading a revision this changeset does not have. `key`
 * identifies what the revision was derived from (the view and Hunk's title), so remounting the
 * same changeset reuses its revision instead of querying git again.
 */
type ChangesetState =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Present";
      readonly key: string;
      readonly revision: Revision;
      readonly files: ReadonlyMap<string, ReviewedFile>;
    }
  | {
      readonly _tag: "Reading";
      readonly key: string;
      readonly revision: Promise<Revision>;
      readonly files: ReadonlyMap<string, ReviewedFile>;
    };

/** The evidence a note freezes at its first save; later edits replace the body only. */
interface FrozenNote {
  readonly view: View;
  readonly revision: Revision;
  readonly previousPath?: string;
  readonly excerpt?: string;
}

/**
 * Note lifecycle. Hunk reports a note's public path through note_created/note_edited before
 * note_changed commits it, so a note is either `Located` (path known, not journaled yet) or
 * `Saved` (journaled, its evidence frozen). A removal drops the record.
 */
type NoteState =
  | { readonly _tag: "Located"; readonly fileId: string; readonly path: string }
  | {
      readonly _tag: "Saved";
      /** Latest public path Hunk reported; a newer report wins over the journaled one. */
      readonly fileId: string;
      readonly path: string;
      readonly frozen: FrozenNote;
    };

interface Review {
  readonly launch: ReviewLaunch;
  state: ReviewState;
  session: SessionState;
  changeset: ChangesetState;
  /** noteId → capture record, so a location and its journal entry cannot diverge. */
  readonly notes: Map<string, NoteState>;
}

/** The one control multiplexer mode paints from; a context without it is skipped silently. */
interface StatusLineHost {
  readonly statusLine?: ExtensionStatusLineControls;
}

/**
 * Multiplexer-mode status: the one item reporting what the agent has received, plus whether the
 * working tree moved since Hunk mounted its changeset. Static mode never fills it.
 */
interface LiveStatus {
  /** Last context that can paint the status row; the watcher callback receives no context. */
  host?: StatusLineHost;
  /** True while the working tree changed after the mounted changeset was read. */
  filesChanged: boolean;
  /** True once this registration decided about the watcher, so a second startup adds no other. */
  watching: boolean;
  watcher?: FSWatcher;
  /** Pending watcher debounce; cleared on shutdown. */
  timer?: NodeJS.Timeout;
}

// Hunk imports the same module when replacing its extension registry. Keep review
// ownership here, not in a factory instance that shutdown/startup will replace.
// One Hunk child owns exactly one host-created journal; nothing survives its exit.
let ownedReview: Review | undefined;

/** Status item id multiplexer mode keeps for the whole session; Hunk scopes it per extension. */
const LIVE_STATUS_ID = "live";

/** One write burst is one change: editors emit several events for one save. */
const WORKING_TREE_DEBOUNCE_MS = 300;

/** Saved comments the journal holds right now: one Upsert per note, minus its Remove. */
function sentCount(review: Review): number {
  let sent = 0;
  for (const state of review.notes.values()) if (state._tag === "Saved") sent += 1;
  return sent;
}

/**
 * Paint the permanent status item. Multiplexer mode only: the row must never appear and vanish
 * mid-review, so it is set once at startup and updated from then on, never cleared.
 *
 * The context a watcher callback repaints from is the last one an event handed us. A registration
 * Hunk has replaced can no longer paint, and not every context carries a status line, so a
 * context that cannot paint here is skipped: the next event repaints from its own.
 */
function paintLiveStatus(review: Review, live: LiveStatus, context?: StatusLineHost): void {
  const host = context ?? live.host;
  if (host === undefined) return;
  live.host = host;
  const controls = host.statusLine;
  if (controls === undefined) return;
  const spans: ExtensionStatusSpan[] = [
    { text: `pi-hunk live · ${sentCount(review)} sent`, tone: "muted" },
  ];
  if (live.filesChanged) spans.push({ text: " · files changed, r to refresh", tone: "accent" });
  try {
    controls.set({ id: LIVE_STATUS_ID, spans });
  } catch {
    // A context from a replaced registration cannot paint; the next event repaints its own.
  }
}

/**
 * Follow the working tree so the status item can report that the files moved. Hunk shows nothing
 * until the user presses `r`, so this only reports: no reload, no notice, no navigation. A
 * platform that cannot watch recursively, or a failing watch, leaves the rest of the review as
 * it is.
 */
function watchWorkingTree(review: Review, live: LiveStatus): void {
  live.watching = true;
  try {
    const watcher = watch(review.launch.cwd, { recursive: true }, (_event, filename) => {
      // Hunk keeps its own git state in `.git`; the reviewed files are everything else.
      const name = filename?.replace(/\\/g, "/");
      if (name === ".git" || name?.startsWith(".git/")) return;
      clearTimeout(live.timer);
      const timer = setTimeout(() => {
        live.timer = undefined;
        live.filesChanged = true;
        paintLiveStatus(review, live);
      }, WORKING_TREE_DEBOUNCE_MS);
      // The indicator must not keep Hunk's process alive once the review is over.
      timer.unref();
      live.timer = timer;
    });
    watcher.on("error", () => {
      // An unwatchable tree is not a review failure: drop the indicator, keep the review.
      live.watcher = undefined;
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    });
    live.watcher = watcher;
  } catch {
    live.watcher = undefined;
  }
}

/**
 * True when the working-tree file no longer carries the reviewed NEW-side lines of `range`.
 *
 * Multiplexer mode only, where the agent keeps writing while the reviewer reads: the patch Hunk
 * mounted is what the comment's line numbers name, so it is what the file is compared against.
 * One file read is cheap enough for the save path; an unreadable or missing file is exactly the
 * case this flag exists for.
 */
function workingTreeMoved(
  cwd: string,
  path: string,
  file: ReviewedFile,
  range: readonly [number, number],
): boolean {
  const reviewed = newSideLines(file.patch, range);
  if (reviewed === undefined) return false;
  let current: readonly string[];
  try {
    current = readFileSync(join(cwd, path), "utf8").split("\n");
  } catch {
    return true;
  }
  for (const [line, text] of reviewed) if (current[line - 1] !== text) return true;
  return false;
}

/** Compile physical Alt spellings emitted by Hunk's public Kitty and legacy events. */
function compileHunkKey(chord: string) {
  const parsed = parseKeyChord(chord);
  if ("error" in parsed) throw new Error(parsed.error);
  // Hunk calls the legacy Alt flag `meta`; Kitty Alt sets both flags.
  // Super/Cmd carries neither flag, and must not gain an Alt interpretation.
  const kittyAlt = parsed.option ? { ...parsed, meta: true } : undefined;
  const legacyAlt = parsed.option ? { ...parsed, meta: true, option: false } : undefined;
  return {
    bindings: parsed.option ? [chord, `meta+${chord}`, chord.replace("alt+", "meta+")] : chord,
    matches(key: ExtensionKeyEvent): boolean {
      return (
        matchesKeyChord(parsed, key) ||
        (kittyAlt !== undefined && matchesKeyChord(kittyAlt, key)) ||
        (legacyAlt !== undefined && matchesKeyChord(legacyAlt, key))
      );
    },
  };
}

function append(review: Review, event: ReviewEvent): void {
  appendFileSync(review.launch.journal, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}

/** Full object ids: 40 hex for SHA-1 repositories, 64 for SHA-256 ones. */
const GIT_OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Run one git query in the reviewed repository; null when git cannot answer it.
 *
 * Asynchronous on purpose: `changeset_loaded` is emitted while Hunk is mounting the review, so a
 * synchronous query would freeze the render for every spawn. Nothing here rejects; a revision
 * that git cannot answer is recorded as `unresolved` instead.
 */
function gitQuery(cwd: string, args: readonly string[]): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(
    "git",
    args,
    { cwd, encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) return resolve(null);
      const output = stdout.trim();
      resolve(output.length > 0 ? output : null);
    },
  );
  return promise;
}

/** Resolve one revision to a full commit SHA, or null when git cannot name a commit. */
async function resolveCommit(cwd: string, revision: string): Promise<string | null> {
  const commit = await gitQuery(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return commit !== null && GIT_OBJECT_ID.test(commit) ? commit : null;
}

/**
 * The shortest length git itself uses to name every one of `ids` unambiguously, as
 * `git log --oneline` would. A full SHA stays the identity; this only shortens what the agent
 * reads. When git cannot answer, the full length keeps the id usable.
 */
async function abbreviation(cwd: string, ids: readonly string[]): Promise<number> {
  const lengths = await Promise.all(
    ids.map(async (id) => {
      const short = await gitQuery(cwd, ["rev-parse", "--short", id]);
      return short !== null && id.startsWith(short) ? short.length : id.length;
    }),
  );
  return Math.max(...lengths);
}

/**
 * The empty tree id of each reviewed repository. It is a constant of the object format, so one
 * query per repository answers every root-commit range; Hunk's abbreviated ids are matched
 * against it by prefix instead of asking git to expand an object it does not have.
 */
const emptyTreeIds = new Map<string, Promise<string | null>>();

function emptyTreeId(cwd: string): Promise<string | null> {
  const cached = emptyTreeIds.get(cwd);
  if (cached !== undefined) return cached;
  const query = gitQuery(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
  emptyTreeIds.set(cwd, query);
  return query;
}

/** True when `revision` names the empty tree, the base Hunk reports for a root commit. */
async function resolvesToEmptyTree(cwd: string, revision: string): Promise<boolean> {
  const empty = await emptyTreeId(cwd);
  if (empty === null) return false;
  const lower = revision.toLowerCase();
  if (lower === empty) return true;
  // Hunk abbreviates history ids, and the empty tree is usually absent from the object
  // database, so git cannot expand that abbreviation; match it by prefix instead.
  if (lower.length >= 4 && /^[0-9a-f]+$/.test(lower) && empty.startsWith(lower)) return true;
  return (
    (await gitQuery(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{tree}`])) === empty
  );
}

/**
 * Recover the reviewed revision from the display title Hunk reports with a changeset.
 *
 * The extension API exposes no structured revision on `changeset_loaded`, so the title
 * is parsed and every id it names is verified with git in the reviewed repository.
 * Hunk 0.24.1 emits `"<repo> show <ref>"` (the show view's `HEAD`, or a history
 * selection of a single root commit) and `"<repo> <from>..<to>"` (a history range,
 * where `from` is the empty tree when the selection reaches the root commit). Anything
 * that does not resolve is recorded verbatim as `unresolved`; a SHA is never guessed.
 */
async function resolveRevision(cwd: string, view: View, title: string): Promise<Revision> {
  if (view === "diff") return { kind: "working-tree" };
  const unresolved: Revision = { kind: "unresolved", description: title };
  const tokens = title.trim().split(/\s+/);
  const target = tokens[tokens.length - 1];
  if (!target) return unresolved;
  const separator = target.indexOf("..");
  if (separator >= 0) {
    const to = await resolveCommit(cwd, target.slice(separator + 2));
    if (to === null) return unresolved;
    const fromToken = target.slice(0, separator);
    if (fromToken.length === 0) return { kind: "range", to, abbrev: await abbreviation(cwd, [to]) };
    const from = await resolveCommit(cwd, fromToken);
    if (from !== null)
      return { kind: "range", from, to, abbrev: await abbreviation(cwd, [from, to]) };
    return (await resolvesToEmptyTree(cwd, fromToken))
      ? { kind: "range", to, abbrev: await abbreviation(cwd, [to]) }
      : unresolved;
  }
  if (tokens[tokens.length - 2] !== "show") return unresolved;
  const commit = await resolveCommit(cwd, target);
  if (commit === null) return unresolved;
  const parent = await resolveCommit(cwd, `${commit}^1`);
  const abbrev = await abbreviation(cwd, parent === null ? [commit] : [commit, parent]);
  return { kind: "commit", commit, ...(parent === null ? {} : { parent }), abbrev };
}

/**
 * True when every id the title names is a commit id, so the same title provably names the same
 * revision. A symbolic target (`HEAD`, a branch) does not: the commit it points at can move
 * between two mounts of the same title, so such a changeset is always re-resolved.
 */
function titleNamesCommits(title: string): boolean {
  const target = title.trim().split(/\s+/).pop();
  if (!target) return false;
  return target.split("..").every((token) => token === "" || /^[0-9a-f]{4,64}$/i.test(token));
}

// View lifecycle: every transition of `ReviewState` lives here, and no handler mutates it
// field by field.

/**
 * Record one view request. A request while `Switching` only replaces the pending intent: the
 * running reconciler reads it after the reload it is waiting on, so the latest request wins.
 */
function requestSwitch(state: ReviewState, target: View): SwitchRequest {
  if (state._tag === "Failed") return { _tag: "Ignored" };
  if (state._tag === "Switching") {
    return { _tag: "Queued", state: { ...state, requested: target } };
  }
  if (state.view === target) return { _tag: "Ignored" };
  return {
    _tag: "Started",
    state: { _tag: "Switching", mounted: state.view, target, requested: target },
  };
}

/** Confirm the view Hunk mounted; outside a switch there is nothing in flight to confirm. */
function confirmMount(state: ReviewState, view: View): ReviewState {
  return state._tag === "Switching" ? { ...state, mounted: view } : state;
}

/**
 * Record the view this reconciler is asking Hunk to load. `changeset_loaded` reads it while the
 * reload is in flight, so it must name the reload that is actually running, not an earlier one.
 */
function beginReload(state: ReviewState, view: View): ReviewState {
  return state._tag === "Switching" ? { ...state, target: view } : state;
}

/** A failed switch leaves the last mounted review authoritative. */
function abandonSwitch(state: ReviewState): ReviewState {
  return state._tag === "Switching" ? { _tag: "Reviewing", view: state.mounted } : state;
}

// Capture state: session resolution, changeset mounting, and note records.

/** Parse `hunk session list --json` and return the one session this process owns. */
function parseOwnSession(output: string): string {
  const result: unknown = JSON.parse(output);
  if (
    !result ||
    typeof result !== "object" ||
    !("sessions" in result) ||
    !Array.isArray(result.sessions)
  ) {
    throw new Error("Hunk session list returned an invalid response");
  }
  const own = result.sessions.filter(
    (session: unknown): session is { pid: number; sessionId: string } =>
      !!session &&
      typeof session === "object" &&
      "pid" in session &&
      session.pid === process.pid &&
      "sessionId" in session &&
      typeof session.sessionId === "string" &&
      session.sessionId.length > 0,
  );
  if (own.length !== 1)
    throw new Error(
      `Expected one Hunk session for owned process ${process.pid}, found ${own.length}`,
    );
  return own[0]!.sessionId;
}

/** Run one `hunk` CLI control command in the reviewed repository. */
function control(review: Review, signal: AbortSignal, args: readonly string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    "hunk",
    args,
    {
      cwd: review.launch.cwd,
      encoding: "utf8",
      signal,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    },
  );
  return promise;
}

/**
 * Resolve the Hunk session this process owns. The session cannot change while the process
 * lives, so a failed lookup leaves it unknown and the next switch retries it.
 */
async function ownedSession(review: Review, signal: AbortSignal): Promise<string> {
  const state = review.session;
  if (state._tag === "Owned") return state.id;
  const id = parseOwnSession(await control(review, signal, ["session", "list", "--json"]));
  review.session = { _tag: "Owned", id };
  return id;
}

/** Record where Hunk says a note lives; a journaled note keeps its frozen evidence. */
function locateNote(review: Review, note: ExtensionReviewNote): void {
  const record = review.notes.get(note.id);
  review.notes.set(
    note.id,
    record?._tag === "Saved"
      ? { ...record, fileId: note.fileId, path: note.filePath }
      : { _tag: "Located", fileId: note.fileId, path: note.filePath },
  );
}

/**
 * Terminal transition of the capture lifecycle: the first failure becomes the journal's
 * `Failure` event and the one error notice the user sees. A later failure keeps the first
 * message, and every handler stops capturing once the review is `Failed`.
 *
 * Hunk stays open: the failure is already recorded, so the host refuses to submit the journal
 * when Hunk closes, and exiting here would drop the review (drafts included) mid-render and
 * leave the terminal in Hunk's alternate screen. Only a journal that cannot record the failure
 * itself leaves through exit code 74, because a partial journal would otherwise look
 * submittable.
 */
function failCapture(review: Review, context: ExtensionContext, error: unknown): void {
  if (review.state._tag === "Failed") return;
  const message = `pi-hunk cannot capture review feedback: ${error instanceof Error ? error.message : String(error)}`;
  review.state = { _tag: "Failed", message };
  let recorded = false;
  try {
    append(review, { _tag: "Failure", message });
    recorded = true;
  } catch {
    // The journal cannot name the cause, so the host could still read it as a complete review.
  }
  try {
    context.notify(message, "error");
  } catch {
    // A dying Hunk UI must not turn a reported capture failure into an exit of its own.
  }
  if (!recorded) process.exit(CAPTURE_FAILURE_EXIT_CODE);
}

async function saveMutation(
  review: Review,
  state: ActiveReviewState,
  changeset: ChangesetState,
  note: ExtensionReviewSnapshotNote,
): Promise<void> {
  const record = review.notes.get(note.id);
  if (!record) throw new Error(`Hunk did not provide a public file path for saved note ${note.id}`);
  const file = changeset._tag === "Absent" ? undefined : changeset.files.get(record.fileId);
  const frozen = record._tag === "Saved" ? record.frozen : undefined;
  // A comment keeps the revision it was first saved against, even after the review reloads.
  // A changeset whose revision is still resolving is awaited: the note was saved while Hunk
  // showed that changeset, so it neither borrows the previous revision nor guesses one.
  let revision = frozen?.revision;
  if (revision === undefined && changeset._tag === "Present") revision = changeset.revision;
  if (revision === undefined && changeset._tag === "Reading") revision = await changeset.revision;
  if (revision === undefined)
    throw new Error(`Hunk loaded no reviewed revision before saved note ${note.id}`);
  const previousPath = frozen?.previousPath ?? file?.previousPath;
  // Like revisions, excerpts are fixed when a note is first saved: a later reload
  // must not rewrite the evidence for a comment that already exists.
  const excerpt =
    frozen?.excerpt ?? excerptFor(file?.patch ?? "", note.anchor.oldRange, note.anchor.newRange);
  const body =
    note.markup ?? (note.rationale ? `${note.summary}\n\n${note.rationale}` : note.summary);
  // A switch keeps the last mounted view authoritative until the replacement mounts.
  const view = frozen?.view ?? (state._tag === "Switching" ? state.mounted : state.view);
  // Multiplexer mode only: the agent writes while the reviewer reads, so say whether the file
  // still carries the lines these line numbers name. A note pinned to the old side, or to a
  // revision that is not the working tree, has nothing on disk to compare.
  const stale =
    review.launch.config.mode === "multiplexer" &&
    revision.kind === "working-tree" &&
    note.anchor.newRange !== undefined &&
    file !== undefined &&
    workingTreeMoved(review.launch.cwd, record.path, file, note.anchor.newRange);
  const saved: ReviewNote = {
    id: note.id,
    ...(note.parentId === undefined ? {} : { parentId: note.parentId }),
    view,
    revision,
    path: record.path,
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(note.anchor.oldRange === undefined ? {} : { oldRange: note.anchor.oldRange }),
    ...(note.anchor.newRange === undefined ? {} : { newRange: note.anchor.newRange }),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(stale ? { stale: true as const } : {}),
    body,
  };
  append(review, { _tag: "Upsert", note: saved });
  review.notes.set(note.id, {
    _tag: "Saved",
    fileId: record.fileId,
    path: record.path,
    frozen: frozen ?? {
      view,
      revision,
      ...(previousPath === undefined ? {} : { previousPath }),
      ...(excerpt === undefined ? {} : { excerpt }),
    },
  });
}

/**
 * One reconciler per switch; the `Switching` state is its lock, so at most one reload is in
 * flight. Every iteration reads the freshest request, which is what lets a newer request
 * supersede the reload it arrived during instead of waiting behind it.
 *
 * The registration's signal is the other half of that lock: once it is aborted, this
 * registration is stopped, so the reconciler neither writes the review nor speaks for it. The
 * pending switch stays `Switching` for the registration that replaces this one.
 */
async function runSwitch(
  review: Review,
  context: ExtensionContext,
  signal: AbortSignal,
  attempted: View,
  entry: SwitchEntry,
): Promise<void> {
  try {
    const session = await ownedSession(review, signal);
    // A resumed switch reloads before it can finish: the abandoned reload may have mounted its
    // target, so the recorded view is only trustworthy once this reconciler has reloaded.
    let trustMounted = entry._tag === "Known";
    while (!signal.aborted && review.state._tag === "Switching") {
      const state = review.state;
      if (trustMounted && state.mounted === state.requested) {
        review.state = { _tag: "Reviewing", view: state.mounted };
        return;
      }
      trustMounted = true;
      attempted = state.requested;
      review.state = beginReload(state, attempted);
      await control(review, signal, ["session", "reload", session, "--", attempted]);
      if (signal.aborted) return;
      review.state = confirmMount(review.state, attempted);
    }
  } catch (error) {
    // A stopped registration must not rewrite the review or report on it: the next
    // registration resumes the pending switch and confirms what actually mounted.
    if (signal.aborted) return;
    // A mounted replacement confirms a successful reload even if its CLI response was lost.
    // Otherwise the previous review remains authoritative.
    review.state = abandonSwitch(review.state);
    try {
      context.notify(`pi-hunk could not switch to ${attempted}: ${String(error)}`, "error");
    } catch {
      // A dying Hunk UI must not turn a reported switch failure into an exit.
    }
  }
}

function switchView(
  review: Review,
  target: View,
  context: ExtensionContext,
  signal: AbortSignal,
): void {
  const request = requestSwitch(review.state, target);
  if (request._tag === "Ignored") return;
  review.state = request.state;
  // The reconciler reports its own failure through the review's notice; this callback must
  // return to Hunk immediately.
  if (request._tag === "Started") {
    void runSwitch(review, context, signal, target, { _tag: "Known" });
  }
}

export default function hunkBridge(hunk: HunkExtensionAPI): void {
  if (hunk.apiVersion < 33) {
    throw new Error(
      `pi-hunk requires Hunk 0.25.0 (extension API 33) or newer; this Hunk reports API ${hunk.apiVersion}`,
    );
  }
  const raw = process.env[REVIEW_ENV];
  if (!raw) throw new Error("pi-hunk's review extension must be launched by its host integration");
  const parsed = JSON.parse(raw) as ReviewLaunch;
  if (
    !parsed.journal ||
    !parsed.cwd ||
    (parsed.view !== "diff" && parsed.view !== "show" && parsed.view !== "log")
  ) {
    throw new Error("Invalid pi-hunk review launch");
  }
  const { config } = parseConfig(parsed.config);
  const launch: ReviewLaunch = {
    journal: parsed.journal,
    cwd: parsed.cwd,
    view: parsed.view,
    config,
  };
  if (!ownedReview) {
    ownedReview = {
      launch,
      state: { _tag: "Reviewing", view: launch.view },
      session: { _tag: "Unknown" },
      changeset: { _tag: "Absent" },
      notes: new Map(),
    };
  } else if (ownedReview.launch.journal !== launch.journal) {
    throw new Error("A Hunk process cannot own two pi-hunk review journals");
  }
  const review = ownedReview;
  const navigation: Navigation =
    launch.view === "log" ? { _tag: "History" } : { _tag: "SwitchableViews" };
  let bridge: BridgeState = { _tag: "Registered" };
  // Multiplexer mode's one status item and its working-tree watcher; unused in static mode.
  const live: LiveStatus = { filesChanged: false, watching: false };
  // Journal writes run one at a time: a save waiting for its revision must not let a later note
  // event overtake it, and the journal keeps the order the user worked in.
  let capture: Promise<void> = Promise.resolve();
  // This registration's act gate: shutdown aborts it, and every awaited step that belongs to
  // the registration (session lookup, reload CLI, reconciler) observes it before acting.
  const cancel = new AbortController();
  const prefix = compileHunkKey(launch.config.prefix);
  const diff = compileHunkKey(launch.config.diff);
  const show = compileHunkKey(launch.config.show);
  const log = compileHunkKey(launch.config.log);

  hunk.on("startup", (_event, context) => {
    // Stopped is terminal: Hunk registers a replacement by importing the module again, so this
    // registration never revives and none of its handlers may act.
    if (bridge._tag === "Stopped") return;
    bridge = { _tag: "Running" };
    try {
      if (review.state._tag === "Failed") {
        context.notify(review.state.message, "error");
        return;
      }
      append(review, { _tag: "Ready" });
    } catch (error) {
      failCapture(review, context, error);
    }
    // Multiplexer mode owns one status item for the whole session: setting it here keeps the row
    // from appearing and disappearing later, and the watcher only ever changes its text.
    if (launch.config.mode === "multiplexer" && review.state._tag !== "Failed") {
      paintLiveStatus(review, live, context);
      if (!live.watching) watchWorkingTree(review, live);
    }
    // A switch left pending by the registration this one replaced gets its reconciler back, and
    // must reload before it can finish: the abandoned reload may have mounted its own target.
    const state = review.state;
    if (state._tag === "Switching") {
      void runSwitch(review, context, cancel.signal, state.requested, { _tag: "Interrupted" });
    }
  });

  hunk.on("changeset_loaded", ({ changeset }, context) => {
    if (bridge._tag !== "Running") return;
    const state = review.state;
    if (state._tag === "Failed") return;
    // The view Hunk just mounted: a reload in flight is mounting its target, otherwise the
    // review is showing the stable view the last switch settled on.
    const view = state._tag === "Switching" ? state.target : state.view;
    review.state = confirmMount(state, view);
    // A changeset reached here because the user reloaded (`r`) or switched views, so the files
    // on disk are the ones this review now carries and nothing is behind anymore.
    if (launch.config.mode === "multiplexer") {
      live.filesChanged = false;
      paintLiveStatus(review, live, context);
    }
    const files = new Map(
      changeset.files.map((file): [string, ReviewedFile] => [
        file.id,
        {
          patch: file.patch,
          ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        },
      ]),
    );
    const key = `${view}\u0000${changeset.title}`;
    const mounted = review.changeset;
    // Remounting the changeset whose revision is already known only moves the files: the key is
    // what the revision was derived from, so asking git again would repeat the same question.
    // `diff` is always the working tree, and a title that names commit ids cannot go stale.
    const reusable = view === "diff" || titleNamesCommits(changeset.title);
    if (reusable && mounted._tag !== "Absent" && mounted.key === key) {
      review.changeset =
        mounted._tag === "Present"
          ? { _tag: "Present", key, revision: mounted.revision, files }
          : { _tag: "Reading", key, revision: mounted.revision, files };
      return;
    }
    // Resolution is asynchronous: Hunk mounts and paints this changeset now, and a note saved
    // before the revision lands waits for it instead of blocking the render here.
    const reading: ChangesetState = {
      _tag: "Reading",
      key,
      revision: resolveRevision(review.launch.cwd, view, changeset.title),
      files,
    };
    review.changeset = reading;
    void reading.revision.then((revision) => {
      // A newer mount owns the table by now, so this answer must not replace its entry.
      if (review.changeset !== reading) return;
      review.changeset = { _tag: "Present", key, revision, files };
    });
  });

  hunk.on("note_created", ({ note }) => {
    if (bridge._tag === "Running" && !note.draft) locateNote(review, note);
  });
  hunk.on("note_edited", ({ note }) => {
    if (bridge._tag === "Running" && !note.draft) locateNote(review, note);
  });
  hunk.on("note_changed", ({ kind, note }, context) => {
    // The evidence is frozen at the event, like the save it belongs to: the changeset and view
    // Hunk showed when the note was committed, not whatever mounted while a save was queued.
    const state = review.state;
    const changeset = review.changeset;
    if (bridge._tag !== "Running" || state._tag === "Failed" || note.source !== "user") return;
    // A save can wait for a pending revision, so journal writes are serialized: an edit must
    // never overtake the save it edits, and the journal stays in the order the user worked.
    capture = capture.then(async () => {
      // A stopped registration or an earlier failure owns the review by the time this runs.
      if (bridge._tag !== "Running" || review.state._tag === "Failed") return;
      try {
        if (kind === "removed") {
          append(review, { _tag: "Remove", id: note.id });
          review.notes.delete(note.id);
        } else {
          await saveMutation(review, state, changeset, note);
        }
        // The item counts what the journal holds, so it is repainted after the write, not before.
        if (launch.config.mode === "multiplexer") paintLiveStatus(review, live, context);
      } catch (error) {
        failCapture(review, context, error);
      }
    });
  });

  hunk.registerKeyboardMode({
    id: "prefix",
    title: "pi-hunk view",
    onKey(key, context) {
      // A stopped registration no longer owns this mode: Hunk has torn it down, so it neither
      // acts nor reports.
      if (bridge._tag === "Stopped") return "pass";
      // Exit before passing unknown input through to native Hunk commands.
      // Escape is owned and canceled by Hunk before this callback runs.
      context.keyboardModes.exitMode();
      if (navigation._tag === "History") {
        if (log.matches(key)) {
          if (bridge._tag === "Running" && review.state._tag !== "Failed") {
            context.commands.execute("hunk.app.quit");
          }
          return "handled";
        }
        if (diff.matches(key) || show.matches(key)) {
          context.notify(
            "Diff/show switching is unavailable in history-selected reviews. Use the log key to return to history.",
            "info",
          );
          return "handled";
        }
        return "pass";
      }
      const target = diff.matches(key) ? "diff" : show.matches(key) ? "show" : undefined;
      if (!target) return "pass";
      if (bridge._tag === "Running") switchView(review, target, context, cancel.signal);
      return "handled";
    },
  });
  hunk.registerCommand(
    { id: "prefix", title: "Choose pi-hunk view", key: prefix.bindings },
    (context) => {
      if (bridge._tag !== "Running" || review.state._tag === "Failed") return;
      context.keyboardModes.enterMode("prefix");
    },
  );

  hunk.on("shutdown", () => {
    // Registry replacement is not review completion. No export, journal reset,
    // submission, or wait for the reload CLI under Hunk's 250ms deadline.
    if (bridge._tag === "Stopped") return;
    bridge = { _tag: "Stopped" };
    // Teardown is terminal for this registration: its handlers are no-ops from here on, and
    // aborting the signal stops the reconciler at its next step and kills its reload CLI. The
    // review is left exactly as it is — a pending `Switching` is neither flattened to the view
    // it came from nor reported as mounted, because only the replacing registration, reading
    // the changeset Hunk reloads for it, can tell what actually mounted.
    cancel.abort();
    // The watcher belongs to this registration: a replacement starts its own, and a closed tree
    // must not leave a timer painting into a review this registration no longer owns.
    clearTimeout(live.timer);
    live.timer = undefined;
    try {
      live.watcher?.close();
    } catch {
      // Already closed.
    }
    live.watcher = undefined;
  });
}
