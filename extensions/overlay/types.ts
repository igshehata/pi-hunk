export type LaunchSource = "auto" | "live" | "manual" | "shortcut" | "recover";
export type SurfaceState = "closed" | "starting" | "visible" | "closing";

/** One saved inline Hunk note captured before the takeover process exits. */
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

export interface HunkExit {
  exitCode: number;
  signal?: NodeJS.Signals;
  detail?: string;
  /** Present when the bundled Hunk extension captured a final saved-note snapshot. */
  notes?: HunkReviewNote[];
}

export interface OpenRequest {
  cwd: string;
  command: string;
  args: string[];
  source: LaunchSource;
}

export interface SurfaceSessionInfo {
  state: SurfaceState;
  /** Normalized launch directory, command, and argv. */
  argsKey: string;
  launchCwd: string;
  source: LaunchSource;
  /** OS pid of the Hunk child process. */
  pid?: number;
  /** Authoritative metadata adopted from Hunk's exact managed-PID session. */
  sessionId?: string;
  repoRoot?: string;
  fileCount?: number;
  detail?: string;
}

export function argsKey(command: string, args: string[], cwd?: string): string {
  return JSON.stringify(cwd === undefined ? [command, ...args] : [cwd, command, ...args]);
}
