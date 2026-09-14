import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import type {} from "./hunk-api.js";
import {
  matchesKeyChord,
  parseKeyChord,
  type ExtensionContext,
  type ExtensionKeyEvent,
  type ExtensionReviewSnapshotNote,
  type HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  CAPTURE_FAILURE_EXIT_CODE,
  REVIEW_ENV,
  type ReviewEvent,
  type ReviewLaunch,
  type ReviewNote,
  type View,
} from "./contract.js";
import { parseConfig } from "./config.js";

type ReviewState =
  | { readonly _tag: "Reviewing"; readonly view: View }
  | { readonly _tag: "Switching"; view: View; target: View; requested: View }
  | { readonly _tag: "Failed"; readonly message: string };

type InstanceState = "Registered" | "Running" | "Stopped";

interface Review {
  readonly launch: ReviewLaunch;
  state: ReviewState;
  sessionId?: string;
  source?: ReviewNote["source"];
  /** Public saved-note lifecycle payloads supply paths before note_changed fires. */
  readonly paths: Map<string, string>;
  readonly notes: Map<string, ReviewNote>;
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

function control(review: Review, args: readonly string[]): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
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
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

function switchView(review: Review, target: View, context: ExtensionContext): void {
  if (review.state._tag === "Failed") return;
  if (review.state._tag === "Switching") {
    // One latest intent, not a queue: replacing it also cancels an obsolete pending view.
    review.state.requested = target;
    return;
  }
  if (review.state.view === target) return;
  const switching: ReviewState & { _tag: "Switching" } = {
    _tag: "Switching",
    view: review.state.view,
    target,
    requested: target,
  };
  review.state = switching;
  Effect.runFork(
    Effect.gen(function* () {
      if (!review.sessionId) {
        const output = yield* control(review, ["session", "list", "--json"]);
        const id = yield* Effect.try(() => {
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
        });
        review.sessionId = id;
      }
      while (review.state === switching) {
        if (switching.view === switching.requested) {
          review.state = { _tag: "Reviewing", view: switching.view };
          break;
        }
        switching.target = switching.requested;
        yield* control(review, ["session", "reload", review.sessionId, "--", switching.target]);
        switching.view = switching.target;
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (review.state === switching) {
            // A mounted replacement confirms a successful reload even if its CLI
            // response was lost. Otherwise the previous review remains authoritative.
            review.state = { _tag: "Reviewing", view: switching.view };
          }
          context.notify(
            `pi-hunk could not switch to ${switching.target}: ${String(error)}`,
            "error",
          );
        }),
      ),
    ),
  );
}

function saveMutation(review: Review, note: ExtensionReviewSnapshotNote): void {
  if (review.state._tag === "Failed") return;
  const existing = review.notes.get(note.id);
  const path = review.paths.get(note.id) ?? existing?.path;
  if (!path) throw new Error(`Hunk did not provide a public file path for saved note ${note.id}`);
  const body =
    note.markup ?? (note.rationale ? `${note.summary}\n\n${note.rationale}` : note.summary);
  const saved: ReviewNote = {
    id: note.id,
    ...(note.parentId === undefined ? {} : { parentId: note.parentId }),
    view: existing?.view ?? review.state.view,
    path,
    ...((existing?.source ?? review.source) ? { source: existing?.source ?? review.source } : {}),
    ...(note.anchor.oldRange === undefined ? {} : { oldRange: note.anchor.oldRange }),
    ...(note.anchor.newRange === undefined ? {} : { newRange: note.anchor.newRange }),
    body,
  };
  append(review, { _tag: "Upsert", note: saved });
  review.notes.set(note.id, saved);
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
      paths: new Map(),
      notes: new Map(),
    };
  } else if (ownedReview.launch.journal !== launch.journal) {
    throw new Error("A Hunk process cannot own two pi-hunk review journals");
  }
  const review = ownedReview;
  let instance: InstanceState = "Registered";
  const prefix = compileHunkKey(launch.config.prefix);
  const diff = compileHunkKey(launch.config.diff);
  const show = compileHunkKey(launch.config.show);
  const log = compileHunkKey(launch.config.log);

  hunk.on("startup", (_event, context) => {
    instance = "Running";
    try {
      if (review.state._tag === "Failed") {
        context.notify(review.state.message, "error");
        return;
      }
      append(review, { _tag: "Ready" });
    } catch (error) {
      failCapture(review, context, error);
    }
  });

  hunk.on("changeset_loaded", ({ changeset }) => {
    if (instance === "Running" && launch.view === "log") {
      review.source = { title: changeset.title, label: changeset.sourceLabel };
    }
    if (instance === "Running" && review.state._tag === "Switching") {
      review.state.view = review.state.target;
    }
  });

  hunk.on("note_created", ({ note }) => {
    if (instance === "Running" && !note.draft) review.paths.set(note.id, note.filePath);
  });
  hunk.on("note_edited", ({ note }) => {
    if (instance === "Running" && !note.draft) review.paths.set(note.id, note.filePath);
  });
  hunk.on("note_changed", ({ kind, note }, context) => {
    if (instance !== "Running" || review.state._tag === "Failed" || note.source !== "user") return;
    try {
      if (kind === "removed") {
        append(review, { _tag: "Remove", id: note.id });
        review.notes.delete(note.id);
        review.paths.delete(note.id);
      } else {
        saveMutation(review, note);
      }
    } catch (error) {
      failCapture(review, context, error);
    }
  });

  hunk.registerKeyboardMode({
    id: "prefix",
    title: "pi-hunk view",
    onKey(key, context) {
      // Exit before passing unknown input through to native Hunk commands.
      // Escape is owned and canceled by Hunk before this callback runs.
      context.keyboardModes.exitMode();
      if (launch.view === "log") {
        if (log.matches(key)) {
          if (instance === "Running" && review.state._tag !== "Failed") {
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
      if (instance === "Running") switchView(review, target, context);
      return "handled";
    },
  });
  hunk.registerCommand(
    { id: "prefix", title: "Choose pi-hunk view", key: prefix.bindings },
    (context) => {
      if (instance !== "Running" || review.state._tag === "Failed") return;
      context.keyboardModes.enterMode("prefix");
    },
  );

  hunk.on("shutdown", () => {
    // Registry replacement is not review completion. No export, journal reset,
    // submission, or wait for the reload CLI under Hunk's 250ms deadline.
    instance = "Stopped";
  });
}
