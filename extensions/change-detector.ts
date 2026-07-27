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
/** Recognized interactive/login shells whose `-c` payload may hide mutations. */
const NESTED_SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash"]);
/** Bound pathological nesting / command-substitution style chains. */
const MAX_NESTED_SHELL_DEPTH = 4;
const MAX_ENV_SPLIT_EXPANSIONS = 4;
const MAX_ENV_SPLIT_WORDS = 4_096;
const MAX_SHELL_COMMAND_LENGTH = 100_000;
/** Wrapper options whose values must be skipped before locating the utility/`-c`. */
const ENV_VALUE_SHORT_FLAGS = new Set(["u", "C", "S"]);
const ENV_VALUE_LONG_FLAGS = new Set(["--argv0", "--chdir", "--split-string", "--unset"]);
const SHELL_VALUE_LONG_FLAGS = new Set(["--init-file", "--rcfile"]);

export function isMutation(toolName: string, args: unknown): boolean {
  if (MUTATION_TOOLS.test(toolName)) return true;
  if (!/(^|[._:/-])bash([._:/-]|$)/i.test(toolName)) return false;
  if (!args || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && shellCommandLooksMutating(command);
}

/**
 * Detect mutating shell syntax, including payloads hidden inside recognized
 * nested wrappers (`bash -lc '…'`, `env … sh -c "…"`). Quoted prose is still
 * masked so `echo "please rm the file"` stays non-mutating. Ambiguous wrapper
 * parsing is treated as mutating so callers record unresolved evidence rather
 * than silently classifying the command as read-only.
 */
function shellCommandLooksMutating(command: string, depth = 0): boolean {
  if (depth > MAX_NESTED_SHELL_DEPTH || command.length > MAX_SHELL_COMMAND_LENGTH) {
    return true;
  }
  if (MUTATING_SHELL.test(maskQuotedShellText(command))) return true;

  for (const segment of splitSimpleShellCommands(command)) {
    const extracted = extractNestedShellPayload(segment);
    if (extracted === "ambiguous" || extracted === "mutating") return true;
    if (typeof extracted === "string" && shellCommandLooksMutating(extracted, depth + 1)) {
      return true;
    }
  }
  return false;
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

/** Split on unquoted `;`, `|`, `&`, newlines, `&&`, and `||`. */
function splitSimpleShellCommands(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";") {
      parts.push(command.slice(start, i));
      start = i + 1;
      continue;
    }
    if (char === "&" || char === "|") {
      parts.push(command.slice(start, i));
      if (command[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  parts.push(command.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

interface ShellWord {
  value: string;
  /** Raw token offset retains quoting when a peeled command is rescanned. */
  start: number;
}

type ShellWords = { words: ShellWord[]; unclosedQuote: boolean };

/** Tokenize one simple command into words with quote/escape processing. */
function tokenizeShellWords(segment: string): ShellWords {
  const words: ShellWord[] = [];
  let i = 0;
  let unclosedQuote = false;

  while (i < segment.length) {
    while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) i += 1;
    if (i >= segment.length) break;

    const start = i;
    let value = "";
    let quote: "'" | '"' | undefined;

    while (i < segment.length) {
      const char = segment[i]!;
      if (quote === "'") {
        if (char === "'") {
          quote = undefined;
          i += 1;
          continue;
        }
        value += char;
        i += 1;
        continue;
      }
      // Single-quoted text already returned above; backslash escapes apply outside it.
      if (char === "\\") {
        i += 1;
        if (i < segment.length) {
          value += segment[i]!;
          i += 1;
        }
        continue;
      }
      if (quote === '"') {
        if (char === '"') {
          quote = undefined;
          i += 1;
          continue;
        }
        value += char;
        i += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        i += 1;
        continue;
      }
      if (char === " " || char === "\t") break;
      value += char;
      i += 1;
    }

    if (quote) unclosedQuote = true;
    words.push({ value, start });
  }

  return { words, unclosedQuote };
}

function tokenizeEnvSplitString(value: string): ShellWords | "ambiguous" {
  const words: ShellWord[] = [];
  let i = 0;

  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i]!)) i += 1;
    if (i >= value.length) break;

    let word = "";
    let quote: "'" | '"' | undefined;
    while (i < value.length) {
      const char = value[i]!;
      if (!quote && /\s/.test(char)) break;
      if (char === "\\" && quote !== "'") {
        i += 1;
        if (i >= value.length) return "ambiguous";
        // GNU env gives several alphabetic escapes special meanings (including
        // separators and early termination). Leave those uncommon forms as
        // mutation evidence rather than approximating their argv.
        if (/[cfnrtv_]/.test(value[i]!)) return "ambiguous";
        word += value[i]!;
        i += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = undefined;
        else {
          if (quote === '"' && (char === "$" || char === "`")) return "ambiguous";
          word += char;
        }
        i += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        i += 1;
        continue;
      }
      // Split-string performs variable expansion and has comment handling of
      // its own. Their resulting argv depends on runtime/parser details.
      if (char === "$" || char === "`" || char === "#") return "ambiguous";
      word += char;
      i += 1;
    }
    if (quote) return "ambiguous";
    words.push({ value: word, start: -1 });
  }

  return { words, unclosedQuote: false };
}

function commandBasename(word: string): string {
  const normalized = word.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return (slash === -1 ? normalized : normalized.slice(slash + 1)).toLowerCase();
}

function isNestedShellName(word: string): boolean {
  return NESTED_SHELL_NAMES.has(commandBasename(word));
}

function isEnvironmentAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function directCommandLooksMutating(words: ShellWord[], commandIndex: number): boolean {
  const command = commandBasename(words[commandIndex]!.value);
  const args = words.slice(commandIndex + 1).map((word) => word.value);

  if (
    command === "apply_patch" ||
    command === "tee" ||
    command === "mv" ||
    command === "cp" ||
    command === "rm" ||
    command === "touch" ||
    command === "mkdir" ||
    command === "truncate"
  ) {
    return true;
  }
  if (command === "git") return args[0] === "apply";
  if (command === "jj") {
    return new Set([
      "abandon",
      "commit",
      "describe",
      "duplicate",
      "edit",
      "new",
      "rebase",
      "restore",
      "squash",
      "undo",
    ]).has(args[0] ?? "");
  }
  if (command === "sl") {
    return new Set(["amend", "commit", "goto", "rebase", "revert"]).has(args[0] ?? "");
  }
  if (command === "sed") return args[0] === "-i" || args[0]?.startsWith("-i") === true;
  if (command === "perl") return args[0]?.startsWith("-pi") === true;
  if (command === "npm") return ["install", "uninstall", "update"].includes(args[0] ?? "");
  return false;
}

/**
 * If `segment` is a recognized shell (optionally under assignments/`env …`)
 * with `-c`/`-lc`, return its command string. `"mutating"` means peeling a
 * wrapper exposed a direct mutator; `"ambiguous"` means a payload or required
 * option value could not be recovered safely.
 */
function extractNestedShellPayload(segment: string): string | "ambiguous" | "mutating" | undefined {
  const tokenized = tokenizeShellWords(segment);
  if (tokenized.unclosedQuote) return "ambiguous";
  const words = tokenized.words;
  if (words.length === 0) return undefined;

  let i = 0;
  let envSplitExpansions = 0;
  let hadEnvSplit = false;
  while (i < words.length && isEnvironmentAssignment(words[i]!.value)) i += 1;

  // Peel one or more `env` prefixes and their assignments/flags. GNU env's
  // split-string options inject their parsed words back into the remaining
  // argv, so options, assignments, commands, and trailing outer argv all keep
  // their normal positions.
  while (i < words.length && commandBasename(words[i]!.value) === "env") {
    i += 1;
    while (i < words.length) {
      const word = words[i]!.value;
      if (word === "--") {
        i += 1;
        break;
      }
      if (isEnvironmentAssignment(word)) {
        i += 1;
        continue;
      }
      if (word.startsWith("--")) {
        const equalsIndex = word.indexOf("=");
        const flag = equalsIndex === -1 ? word : word.slice(0, equalsIndex);
        if (flag === "--split-string") {
          const consumesNextWord = equalsIndex === -1;
          if (consumesNextWord && i + 1 >= words.length) return "ambiguous";
          const value = consumesNextWord ? words[i + 1]!.value : word.slice(equalsIndex + 1);
          const split = tokenizeEnvSplitString(value);
          envSplitExpansions += 1;
          hadEnvSplit = true;
          if (
            split === "ambiguous" ||
            envSplitExpansions > MAX_ENV_SPLIT_EXPANSIONS ||
            words.length - (consumesNextWord ? 2 : 1) + split.words.length > MAX_ENV_SPLIT_WORDS
          ) {
            return "ambiguous";
          }
          words.splice(i, consumesNextWord ? 2 : 1, ...split.words);
          continue;
        }
        if (ENV_VALUE_LONG_FLAGS.has(flag)) {
          i += 1;
          if (equalsIndex !== -1) continue;
          if (i >= words.length) return "ambiguous";
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      if (word.startsWith("-") && word !== "-") {
        const flags = word.slice(1);
        const valueFlagIndex = [...flags].findIndex((flag) => ENV_VALUE_SHORT_FLAGS.has(flag));
        if (valueFlagIndex >= 0 && flags[valueFlagIndex] === "S") {
          const attachedValue = flags.slice(valueFlagIndex + 1);
          const consumesNextWord = attachedValue.length === 0;
          if (consumesNextWord && i + 1 >= words.length) return "ambiguous";
          const value = consumesNextWord ? words[i + 1]!.value : attachedValue;
          const split = tokenizeEnvSplitString(value);
          envSplitExpansions += 1;
          hadEnvSplit = true;
          if (
            split === "ambiguous" ||
            envSplitExpansions > MAX_ENV_SPLIT_EXPANSIONS ||
            words.length - (consumesNextWord ? 2 : 1) + split.words.length > MAX_ENV_SPLIT_WORDS
          ) {
            return "ambiguous";
          }
          words.splice(i, consumesNextWord ? 2 : 1, ...split.words);
          continue;
        }
        i += 1;
        // A value-taking flag at the end of a cluster consumes the next word;
        // otherwise the remainder of that cluster is its attached value.
        if (valueFlagIndex >= 0 && valueFlagIndex === flags.length - 1) {
          if (i >= words.length) return "ambiguous";
          i += 1;
        }
        continue;
      }
      break;
    }
    while (i < words.length && isEnvironmentAssignment(words[i]!.value)) i += 1;
  }

  if (i >= words.length) return undefined;
  if (!isNestedShellName(words[i]!.value)) {
    if (hadEnvSplit && directCommandLooksMutating(words, i)) return "mutating";
    const start = words[i]!.start;
    const peeled = start >= 0 ? segment.slice(start) : "";
    return MUTATING_SHELL.test(maskQuotedShellText(peeled)) ? "mutating" : undefined;
  }
  i += 1;

  while (i < words.length) {
    const word = words[i]!.value;
    if (word === "--") break;
    if (!word.startsWith("-") || word === "-") break;

    if (word.startsWith("--")) {
      const [flag] = word.split("=", 1);
      i += 1;
      if (SHELL_VALUE_LONG_FLAGS.has(flag!) && !word.includes("=")) {
        if (i >= words.length) return "ambiguous";
        i += 1;
      }
      continue;
    }

    // Short clusters: `-c`, `-lc`, `-cl`, `-ec`, …
    const flags = word.slice(1);
    if (flags.includes("c")) {
      i += 1;
      if (i >= words.length) return "ambiguous";
      return words[i]!.value;
    }

    const valueFlagIndex = [...flags].findIndex((flag) => flag === "o" || flag === "O");
    i += 1;
    if (valueFlagIndex >= 0 && valueFlagIndex === flags.length - 1) {
      if (i >= words.length) return "ambiguous";
      i += 1;
    }
  }

  return undefined;
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
