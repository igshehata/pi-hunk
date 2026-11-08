import { execFile, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  matchesKeyChord,
  parseKeyChord,
  type ExtensionContext,
  type ExtensionKeyEvent,
  type ExtensionReviewNote,
  type ExtensionReviewSnapshotNote,
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
import { excerptFor } from "./excerpt.js";

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
 */
type ChangesetState =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Present";
      readonly revision: Revision;
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

// Hunk imports the same module when replacing its extension registry. Keep review
// ownership here, not in a factory instance that shutdown/startup will replace.
// One Hunk child owns exactly one host-created journal; nothing survives its exit.
let ownedReview: Review | undefined;

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

/** Run one git query in the reviewed repository; null when git cannot answer it. */
function gitQuery(cwd: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/** Resolve one revision to a full commit SHA, or null when git cannot name a commit. */
function resolveCommit(cwd: string, revision: string): string | null {
  const commit = gitQuery(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  return commit !== null && GIT_OBJECT_ID.test(commit) ? commit : null;
}

/** True when `revision` names the empty tree, the base Hunk reports for a root commit. */
function resolvesToEmptyTree(cwd: string, revision: string): boolean {
  const empty = gitQuery(cwd, ["hash-object", "-t", "tree", "/dev/null"]);
  if (empty === null) return false;
  const lower = revision.toLowerCase();
  if (lower === empty) return true;
  // Hunk abbreviates history ids, and the empty tree is usually absent from the object
  // database, so git cannot expand that abbreviation; match it by prefix instead.
  if (lower.length >= 4 && /^[0-9a-f]+$/.test(lower) && empty.startsWith(lower)) return true;
  return gitQuery(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{tree}`]) === empty;
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
function resolveRevision(cwd: string, view: View, title: string): Revision {
  if (view === "diff") return { kind: "working-tree" };
  const unresolved: Revision = { kind: "unresolved", description: title };
  const tokens = title.trim().split(/\s+/);
  const target = tokens[tokens.length - 1];
  if (!target) return unresolved;
  const separator = target.indexOf("..");
  if (separator >= 0) {
    const to = resolveCommit(cwd, target.slice(separator + 2));
    if (to === null) return unresolved;
    const fromToken = target.slice(0, separator);
    if (fromToken.length === 0) return { kind: "range", to };
    const from = resolveCommit(cwd, fromToken);
    if (from !== null) return { kind: "range", from, to };
    return resolvesToEmptyTree(cwd, fromToken) ? { kind: "range", to } : unresolved;
  }
  if (tokens[tokens.length - 2] !== "show") return unresolved;
  const commit = resolveCommit(cwd, target);
  if (commit === null) return unresolved;
  const parent = resolveCommit(cwd, `${commit}^1`);
  return { kind: "commit", commit, ...(parent === null ? {} : { parent }) };
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
 * `Failure` event, the one error notice the user sees, and exit code 74. A later failure keeps
 * the first message, and every handler stops capturing once the review is `Failed`.
 */
function failCapture(review: Review, context: ExtensionContext, error: unknown): void {
  if (review.state._tag === "Failed") return;
  const message = `pi-hunk cannot capture review feedback: ${error instanceof Error ? error.message : String(error)}`;
  review.state = { _tag: "Failed", message };
  try {
    append(review, { _tag: "Failure", message });
  } finally {
    try {
      context.notify(message, "error");
    } finally {
      // Even a full/unwritable disk must not turn a partial journal into a submission.
      process.exit(CAPTURE_FAILURE_EXIT_CODE);
    }
  }
}

function saveMutation(
  review: Review,
  state: ActiveReviewState,
  note: ExtensionReviewSnapshotNote,
): void {
  const record = review.notes.get(note.id);
  if (!record) throw new Error(`Hunk did not provide a public file path for saved note ${note.id}`);
  const changeset = review.changeset;
  const file = changeset._tag === "Present" ? changeset.files.get(record.fileId) : undefined;
  const frozen = record._tag === "Saved" ? record.frozen : undefined;
  // A comment keeps the revision it was first saved against, even after the review reloads.
  const revision =
    frozen?.revision ?? (changeset._tag === "Present" ? changeset.revision : undefined);
  if (!revision) throw new Error(`Hunk loaded no reviewed revision before saved note ${note.id}`);
  const previousPath = frozen?.previousPath ?? file?.previousPath;
  // Like revisions, excerpts are fixed when a note is first saved: a later reload
  // must not rewrite the evidence for a comment that already exists.
  const excerpt =
    frozen?.excerpt ?? excerptFor(file?.patch ?? "", note.anchor.oldRange, note.anchor.newRange);
  const body =
    note.markup ?? (note.rationale ? `${note.summary}\n\n${note.rationale}` : note.summary);
  // A switch keeps the last mounted view authoritative until the replacement mounts.
  const view = frozen?.view ?? (state._tag === "Switching" ? state.mounted : state.view);
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
  if (hunk.apiVersion < 25) {
    throw new Error(
      `pi-hunk requires Hunk 0.22.0 (extension API 25) or newer; this Hunk reports API ${hunk.apiVersion}`,
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
  const launch: ReviewLaunch = {
    journal: parsed.journal,
    cwd: parsed.cwd,
    view: parsed.view,
    config: parseConfig(parsed.config),
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
    // A switch left pending by the registration this one replaced gets its reconciler back, and
    // must reload before it can finish: the abandoned reload may have mounted its own target.
    const state = review.state;
    if (state._tag === "Switching") {
      void runSwitch(review, context, cancel.signal, state.requested, { _tag: "Interrupted" });
    }
  });

  hunk.on("changeset_loaded", ({ changeset }) => {
    if (bridge._tag !== "Running") return;
    const state = review.state;
    if (state._tag === "Failed") return;
    // The view Hunk just mounted: a reload in flight is mounting its target, otherwise the
    // review is showing the stable view the last switch settled on.
    const view = state._tag === "Switching" ? state.target : state.view;
    review.state = confirmMount(state, view);
    review.changeset = {
      _tag: "Present",
      revision: resolveRevision(review.launch.cwd, view, changeset.title),
      files: new Map(
        changeset.files.map((file): [string, ReviewedFile] => [
          file.id,
          {
            patch: file.patch,
            ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
          },
        ]),
      ),
    };
  });

  hunk.on("note_created", ({ note }) => {
    if (bridge._tag === "Running" && !note.draft) locateNote(review, note);
  });
  hunk.on("note_edited", ({ note }) => {
    if (bridge._tag === "Running" && !note.draft) locateNote(review, note);
  });
  hunk.on("note_changed", ({ kind, note }, context) => {
    const state = review.state;
    if (bridge._tag !== "Running" || state._tag === "Failed" || note.source !== "user") return;
    try {
      if (kind === "removed") {
        append(review, { _tag: "Remove", id: note.id });
        review.notes.delete(note.id);
      } else {
        saveMutation(review, state, note);
      }
    } catch (error) {
      failCapture(review, context, error);
    }
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
  });
}
