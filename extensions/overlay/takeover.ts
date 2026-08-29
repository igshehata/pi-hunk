import type { Component, TUI } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HunkExit, HunkReviewNote } from "./types.ts";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const FEEDBACK_CAPTURE_ENV = "PI_HUNK_FEEDBACK_PATH";
const FEEDBACK_EXTENSION_PATH = fileURLToPath(new URL("./hunk-feedback.js", import.meta.url));
const MAX_FEEDBACK_BYTES = 1_000_000;
const FORCE_KILL_DELAY_MS = 1_000;

function withFeedbackExtension(args: string[]): string[] {
  const pathspecIndex = args.indexOf("--");
  const insertAt = pathspecIndex === -1 ? args.length : pathspecIndex;
  if (args.slice(0, insertAt).includes("--no-extensions")) {
    throw new Error(
      "Hunk startup failed: pi-hunk feedback requires extensions; remove --no-extensions from hunk.args.",
    );
  }
  return [
    ...args.slice(0, insertAt),
    "--extension",
    FEEDBACK_EXTENSION_PATH,
    ...args.slice(insertAt),
  ];
}

function isPositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isLineOrNull(value: unknown): value is number | null {
  return value === null || isPositiveLine(value);
}

function isRangeOrNull(value: unknown): value is [number, number] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      isPositiveLine(value[0]) &&
      isPositiveLine(value[1]) &&
      value[1] >= value[0])
  );
}
function isCapturedReviewNote(value: unknown): value is HunkReviewNote {
  if (!value || typeof value !== "object") return false;
  return (
    "noteId" in value &&
    typeof value.noteId === "string" &&
    value.noteId.length > 0 &&
    "file" in value &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    "oldLine" in value &&
    isLineOrNull(value.oldLine) &&
    "newLine" in value &&
    isLineOrNull(value.newLine) &&
    (value.oldLine !== null || value.newLine !== null) &&
    "oldRange" in value &&
    isRangeOrNull(value.oldRange) &&
    "newRange" in value &&
    isRangeOrNull(value.newRange) &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "rationale" in value &&
    typeof value.rationale === "string"
  );
}

function readCapturedNotes(path: string): HunkReviewNote[] | undefined {
  try {
    const encoded = readFileSync(path);
    if (encoded.length > MAX_FEEDBACK_BYTES) return undefined;
    const value: unknown = JSON.parse(encoded.toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("ready" in value) ||
      value.ready !== true ||
      !("notes" in value) ||
      !Array.isArray(value.notes)
    ) {
      return undefined;
    }

    if (value.notes.length > 1_000) return undefined;
    const parsed: HunkReviewNote[] = [];
    for (const entry of value.notes) {
      if (!isCapturedReviewNote(entry)) return undefined;
      parsed.push(entry);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export interface TakeoverOptions {
  command: string;
  args: string[];
  cwd: string;
  tui: TUI;
  onStart: (pid: number) => void;
  onExit: (result: HunkExit) => void;
}

/**
 * Give Hunk the physical terminal until it exits. Pi's TUI is fully stopped, so
 * the child owns stdin, stdout, terminal modes, resize events, and rendering.
 */
export class TakeoverHunk implements Component {
  readonly pid?: number;
  private readonly tui: TUI;
  private readonly onExit: (result: HunkExit) => void;
  private child: ChildProcess | undefined;
  private tuiStopped = false;
  private settled = false;
  private feedbackDirectory: string | undefined;
  private feedbackPath: string | undefined;
  private forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TakeoverOptions) {
    this.tui = options.tui;
    this.onExit = options.onExit;

    try {
      const args = withFeedbackExtension(options.args);
      const feedbackDirectory = mkdtempSync(join(tmpdir(), "pi-hunk-feedback-"));
      const feedbackPath = join(feedbackDirectory, "notes.json");
      this.feedbackDirectory = feedbackDirectory;
      this.feedbackPath = feedbackPath;

      this.tui.stop();
      this.tuiStopped = true;
      process.stdout.write(CLEAR_SCREEN);

      const child = spawn(options.command, args, {
        cwd: options.cwd,
        env: { ...process.env, [FEEDBACK_CAPTURE_ENV]: feedbackPath },
        stdio: "inherit",
      });
      this.child = child;
      this.pid = child.pid;
      child.once("error", (error) => {
        this.finish({
          exitCode: 1,
          detail: `Hunk startup failed: ${error.message}`,
        });
      });
      child.once("exit", (exitCode, signal) => {
        this.finish({
          exitCode: exitCode ?? 1,
          ...(signal ? { signal } : {}),
        });
      });

      if (this.pid !== undefined && Number.isInteger(this.pid) && this.pid > 0) {
        options.onStart(this.pid);
      }
    } catch (error) {
      // Keep constructor completion deterministic for ctx.ui.custom(): the
      // surface assigns this component before the failure callback runs.
      queueMicrotask(() => {
        this.finish({
          exitCode: 1,
          detail: `Hunk startup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
  }

  render(): string[] {
    return [];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.settled) return;
    const child = this.child;
    if (!child) {
      this.finish({ exitCode: 1, detail: "Hunk stopped before its process started." });
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill("SIGTERM")) {
      this.finish({ exitCode: 1, detail: "Hunk could not be terminated." });
      return;
    }
    this.forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, FORCE_KILL_DELAY_MS);
    this.forceKillTimer.unref();
  }

  private finish(result: HunkExit): void {
    if (this.settled) return;
    this.settled = true;
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }

    const notes = this.feedbackPath ? readCapturedNotes(this.feedbackPath) : undefined;
    const finalResult = notes === undefined ? result : { ...result, notes };
    if (this.feedbackDirectory) {
      try {
        rmSync(this.feedbackDirectory, { recursive: true, force: true });
      } catch {
        // Terminal ownership must return to Pi even if temporary-file cleanup fails.
      }
      this.feedbackDirectory = undefined;
      this.feedbackPath = undefined;
    }

    if (this.tuiStopped) {
      this.tuiStopped = false;
      try {
        this.tui.start();
        this.tui.requestRender(true);
      } catch {
        // Process completion is authoritative even if Pi cannot repaint.
      }
    }

    try {
      this.onExit(finalResult);
    } catch {
      // A lifecycle observer cannot keep the terminal takeover alive.
    }
  }
}
