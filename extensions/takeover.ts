import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Data, Effect, Either, Schema } from "effect";
import {
  modeArgs,
  type HunkConfig,
  type HunkMode,
  type ReviewNote,
  type TakeoverResult,
} from "./model.ts";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const CAPTURE_PATH_ENV = "PI_HUNK_FEEDBACK_PATH";
const PREFIX_KEY_ENV = "PI_HUNK_PREFIX_KEY";
const DIFF_KEY_ENV = "PI_HUNK_DIFF_KEY";
const SHOW_KEY_ENV = "PI_HUNK_SHOW_KEY";
const STASH_KEY_ENV = "PI_HUNK_STASH_KEY";
const FEEDBACK_EXTENSION_PATH = fileURLToPath(new URL("./hunk-feedback.js", import.meta.url));
const MAX_FEEDBACK_BYTES = 1_000_000;
const FORCE_KILL_DELAY_MS = 1_000;

const NullableLine = Schema.NullOr(Schema.Number);
const NullableRange = Schema.NullOr(Schema.Tuple(Schema.Number, Schema.Number));
const ReviewNoteSchema = Schema.Struct({
  noteId: Schema.String,
  file: Schema.String,
  oldLine: NullableLine,
  newLine: NullableLine,
  oldRange: NullableRange,
  newRange: NullableRange,
  summary: Schema.String,
  rationale: Schema.String,
});
const CaptureSchema = Schema.Union(
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("pending"),
    prefixAction: Schema.optional(Schema.Literal("diff", "show", "stash")),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("ready"),
    notes: Schema.Array(ReviewNoteSchema),
    removedNoteIds: Schema.Array(Schema.String),
    prefixAction: Schema.optional(Schema.Literal("diff", "show", "stash")),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("failed"),
    detail: Schema.String,
    prefixAction: Schema.optional(Schema.Literal("diff", "show", "stash")),
  }),
);

interface CaptureFiles {
  readonly directory: string;
  readonly path: string;
}

interface CapturedFeedback {
  readonly notes: readonly ReviewNote[];
  readonly removedNoteIds?: readonly string[];
  readonly prefixAction?: HunkMode;
  readonly feedbackError?: string;
}

export class TakeoverError extends Data.TaggedError("TakeoverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isPositiveLine(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value > 0);
}

function isRange(value: readonly [number, number] | null): boolean {
  return (
    value === null ||
    (Number.isInteger(value[0]) &&
      value[0] > 0 &&
      Number.isInteger(value[1]) &&
      value[1] >= value[0])
  );
}

function readCapturedFeedback(path: string): CapturedFeedback {
  try {
    const encoded = readFileSync(path);
    if (encoded.length > MAX_FEEDBACK_BYTES) {
      return { notes: [], feedbackError: "Hunk feedback exceeded the 1 MB capture limit." };
    }
    const decoded = Schema.decodeUnknownEither(CaptureSchema, { onExcessProperty: "error" })(
      JSON.parse(encoded.toString("utf8")) as unknown,
    );
    if (Either.isLeft(decoded)) {
      return { notes: [], feedbackError: "Hunk feedback capture was missing or invalid." };
    }
    const prefix = decoded.right.prefixAction ? { prefixAction: decoded.right.prefixAction } : {};
    if (decoded.right.status === "pending") {
      return {
        notes: [],
        ...prefix,
        feedbackError: "Hunk exited before its feedback snapshot completed.",
      };
    }
    if (decoded.right.status === "failed") {
      return { notes: [], ...prefix, feedbackError: decoded.right.detail };
    }
    if (decoded.right.notes.length > 1_000 || decoded.right.removedNoteIds.length > 1_000) {
      return { notes: [], ...prefix, feedbackError: "Hunk feedback exceeded 1,000 notes." };
    }
    if (decoded.right.removedNoteIds.some((noteId) => noteId.length === 0)) {
      return { notes: [], ...prefix, feedbackError: "Hunk feedback contained an invalid removal." };
    }

    const notes: ReviewNote[] = [];
    for (const note of decoded.right.notes) {
      if (
        !note.noteId ||
        !note.file ||
        !isPositiveLine(note.oldLine) ||
        !isPositiveLine(note.newLine) ||
        (note.oldLine === null && note.newLine === null) ||
        !isRange(note.oldRange) ||
        !isRange(note.newRange)
      ) {
        return { notes: [], ...prefix, feedbackError: "Hunk feedback contained an invalid note." };
      }
      notes.push({
        ...note,
        oldRange: note.oldRange,
        newRange: note.newRange,
      });
    }
    return { notes, removedNoteIds: [...new Set(decoded.right.removedNoteIds)], ...prefix };
  } catch {
    return { notes: [], feedbackError: "Hunk did not produce a feedback snapshot." };
  }
}

