/**
 * Mutation tracking is deliberately VCS-neutral. Hunk owns Git/Jujutsu/Sapling
 * detection; pi-hunk records only successful coding-tool evidence and safe
 * filesystem targets.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeCandidatePath } from "./path-routing.ts";

const MUTATION_TOOLS = /(^|[._:/-])(edit|write|patch|apply[_-]?patch)([._:/-]|$)/i;
const MUTATING_SHELL =
  /(?:^|[;&|\n])\s*(?:apply_patch\b|git\s+apply\b|jj\s+(?:abandon|commit|describe|duplicate|edit|new|rebase|restore|squash|undo)\b|sl\s+(?:amend|commit|goto|rebase|revert)\b|sed\s+-i\b|perl\s+-pi\b|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|truncate\b|npm\s+(?:install|uninstall|update)\b)/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;
/** Recognized interactive/login shells whose `-c` payload may hide mutations. */
const NESTED_SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh"]);
const COMMAND_PREFIX_WORDS = new Set(["!", "(", "{", "then", "do", "else", "elif"]);
const SIMPLE_COMMAND_WRAPPERS = new Set(["command", "exec", "nohup", "setsid"]);
const CONDITIONAL_COMMAND_PREFIX_WORDS = new Set([
  "!",
  "if",
  "then",
  "do",
  "else",
  "elif",
  "while",
  "until",
  "time",
  "coproc",
  "(",
  "{",
]);
const GIT_MUTATING_SUBCOMMANDS = new Set(["apply", "checkout", "mv", "restore", "rm"]);
const GIT_INFO_OPTIONS = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
]);
const GIT_FLAG_OPTIONS = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--bare",
]);
const GIT_VALUE_OPTIONS = new Set(["--git-dir", "--work-tree", "--namespace", "--config-env"]);
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
  const hereDocuments = maskHereDocumentBodies(command);
  const masked = maskQuotedShellText(hereDocuments.command);
  if (MUTATING_SHELL.test(masked) || hasFileOutputRedirection(masked)) return true;
  if (commandSubstitutionsLookMutating(hereDocuments.command, depth)) return true;
  for (const body of hereDocuments.expandableBodies) {
    if (commandSubstitutionsLookMutating(body, depth, false)) return true;
  }

  for (const segment of splitSimpleShellCommands(hereDocuments.command)) {
    const extracted = extractNestedShellPayload(segment);
    if (extracted === "ambiguous" || extracted === "mutating") return true;
    if (typeof extracted === "string" && shellCommandLooksMutating(extracted, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Any redirection token with write capability can create or truncate a filesystem entry. */
function hasFileOutputRedirection(maskedCommand: string): boolean {
  let inConditional = false;
  let arithmeticDepth = 0;

  for (let i = 0; i < maskedCommand.length; i += 1) {
    const char = maskedCommand[i]!;

    if (inConditional) {
      if (
        char === "]" &&
        maskedCommand[i + 1] === "]" &&
        isShellTokenBoundary(maskedCommand[i + 2])
      ) {
        inConditional = false;
        i += 1;
      }
      continue;
    }

    if (arithmeticDepth > 0) {
      if (char === "(") arithmeticDepth += 1;
      else if (char === ")") arithmeticDepth -= 1;
      continue;
    }

    if (
      char === "[" &&
      isShellCommandPosition(maskedCommand, i) &&
      maskedCommand[i + 1] === "[" &&
      isShellTokenBoundary(maskedCommand[i - 1]) &&
      isShellTokenBoundary(maskedCommand[i + 2])
    ) {
      inConditional = true;
      i += 1;
      continue;
    }

    if (char === "(" && maskedCommand[i + 1] === "(") {
      arithmeticDepth = 2;
      i += 1;
      continue;
    }

    if (char === "<") {
      // Here-strings feed stdin and never name an output file.
      if (maskedCommand.startsWith("<<<", i)) {
        i += 2;
        continue;
      }
      // Bash `<>` opens its target for both reading and writing.
      if (maskedCommand[i + 1] === ">") return true;
      continue;
    }

    if (char !== ">") continue;
    // Process substitutions are inspected recursively by
    // commandSubstitutionsLookMutating().
    if (maskedCommand[i + 1] === "(") continue;
    if (maskedCommand[i + 1] === "&" && isLiteralFileDescriptorTarget(maskedCommand, i + 2)) {
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}

/** `>&` duplicates or closes only literal descriptor targets; every other word may be a file. */
function isLiteralFileDescriptorTarget(maskedCommand: string, start: number): boolean {
  let cursor = start;
  while (maskedCommand[cursor] === " " || maskedCommand[cursor] === "\t") cursor += 1;

  if (maskedCommand[cursor] === "-") {
    return isShellRedirectionWordBoundary(maskedCommand[cursor + 1]);
  }

  const digitsStart = cursor;
  while (/[0-9]/.test(maskedCommand[cursor] ?? "")) cursor += 1;
  if (cursor === digitsStart) return false;
  if (maskedCommand[cursor] === "-") cursor += 1;
  return isShellRedirectionWordBoundary(maskedCommand[cursor]);
}

function isShellRedirectionWordBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s;&|()<>]/.test(char);
}

function isShellTokenBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s;&|(){}]/.test(char);
}

interface PreviousShellWord {
  start: number;
  value: string;
}

/**
 * `[[` is conditional grammar only where a command may begin. Walk backward
 * through reserved grammar prefixes; an assignment, leading redirection, or
 * existing command word makes `[[` an ordinary command name or argument.
 */
function isShellCommandPosition(maskedCommand: string, offset: number): boolean {
  let cursor = offset;
  while (
    maskedCommand[cursor - 1] === " " ||
    maskedCommand[cursor - 1] === "\t" ||
    maskedCommand[cursor - 1] === "\r"
  ) {
    cursor -= 1;
  }
  if (cursor === 0) return true;

  const previous = maskedCommand[cursor - 1]!;
  if (previous === "\n" || previous === ";") return true;
  if (
    (previous === "&" || previous === "|") &&
    maskedCommand[cursor - 2] !== ">" &&
    maskedCommand[cursor - 2] !== "<"
  ) {
    return true;
  }

  const word = previousShellWord(maskedCommand, cursor);
  if (!word) return true;

  if (CONDITIONAL_COMMAND_PREFIX_WORDS.has(word.value)) {
    return isShellCommandPosition(maskedCommand, word.start);
  }
  return false;
}

function previousShellWord(maskedCommand: string, offset: number): PreviousShellWord | undefined {
  let end = offset;
  while (
    maskedCommand[end - 1] === " " ||
    maskedCommand[end - 1] === "\t" ||
    maskedCommand[end - 1] === "\r"
  ) {
    end -= 1;
  }
  if (end === 0 || maskedCommand[end - 1] === "\n" || maskedCommand[end - 1] === ";") {
    return undefined;
  }

  let start = end;
  while (start > 0) {
    const char = maskedCommand[start - 1]!;
    if (/\s/.test(char) || char === ";") break;
    if (
      (char === "&" || char === "|") &&
      maskedCommand[start - 2] !== ">" &&
      maskedCommand[start - 2] !== "<"
    ) {
      break;
    }
    start -= 1;
  }
  return start === end ? undefined : { start, value: maskedCommand.slice(start, end) };
}

/** Inspect executable command/process substitutions while leaving quoted prose masked. */
function commandSubstitutionsLookMutating(
  command: string,
  depth: number,
  quotesAreSyntax = true,
): boolean {
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && (!quotesAreSyntax || quote !== "'")) {
      escaping = true;
      continue;
    }
    if (quotesAreSyntax && char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (quotesAreSyntax && char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quotesAreSyntax && quote === "'") continue;

    // Arithmetic expansion is not command substitution. Continue scanning its
    // contents so a real nested `$(...)` mutation is still inspected below.
    if (char === "$" && command.startsWith("$((", i)) continue;
    if ((char === "$" || char === "<" || char === ">") && command[i + 1] === "(") {
      const substitution = readParenthesizedShell(command, i + 2);
      if (substitution === "ambiguous") return true;
      if (shellCommandLooksMutating(substitution.value, depth + 1)) return true;
      i = substitution.end;
      continue;
    }
    if (char === "`") {
      let end = i + 1;
      let backtickEscape = false;
      for (; end < command.length; end += 1) {
        const nested = command[end]!;
        if (backtickEscape) {
          backtickEscape = false;
          continue;
        }
        if (nested === "\\") {
          backtickEscape = true;
          continue;
        }
        if (nested === "`") break;
      }
      if (end >= command.length) return true;
      if (shellCommandLooksMutating(command.slice(i + 1, end), depth + 1)) return true;
      i = end;
    }
  }
  return false;
}

