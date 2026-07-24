import type { OverlaySize } from "../config.ts";

export type LaunchSource = "auto" | "live" | "manual" | "shortcut" | "recover" | "handoff";
export type SurfaceState = "closed" | "starting" | "visible" | "hidden" | "closing";

export interface OpenRequest {
  cwd: string;
  command: string;
  args: string[];
  source: LaunchSource;
  focus?: boolean;
}

export interface SurfaceSessionInfo {
  state: SurfaceState;
  /** Managed surface identity: normalized launch cwd, command, and argv. */
  argsKey: string;
  launchCwd: string;
  source: LaunchSource;
  /** OS pid of the managed Hunk PTY leader, when available. */
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

export function resolveOverlayRows(maxHeight: OverlaySize, terminalRows: number): number {
  const rows = Math.max(1, terminalRows);
  if (typeof maxHeight === "number") {
    return Math.max(1, Math.min(rows, Math.floor(maxHeight)));
  }

  const percentage = Number.parseFloat(maxHeight.slice(0, -1));
  if (Number.isFinite(percentage) && percentage > 0) {
    return Math.max(1, Math.min(rows, Math.floor((rows * percentage) / 100)));
  }
  return rows;
}