function captureFiles(): CaptureFiles {
  const directory = mkdtempSync(join(tmpdir(), "pi-hunk-feedback-"));
  return { directory, path: join(directory, "notes.json") };
}

function cleanupCapture(files: CaptureFiles): void {
  Effect.runSync(
    Effect.sync(() => {
      try {
        rmSync(files.directory, { recursive: true, force: true });
      } catch {
        // Terminal restoration cannot depend on temporary-file cleanup.
      }
    }),
  );
}

type TakeoverPhase =
  | { readonly _tag: "Preparing" }
  | { readonly _tag: "CaptureAllocated"; readonly capture: CaptureFiles }
  | { readonly _tag: "TerminalOwned"; readonly capture: CaptureFiles }
  | { readonly _tag: "Running"; readonly capture: CaptureFiles; readonly child: ChildProcess }
  | {
      readonly _tag: "Stopping";
      readonly capture: CaptureFiles;
      readonly child: ChildProcess;
      readonly forceKillTimer: ReturnType<typeof setTimeout>;
    }
  | { readonly _tag: "Finished" };

interface TakeoverComponentOptions {
  readonly ctx: ExtensionContext;
  readonly config: HunkConfig;
  readonly mode: HunkMode;
  readonly target?: string;
  readonly onStart: (pid: number) => void;
  readonly onFinish: (result: TakeoverResult) => void;
}

class TakeoverComponent implements Component {
  private phase: TakeoverPhase = { _tag: "Preparing" };