function readParenthesizedShell(
  command: string,
  start: number,
): { value: string; end: number } | "ambiguous" {
  let nesting = 1;
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (let i = start; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote) continue;
    if (char === "(") nesting += 1;
    else if (char === ")") {
      nesting -= 1;
      if (nesting === 0) return { value: command.slice(start, i), end: i };
    }
  }
  return "ambiguous";
}

interface HereDocumentDelimiter {
  value: string;
  quoted: boolean;
  stripTabs: boolean;
}

interface HereDocumentMask {
  command: string;
  expandableBodies: string[];
}

interface TextRange {
  start: number;
  end: number;
}

/** Remove here-document data from shell syntax while retaining executable unquoted expansions. */
function maskHereDocumentBodies(command: string): HereDocumentMask {
  const syntax = maskQuotedShellText(command);
  const pending: HereDocumentDelimiter[] = [];
  const maskedRanges: TextRange[] = [];
  const expandableBodies: string[] = [];
  let inConditional = false;
  let arithmeticDepth = 0;

  for (let i = 0; i < syntax.length; i += 1) {
    const char = syntax[i]!;

    if (char === "\n" && pending.length > 0 && !isEscapedShellNewline(command, i)) {
      let bodyStart = i + 1;
      for (const hereDocument of pending.splice(0, pending.length)) {
        const body = findHereDocumentBody(command, bodyStart, hereDocument);
        if (!hereDocument.quoted) {
          expandableBodies.push(command.slice(bodyStart, body.contentEnd));
        }
        maskedRanges.push({ start: bodyStart, end: body.rangeEnd });
        bodyStart = body.rangeEnd;
      }
      i = bodyStart - 1;
      continue;
    }

    if (char === "#" && isShellCommentStart(syntax, i)) {
      const newline = syntax.indexOf("\n", i + 1);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }

    if (inConditional) {
      if (char === "]" && syntax[i + 1] === "]" && isShellTokenBoundary(syntax[i + 2])) {
        inConditional = false;
        i += 1;
      }
      continue;
    }

    if (arithmeticDepth > 0) {
      if (char === "(") arithmeticDepth += 1;
      else if (char === ")") arithmeticDepth -= 1;
      continue;
    }

    if (
      char === "[" &&
      syntax[i + 1] === "[" &&
      isShellTokenBoundary(syntax[i - 1]) &&
      isShellTokenBoundary(syntax[i + 2]) &&
      isShellCommandPosition(syntax, i)
    ) {
      inConditional = true;
      i += 1;
      continue;
    }

    if (char === "(" && syntax[i + 1] === "(") {
      arithmeticDepth = 2;
      i += 1;
      continue;
    }

    if (char !== "<" || syntax[i + 1] !== "<" || syntax[i + 2] === "<") continue;

    let delimiterStart = i + 2;
    let stripTabs = false;
    if (syntax[delimiterStart] === "-") {
      stripTabs = true;
      delimiterStart += 1;
    }
    while (syntax[delimiterStart] === " " || syntax[delimiterStart] === "\t") {
      delimiterStart += 1;
    }

    const delimiter = readHereDocumentDelimiter(command, delimiterStart);
    if (!delimiter) continue;
    pending.push({ value: delimiter.value, quoted: delimiter.quoted, stripTabs });
    maskedRanges.push({ start: delimiterStart, end: delimiter.end });
    i = delimiter.end - 1;
  }

  return {
    command: maskShellRanges(command, maskedRanges),
    expandableBodies,
  };
}

