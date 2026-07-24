/**
 * Mutation tracking is deliberately VCS-neutral. Hunk owns Git/Jujutsu/Sapling
 * detection; pi-hunk records only successful coding-tool evidence and safe
 * filesystem targets.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeCandidatePath } from "./path-routing.ts";

const MUTATION_TOOLS = /(^|[._:/-])(edit|write|patch|apply[_-]?patch)([._:/-]|$)/i;
const MUTATING_SHELL =
  /(?:^|[;&|\n])\s*(?:apply_patch\b|git\s+apply\b|jj\s+(?:abandon|commit|describe|duplicate|edit|new|rebase|restore|squash|undo)\b|sl\s+(?:amend|commit|goto|rebase|revert)\b|sed\s+-i\b|perl\s+-pi\b|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|truncate\b|npm\s+(?:install|uninstall|update)\b|(?:cat|echo|printf)\b[^;&|]*>)/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

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

/**
 * Compatibility predicate retained for consumers of the public extension
 * module. Automatic review now accepts successful targets outside Pi's cwd.
 */
export function isWorkspaceMutation(toolName: string, args: unknown, _cwd: string): boolean {
  return isMutation(toolName, args);
}

/** Extract every common structured mutation path in deterministic order. */
export function mutationTargetPaths(args: unknown, cwd?: string): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const rawPaths: string[] = [];
  collectPaths(record, rawPaths);
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      if (!edit || typeof edit !== "object") continue;
      collectPaths(edit as Record<string, unknown>, rawPaths);
    }
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of rawPaths) {
    const path = cwd === undefined ? rawPath : normalizeCandidatePath(rawPath, cwd);
    const key = cwd === undefined ? path : resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/** First structured mutation target, absolute when a Pi cwd is supplied. */
export function mutationTargetPath(args: unknown, cwd?: string): string | undefined {
  return mutationTargetPaths(args, cwd)[0];
}

/** Make a tool path relative to Pi's workspace without assuming a VCS root. */
export function toWorkspaceRelative(path: string, cwd: string): string {
  if (!isWorkspacePath(path, cwd)) return path;
  const root = resolve(cwd);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return relative(root, absolutePath) || ".";
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
  /** Absolute, lexically normalized structured targets in first-seen order. */
  targets: string[];
  /** At least one successful mutation had no trustworthy structured target. */
  unresolved: boolean;
  /** Monotonic successful-mutation revision for no-diff cache invalidation. */
  revision: number;
}

/** Tracks successful mutation tools and their arguments within one agent run. */
export class ChangeDetector {
  private changedSinceReview = false;
  private unresolvedSinceReview = false;
  private readonly targets: string[] = [];
  private readonly targetKeys = new Set<string>();
  private readonly toolArgs = new Map<string, unknown>();
  private revision = 0;

  /** Legacy pathless marker; prefer recordSuccessfulMutation at tool completion. */
  markChanged(): SettledEvidence {
    this.changedSinceReview = true;
    this.unresolvedSinceReview = true;
    this.revision += 1;
    return { mutation: true, targets: [], unresolved: true, revision: this.revision };
  }

  recordSuccessfulMutation(toolName: string, args: unknown, cwd: string): SettledEvidence {
    if (!isMutation(toolName, args)) return this.snapshot();

    this.changedSinceReview = true;
    const extractedTargets = mutationTargetPaths(args, cwd);
    if (extractedTargets.length === 0) {
      this.unresolvedSinceReview = true;
    } else {
      for (const target of extractedTargets) {
        const key = resolve(target);
        if (this.targetKeys.has(key)) continue;
        this.targetKeys.add(key);
        this.targets.push(target);
      }
    }
    this.revision += 1;
    return {
      mutation: true,
      targets: extractedTargets,
      unresolved: extractedTargets.length === 0,
      revision: this.revision,
    };
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

  peekSettled(): SettledEvidence {
    return this.snapshot();
  }

  consumeSettled(): SettledEvidence {
    const evidence = this.snapshot();
    this.changedSinceReview = false;
    this.unresolvedSinceReview = false;
    this.targets.length = 0;
    this.targetKeys.clear();
    this.clearToolArgs();
    return evidence;
  }

  reset(): void {
    this.changedSinceReview = false;
    this.unresolvedSinceReview = false;
    this.targets.length = 0;
    this.targetKeys.clear();
    this.toolArgs.clear();
  }

  private snapshot(): SettledEvidence {
    return {
      mutation: this.changedSinceReview,
      targets: [...this.targets],
      unresolved: this.unresolvedSinceReview,
      revision: this.revision,
    };
  }
}