  constructor(
    private readonly tui: TUI,
    private readonly options: TakeoverComponentOptions,
  ) {
    try {
      const capture = captureFiles();
      this.phase = { _tag: "CaptureAllocated", capture };
      this.tui.stop();
      this.phase = { _tag: "TerminalOwned", capture };
      process.stdin.pause();
      process.stdout.write(CLEAR_SCREEN);

      // Hunk must own the physical TTY. A stdin proxy can drop or retain bytes,
      // corrupting ordinary input such as review comments under load.

      const child = spawn(
        "hunk",
        [...modeArgs(options.mode, options.target), "--extension", FEEDBACK_EXTENSION_PATH],
        {
          cwd: options.ctx.cwd,
          env: {
            ...process.env,
            [CAPTURE_PATH_ENV]: capture.path,
            [PREFIX_KEY_ENV]: options.config.hotkeys.prefix,
            [DIFF_KEY_ENV]: options.config.hotkeys.diff,
            [SHOW_KEY_ENV]: options.config.hotkeys.show,
            [STASH_KEY_ENV]: options.config.hotkeys.stash,
          },
          stdio: "inherit",
        },
      );
      this.phase = { _tag: "Running", capture, child };
      child.once("spawn", () => {
        if (this.phase._tag === "Running" && child.pid) options.onStart(child.pid);
      });
      child.once("error", (error) => {
        this.finish({
          termination: { _tag: "StartupFailed", detail: `Hunk startup failed: ${error.message}` },
          notes: [],
        });
      });
      child.once("exit", (exitCode, signal) => {
        this.finish({
          termination:
            exitCode !== null
              ? { _tag: "Exited", exitCode }
              : signal
                ? { _tag: "Signaled", signal }
                : { _tag: "StartupFailed", detail: "Hunk exited without a status." },
          notes: [],
        });
      });
    } catch (cause) {
      queueMicrotask(() => {
        this.finish({
          termination: {
            _tag: "StartupFailed",
            detail: `Hunk startup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
          notes: [],
        });
      });
    }
  }

  render(): string[] {
    return [];
  }

  invalidate(): void {}

  dispose(): void {
    switch (this.phase._tag) {
      case "Preparing":
        this.finish({
          termination: { _tag: "StartupFailed", detail: "Hunk stopped before takeover began." },
          notes: [],
        });
        return;
      case "CaptureAllocated":
        this.finish({
          termination: { _tag: "StartupFailed", detail: "Hunk stopped before terminal takeover." },
          notes: [],
        });
        return;
      case "TerminalOwned":
        this.finish({ termination: { _tag: "Signaled", signal: "SIGTERM" }, notes: [] });
        return;
      case "Running": {
        const { capture, child } = this.phase;
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (!child.kill("SIGTERM")) {
          this.finish({
            termination: { _tag: "StartupFailed", detail: "Hunk could not be terminated." },
            notes: [],
          });
          return;
        }
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
        this.phase = { _tag: "Stopping", capture, child, forceKillTimer };
        return;
      }
      case "Stopping":
      case "Finished":
        return;
    }
  }

  private finish(base: TakeoverResult): void {
    const phase = this.phase;
    if (phase._tag === "Finished") return;
    this.phase = { _tag: "Finished" };

    const capture = phase._tag === "Preparing" ? undefined : phase.capture;
    const captured = capture ? readCapturedFeedback(capture.path) : undefined;
    if (phase._tag === "Stopping") clearTimeout(phase.forceKillTimer);
    if (capture) cleanupCapture(capture);

    if (phase._tag === "TerminalOwned" || phase._tag === "Running" || phase._tag === "Stopping") {
      try {
        this.tui.start();
        this.tui.requestRender(true);
      } catch {
        // The child result remains authoritative if the host cannot repaint.
      }
    }

    this.options.onFinish({
      termination: captured?.prefixAction ? { _tag: "Exited", exitCode: 0 } : base.termination,
      notes: captured?.notes ?? base.notes,
      ...(captured?.removedNoteIds ? { removedNoteIds: captured.removedNoteIds } : {}),
      ...(captured?.prefixAction ? { prefixAction: captured.prefixAction } : {}),
      ...(captured?.feedbackError ? { feedbackError: captured.feedbackError } : {}),
    });
  }
}

export interface TakeoverHandle {
  readonly pid: number;
  readonly stop: Effect.Effect<void>;
}

interface LaunchTakeoverOptions {
  readonly ctx: ExtensionContext;
  readonly config: HunkConfig;
  readonly mode: HunkMode;
  readonly target?: string;
  readonly onExit: (result: TakeoverResult) => void;
}

export function launchTakeover(
  options: LaunchTakeoverOptions,
  signal: AbortSignal,
): Effect.Effect<TakeoverHandle, TakeoverError> {
  return Effect.async<TakeoverHandle, TakeoverError>((resume) => {
    let startup:
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Started" }
      | { readonly _tag: "Failed" } = { _tag: "Pending" };
    let component:
      | { readonly _tag: "Absent" }
      | { readonly _tag: "Present"; readonly value: TakeoverComponent } = { _tag: "Absent" };

    const abort = (): void => {
      if (component._tag === "Present" && startup._tag !== "Failed") component.value.dispose();
    };
    signal.addEventListener("abort", abort, { once: true });

    const failStartup = (result: TakeoverResult): void => {
      if (startup._tag !== "Pending") return;
      startup = { _tag: "Failed" };
      const detail =
        result.termination._tag === "StartupFailed"
          ? result.termination.detail
          : "Hunk exited before takeover started.";
      resume(Effect.fail(new TakeoverError({ message: detail })));
    };

    try {
      const custom = options.ctx.ui.custom<TakeoverResult>((tui, _theme, _keybindings, done) => {
        const takeover = new TakeoverComponent(tui, {
          ...options,
          onStart: (pid) => {
            if (startup._tag !== "Pending") return;
            startup = { _tag: "Started" };
            resume(
              Effect.succeed({
                pid,
                stop: Effect.sync(() => {
                  signal.removeEventListener("abort", abort);
                  takeover.dispose();
                }),
              }),
            );
          },
          onFinish: (result) => {
            signal.removeEventListener("abort", abort);
            done(result);
          },
        });
        component = { _tag: "Present", value: takeover };
        if (signal.aborted) abort();
        return takeover;
      });
      void custom.then(
        (result) => {
          options.onExit(result);
          failStartup(result);
        },
        (cause) => {
          signal.removeEventListener("abort", abort);
          const result: TakeoverResult = {
            termination: {
              _tag: "StartupFailed",
              detail: `Hunk custom UI failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
            notes: [],
          };
          options.onExit(result);
          failStartup(result);
        },
      );
    } catch (cause) {
      signal.removeEventListener("abort", abort);
      startup = { _tag: "Failed" };
      resume(
        Effect.fail(
          new TakeoverError({
            message: `Hunk custom UI failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
        ),
      );
    }

    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
      abort();
    });
  });
}