function readHereDocumentDelimiter(
  command: string,
  start: number,
): { value: string; quoted: boolean; end: number } | undefined {
  let cursor = start;
  let value = "";
  let quote: "'" | '"' | undefined;
  let quoted = false;
  let consumed = false;

  while (cursor < command.length) {
    const char = command[cursor]!;
    if (quote === "'") {
      consumed = true;
      if (char === "'") quote = undefined;
      else value += char;
      cursor += 1;
      continue;
    }
    if (quote === '"') {
      consumed = true;
      if (char === '"') {
        quote = undefined;
        cursor += 1;
        continue;
      }
      if (char === "\\") {
        const next = command[cursor + 1];
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          quoted = true;
          if (next !== "\n") value += next;
          cursor += 2;
          continue;
        }
      }
      value += char;
      cursor += 1;
      continue;
    }

    if (/[\s;&|()<>]/.test(char)) break;
    consumed = true;
    if (char === "\\") {
      quoted = true;
      const next = command[cursor + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") value += next;
      cursor += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = true;
      if (value.endsWith("$") && command[cursor - 1] === "$") {
        value = value.slice(0, -1);
      }
      quote = char;
      cursor += 1;
      continue;
    }
    value += char;
    cursor += 1;
  }

  if (!consumed || quote) return undefined;
  return { value, quoted, end: cursor };
}

