/**
 * Mutation tracking is deliberately VCS-neutral. Hunk owns Git/Jujutsu/Sapling
 * detection; pi-hunk opens review only from successful coding-tool evidence.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

const MUTATION_TOOLS = /(^|[._:/-])(edit|write|patch|apply[_-]?patch)([._:/-]|$)/i;
const MUTATING_SHELL =
  /(?:^|[;&|\n])\s*(?:apply_patch\b|git\s+apply\b|jj\s+(?:abandon|commit|describe|duplicate|edit|new|rebase|restore|squash|undo)\b|sl\s+(?:amend|commit|goto|rebase|revert)\b|sed\s+-i\b|perl\s+-pi\b|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|truncate\b|npm\s+(?:install|uninstall|update)\b|(?:cat|echo|printf)\b[^;&|]*>)/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

export function isMutation(toolName: string, args: unknown): boolean {
  if (MUTATION_TOOLS.test(toolName)) return true;
  if (!/(^|[._:/-])bash([._:/-]|$)/i.test(toolName)) return false;
  if (!args || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && MUTATING_SHELL.test(maskQuotedShellText(command));
}

/** Preserve shell operators and command names while removing quoted data. */
function maskQuotedShellText(command: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      result += " ";
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      result += " ";
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      result += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

/** True when a mutation tool's structured path is lexically inside Pi's cwd. */
export function isWorkspaceMutation(toolName: string, args: unknown, cwd: string): boolean {
  if (!isMutation(toolName, args)) return false;
  if (!MUTATION_TOOLS.test(toolName)) return true;

  const paths = mutationTargetPaths(args);
  if (paths.length === 0) return true;
  return paths.some((path) => isWorkspacePath(path, cwd));
}

/** Best-effort path extraction from mutation tool args. */
export function mutationTargetPath(args: unknown, cwd?: string): string | undefined {
  const paths = mutationTargetPaths(args);
  if (!cwd) return paths[0];
  return paths.find((path) => isWorkspacePath(path, cwd));
}

/** Make a tool path relative to Pi's workspace without assuming a VCS root. */
export function toWorkspaceRelative(path: string, cwd: string): string {
  if (!isWorkspacePath(path, cwd)) return path;
  const root = resolve(cwd);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return relative(root, absolutePath) || ".";
}

function mutationTargetPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  collectPaths(record, paths);
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      if (!edit || typeof edit !== "object") continue;
      collectPaths(edit as Record<string, unknown>, paths);
    }
  }
  return paths;
}

function collectPaths(record: Record<string, unknown>, paths: string[]): void {
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
}

function isWorkspacePath(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const child = relative(root, absolutePath);
  return child === "" || (!isParentRelative(child) && !isAbsolute(child));
}

function isParentRelative(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`);
}

export interface SettledEvidence {
  /** A successful coding mutation ran in the current agent turn. */
  mutation: boolean;
}

/** Tracks successful mutation tools and their arguments within one agent run. */
export class ChangeDetector {
  private changedSinceReview = false;
  private readonly toolArgs = new Map<string, unknown>();

  markChanged(): void {
    this.changedSinceReview = true;
  }

  rememberToolArgs(toolCallId: string, args: unknown): void {
    this.toolArgs.set(toolCallId, args);
  }

  takeToolArgs(toolCallId: string): unknown {
    const args = this.toolArgs.get(toolCallId);
    this.toolArgs.delete(toolCallId);
    return args;
  }

  clearToolArgs(): void {
    this.toolArgs.clear();
  }

  consumeSettled(): SettledEvidence {
    const mutation = this.changedSinceReview;
    this.changedSinceReview = false;
    this.clearToolArgs();
    return { mutation };
  }

  reset(): void {
    this.changedSinceReview = false;
    this.toolArgs.clear();
  }
}
