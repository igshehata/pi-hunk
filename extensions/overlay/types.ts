import type { OverlaySize } from "../config.ts";

export type LaunchSource = "auto" | "live" | "manual" | "shortcut" | "recover";
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

function resolveOverlaySize(size: OverlaySize, terminalSize: number): number {
  const available = Math.max(1, terminalSize);
  if (typeof size === "number") {
    return Math.max(1, Math.min(available, Math.floor(size)));
  }

  const percentage = Number.parseFloat(size.slice(0, -1));
  if (Number.isFinite(percentage) && percentage > 0) {
    return Math.max(1, Math.min(available, Math.floor((available * percentage) / 100)));
  }
  return available;
}

export function resolveOverlayColumns(width: OverlaySize, terminalColumns: number): number {
  return resolveOverlaySize(width, terminalColumns);
}

export function resolveOverlayRows(maxHeight: OverlaySize, terminalRows: number): number {
  return resolveOverlaySize(maxHeight, terminalRows);
}