function findHereDocumentBody(
  command: string,
  start: number,
  hereDocument: HereDocumentDelimiter,
): { contentEnd: number; rangeEnd: number } {
  let cursor = start;
  while (cursor <= command.length) {
    const newline = command.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? command.length : newline;
    const contentEnd = command[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    let delimiterStart = cursor;
    if (hereDocument.stripTabs) {
      while (command[delimiterStart] === "\t") delimiterStart += 1;
    }
    if (command.slice(delimiterStart, contentEnd) === hereDocument.value) {
      return {
        contentEnd: cursor,
        rangeEnd: newline < 0 ? lineEnd : lineEnd + 1,
      };
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return { contentEnd: command.length, rangeEnd: command.length };
}

function isEscapedShellNewline(command: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; command[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isShellCommentStart(command: string, index: number): boolean {
  return index === 0 || /[\s;&|()]/.test(command[index - 1]!);
}

function maskShellRanges(command: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return command;
  ranges.sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    result += command.slice(cursor, start);
    result += command.slice(start, range.end).replace(/[^\n]/g, " ");
    cursor = range.end;
  }
  return result + command.slice(cursor);
}

/** Preserve syntax and token boundaries while replacing quoted data with inert placeholders. */
function maskQuotedShellText(command: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      result += "x";
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      result += "x";
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      result += "x";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += "x";
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

function gitCommandLooksMutating(args: string[]): boolean | "ambiguous" {
  let index = 0;
  while (index < args.length) {
    const argument = args[index]!;
    if (GIT_INFO_OPTIONS.has(argument)) return false;
    if (argument.startsWith("--exec-path=")) {
      index += 1;
      continue;
    }
    if (GIT_FLAG_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument === "-C" || argument === "-c") {
      if (index + 1 >= args.length) return "ambiguous";
      index += 2;
      continue;
    }
    if ((argument.startsWith("-C") || argument.startsWith("-c")) && argument.length > 2) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const option = separator < 0 ? argument : argument.slice(0, separator);
      if (!GIT_VALUE_OPTIONS.has(option)) return "ambiguous";
      if (separator >= 0) {
        if (separator === argument.length - 1) return "ambiguous";
        index += 1;
        continue;
      }
      if (index + 1 >= args.length) return "ambiguous";
      index += 2;
      continue;
    }
    if (argument.startsWith("-")) return "ambiguous";
    return GIT_MUTATING_SUBCOMMANDS.has(argument);
  }

  const command = args[index];
  return command === undefined ? false : GIT_MUTATING_SUBCOMMANDS.has(command);
}

function directCommandLooksMutating(
  words: ShellWord[],
  commandIndex: number,
  wrapperDepth = 0,
): boolean | "ambiguous" {
  if (wrapperDepth > MAX_NESTED_SHELL_DEPTH || commandIndex >= words.length) return "ambiguous";

  while (COMMAND_PREFIX_WORDS.has(words[commandIndex]?.value ?? "")) commandIndex += 1;
  if (commandIndex >= words.length) return false;

  // Arithmetic commands are shell grammar, not dynamically named utilities.
  // Redirects around them and nested command substitutions were handled above.
  if (/^[({!]*\(\(/.test(words[commandIndex]!.value)) return false;
  const rawCommand = words[commandIndex]!.value.replace(/^[({!]+/, "");
  if (!rawCommand) return "ambiguous";
  if (/[$`]/.test(rawCommand)) return "ambiguous";
  const command = commandBasename(rawCommand);
  const args = words.slice(commandIndex + 1).map((word) => word.value);

  if (isNestedShellName(rawCommand)) {
    return nestedShellWordsLookMutating(words, commandIndex + 1, wrapperDepth);
  }

  if (
    command === "apply_patch" ||
    command === "patch" ||
    command === "tee" ||
    command === "mv" ||
    command === "cp" ||
    command === "rm" ||
    command === "touch" ||
    command === "mkdir" ||
    command === "truncate" ||
    command === "install" ||
    command === "ln" ||
    command === "chmod" ||
    command === "chown" ||
    command === "chgrp"
  ) {
    return true;
  }
  if (command === "git") return gitCommandLooksMutating(args);
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

  if (command === "eval") {
    if (args.length === 0) return false;
    const payload = args.join(" ");
    return /[$`]/.test(payload) || shellCommandLooksMutating(payload, wrapperDepth + 1);
  }
  if (command === "source" || command === ".") return "ambiguous";

  if (SIMPLE_COMMAND_WRAPPERS.has(command)) {
    let nested = commandIndex + 1;
    if (command === "command" && ["-v", "-V"].includes(words[nested]?.value ?? "")) return false;
    while (nested < words.length && words[nested]!.value.startsWith("-")) {
      const option = words[nested]!.value;
      nested += 1;
      if (command === "exec" && option === "-a") {
        if (nested >= words.length) return "ambiguous";
        nested += 1;
      }
      if (option === "--") break;
    }
    return directCommandLooksMutating(words, nested, wrapperDepth + 1);
  }

  if (command === "sudo" || command === "doas") {
    const nested = commandAfterPrivilegeWrapper(words, commandIndex + 1, command);
    return nested === "ambiguous"
      ? "ambiguous"
      : directCommandLooksMutating(words, nested, wrapperDepth + 1);
  }

  if (command === "nice") {
    let nested = commandIndex + 1;
    if (words[nested]?.value === "-n" || words[nested]?.value === "--adjustment") nested += 2;
    else if (/^(?:-[0-9]+|--adjustment=)/.test(words[nested]?.value ?? "")) nested += 1;
    return directCommandLooksMutating(words, nested, wrapperDepth + 1);
  }

  if (command === "timeout") {
    let nested = commandIndex + 1;
    while (nested < words.length && words[nested]!.value.startsWith("-")) {
      const option = words[nested]!.value;
      nested += 1;
      if (["-k", "--kill-after", "-s", "--signal"].includes(option)) nested += 1;
      if (nested > words.length) return "ambiguous";
    }
    // The first positional argument is timeout's duration.
    if (nested >= words.length) return "ambiguous";
    return directCommandLooksMutating(words, nested + 1, wrapperDepth + 1);
  }

  if (command === "xargs") {
    const nested = commandAfterXargsOptions(words, commandIndex + 1);
    // xargs defaults to `echo` when no command is supplied.
    return nested === undefined
      ? false
      : nested === "ambiguous"
        ? "ambiguous"
        : directCommandLooksMutating(words, nested, wrapperDepth + 1);
  }

  if (command === "find") {
    if (args.includes("-delete")) return true;
    const execIndex = words.findIndex(
      (word, index) =>
        index > commandIndex && ["-exec", "-execdir", "-ok", "-okdir"].includes(word.value),
    );
    return execIndex === -1
      ? false
      : directCommandLooksMutating(words, execIndex + 1, wrapperDepth + 1);
  }

  if (command === "dd") return args.some((arg) => arg.startsWith("of="));

  return false;
}

function nestedShellWordsLookMutating(
  words: ShellWord[],
  start: number,
  depth: number,
): boolean | "ambiguous" {
  let i = start;
  while (i < words.length) {
    const word = words[i]!.value;
    if (word === "--") return false;
    if (!word.startsWith("-") || word === "-") return false;
    if (word.startsWith("--")) {
      const [flag] = word.split("=", 1);
      i += 1;
      if (SHELL_VALUE_LONG_FLAGS.has(flag!) && !word.includes("=")) {
        if (i >= words.length) return "ambiguous";
        i += 1;
      }
      continue;
    }
    const flags = word.slice(1);
    if (flags.includes("c")) {
      i += 1;
      if (i >= words.length) return "ambiguous";
      const payload = words[i]!.value;
      // A runtime-generated command string cannot be classified from argv.
      if (/^\s*(?:\$|`)/.test(payload)) return "ambiguous";
      return shellCommandLooksMutating(payload, depth + 1);
    }
    const valueFlagIndex = [...flags].findIndex((flag) => flag === "o" || flag === "O");
    i += 1;
    if (valueFlagIndex >= 0 && valueFlagIndex === flags.length - 1) {
      if (i >= words.length) return "ambiguous";
      i += 1;
    }
  }
  return false;
}

function commandAfterPrivilegeWrapper(
  words: ShellWord[],
  start: number,
  wrapper: "sudo" | "doas",
): number | "ambiguous" {
  const valueOptions =
    wrapper === "sudo"
      ? new Set([
          "-C",
          "-D",
          "-R",
          "-T",
          "-g",
          "-h",
          "-p",
          "-r",
          "-t",
          "-u",
          "--chdir",
          "--chroot",
          "--close-from",
          "--command-timeout",
          "--group",
          "--host",
          "--other-user",
          "--prompt",
          "--role",
          "--type",
          "--user",
        ])
      : new Set(["-C", "-u"]);
  const noValueOptions =
    wrapper === "sudo"
      ? new Set([
          "-A",
          "-E",
          "-H",
          "-K",
          "-S",
          "-V",
          "-b",
          "-e",
          "-k",
          "-l",
          "-n",
          "-s",
          "-v",
          "--askpass",
          "--background",
          "--edit",
          "--help",
          "--list",
          "--login",
          "--non-interactive",
          "--preserve-env",
          "--remove-timestamp",
          "--reset-timestamp",
          "--set-home",
          "--shell",
          "--stdin",
          "--validate",
          "--version",
        ])
      : new Set(["-L", "-n", "-s"]);
  let i = start;
  while (i < words.length) {
    const word = words[i]!.value;
    if (word === "--") return i + 1;
    if (isEnvironmentAssignment(word)) {
      i += 1;
      continue;
    }
    if (!word.startsWith("-") || word === "-") return i;
    const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (valueOptions.has(option)) {
      i += word.includes("=") ? 1 : 2;
      if (i > words.length) return "ambiguous";
      continue;
    }
    if (noValueOptions.has(option)) {
      i += 1;
      continue;
    }
    // Unknown options can change which following word is the utility.
    return "ambiguous";
  }
  return "ambiguous";
}

function commandAfterXargsOptions(
  words: ShellWord[],
  start: number,
): number | "ambiguous" | undefined {
  const valueOptions = new Set([
    "-a",
    "--arg-file",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
  ]);
  let i = start;
  while (i < words.length) {
    const word = words[i]!.value;
    if (word === "--") return i + 1 < words.length ? i + 1 : undefined;
    if (!word.startsWith("-") || word === "-") return i;
    const equals = word.indexOf("=");
    const option = equals === -1 ? word : word.slice(0, equals);
    i += 1;
    if (valueOptions.has(option) && equals === -1) {
      if (i >= words.length) return "ambiguous";
      i += 1;
    }
  }
  return undefined;
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
      // GNU env treats a lone "-" as -i (ignore environment).
      if (word === "-") {
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
  while (i < words.length && COMMAND_PREFIX_WORDS.has(words[i]!.value)) i += 1;
  if (i >= words.length) return undefined;

  const direct = directCommandLooksMutating(words, i);
  if (direct === "ambiguous") return "ambiguous";
  if (direct) return "mutating";

  if (!isNestedShellName(words[i]!.value)) {
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
    if (rawPath.length === 0)
      throw new Error("Invalid mutation target: the path must not be empty.");
    if (rawPath.includes("\0")) {
      throw new Error("Invalid mutation target: NUL bytes are not allowed.");
    }
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
    // Whitespace is legal in a filesystem name, including at both boundaries.
    // Empty strings and NUL bytes are rejected by the normalization pass.
    if (typeof value === "string") paths.push(value);
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
