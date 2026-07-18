/**
 * /hunk command vocabulary: argv parsing for the passthrough `hunk <argv>`
 * exec and autocomplete for the single /hunk command. Pure string handling —
 * no config state, no I/O.
 */

export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
    } else if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (tokenStarted) args.push(current);
  return args;
}

/** Hunk CLI verbs supported by the managed interactive overlay. */
export const HUNK_VERBS = new Set(["diff", "show", "stash"]);

/** Entrypoints that depend on external stdin/file-pair integration rather than Pi's overlay. */
export const UNSUPPORTED_HUNK_VERBS = new Set(["patch", "pager", "difftool"]);

/**
 * First-token words the /hunk command reserves for its own subcommands. These
 * MUST stay disjoint from HUNK_VERBS so no reserved word shadows a passthrough
 * verb (asserted by a unit test).
 */
export const RESERVED_SUBCOMMANDS = new Set([
  "close",
  "toggle",
  "status",
  "feedback",
  "review",
  "config",
]);

/** Value suggestions by settings subcommand and argument position. */
function subcommandValues(
  first: string,
  argumentIndex: number,
  tokens: string[],
): string[] | undefined {
  if (first === "review") {
    if (argumentIndex === 1) return ["off", "after-run", "live"];
    return undefined;
  }
  if (first === "config") {
    if (argumentIndex === 1) return ["restore", "full", "left", "right", "float"];
    if (tokens[1] === "restore") return undefined;
    return ["experimental-wrap", "no-wrap"];
  }
  return undefined;
}

export interface HunkCompletion {
  value: string;
  label: string;
}

/**
 * Argument completions for the single /hunk command. `argumentText` is the full
 * text after "/hunk " up to the cursor (see pi-tui CombinedAutocompleteProvider).
 * The returned `value` replaces the entire argument text, so second-token
 * completions carry the earlier tokens forward.
 */
export function hunkArgumentCompletions(argumentText: string): HunkCompletion[] | null {
  const endsWithSpace = /\s$/.test(argumentText);
  const tokens = argumentText.split(/\s+/).filter(Boolean);
  const onFirstToken = tokens.length === 0 || (tokens.length === 1 && !endsWithSpace);

  if (onFirstToken) {
    const partial = tokens[0] ?? "";
    const candidates = [...RESERVED_SUBCOMMANDS, ...HUNK_VERBS];
    const items = candidates
      .filter((value) => value.startsWith(partial))
      .map((value) => ({ value, label: value }));
    return items.length > 0 ? items : null;
  }

  const first = tokens[0]!;
  const argumentIndex = endsWithSpace ? tokens.length : tokens.length - 1;
  const values = subcommandValues(first, argumentIndex, tokens);
  if (!values) return null;
  const partial = endsWithSpace ? "" : tokens[tokens.length - 1]!;
  const base = argumentText.slice(0, argumentText.length - partial.length);
  const items = values
    .filter((value) => value.startsWith(partial))
    .map((value) => ({ value: `${base}${value}`, label: value }));
  return items.length > 0 ? items : null;
}

export function resolveHunkArgs(input: string, defaults: string[]): string[] {
  const parsed = splitArgs(input);
  if (parsed.length === 0) return [...defaults];
  if (UNSUPPORTED_HUNK_VERBS.has(parsed[0]!)) {
    throw new Error(
      `Hunk ${parsed[0]} is not supported through /hunk; run it directly in a terminal.`,
    );
  }
  if (parsed[0] === "staged") return ["diff", "--staged", ...parsed.slice(1)];
  if (parsed[0]!.startsWith("-") || !HUNK_VERBS.has(parsed[0]!)) return ["diff", ...parsed];
  return parsed;
}
