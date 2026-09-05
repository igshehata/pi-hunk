import type { KeyId } from "@earendil-works/pi-tui";

export const HUNK_MODES = ["diff", "show", "stash"] as const;
export type HunkMode = (typeof HUNK_MODES)[number];

export interface Hotkeys {
  readonly prefix: KeyId;
  readonly diff: KeyId;
  readonly show: KeyId;
  readonly stash: KeyId;
}

export interface HunkConfig {
  readonly hotkeys: Hotkeys;
}

export const DEFAULT_CONFIG: HunkConfig = {
  hotkeys: {
    prefix: "ctrl+space",
    diff: "h",
    show: "s",
    stash: "t",
  },
};

export interface ReviewNote {
  readonly noteId: string;
  readonly file: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly oldRange: readonly [number, number] | null;
  readonly newRange: readonly [number, number] | null;
  readonly summary: string;
  readonly rationale: string;
}

export type TakeoverTermination =
  | { readonly _tag: "Exited"; readonly exitCode: number }
  | { readonly _tag: "Signaled"; readonly signal: NodeJS.Signals }
  | { readonly _tag: "StartupFailed"; readonly detail: string };

export interface TakeoverResult {
  readonly termination: TakeoverTermination;
  readonly notes: readonly ReviewNote[];
  readonly removedNoteIds?: readonly string[];
  readonly prefixAction?: HunkMode;
  readonly feedbackError?: string;
}

export interface LaunchIntent {
  readonly mode: HunkMode;
  readonly cwd: string;
  readonly target?: string;
}

export function cloneConfig(config: HunkConfig): HunkConfig {
  return { hotkeys: { ...config.hotkeys } };
}

export function modeArgs(mode: HunkMode, target?: string): readonly string[] {
  switch (mode) {
    case "diff":
      return ["diff", target ?? "HEAD", "--watch"];
    case "show":
      return ["show", target ?? "HEAD"];
    case "stash":
      return ["stash", "show", ...(target ? [target] : [])];
  }
}

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const SPECIAL_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const BARE_PREFIX_KEYS = new Set([
  "insert",
  "clear",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?");

interface ParsedBinding {
  readonly base: string;
  readonly modifiers: readonly string[];
  readonly identity: string;
}

function parseBinding(value: unknown): ParsedBinding | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  let base: string;
  let modifiers: string[];
  if (value === "+") {
    base = "+";
    modifiers = [];
  } else if (value.endsWith("++")) {
    base = "+";
    modifiers = value.slice(0, -2).split("+");
  } else {
    const parts = value.split("+");
    base = parts.pop() ?? "";
    modifiers = parts;
  }

  if (modifiers.some((modifier) => !MODIFIERS.has(modifier))) return undefined;
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  const printable = /^[a-z0-9]$/.test(base) || SYMBOL_KEYS.has(base);
  if (!printable && !SPECIAL_KEYS.has(base)) return undefined;

  if (base === "esc") base = "escape";
  else if (base === "return") base = "enter";
  if (base === "escape" && modifiers.length > 0) return undefined;
  modifiers = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return {
    base,
    modifiers,
    identity: modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base,
  };
}

export function bindingIdentity(value: unknown): string | undefined {
  return parseBinding(value)?.identity;
}

export function isPrefixBinding(value: unknown): value is KeyId {
  const parsed = parseBinding(value);
  if (!parsed) return false;
  if (BARE_PREFIX_KEYS.has(parsed.base)) return true;
  return parsed.modifiers.some(
    (modifier) => modifier === "ctrl" || modifier === "alt" || modifier === "super",
  );
}

export function isActionBinding(value: unknown): value is KeyId {
  const parsed = parseBinding(value);
  return parsed !== undefined && parsed.base !== "escape";
}

export function hotkeysAreValid(value: Hotkeys): boolean {
  if (!isPrefixBinding(value.prefix)) return false;
  if (
    !isActionBinding(value.diff) ||
    !isActionBinding(value.show) ||
    !isActionBinding(value.stash)
  ) {
    return false;
  }
  const identities = Object.values(value).map(bindingIdentity);
  return identities.every((identity) => identity !== undefined) && new Set(identities).size === 4;
}

export function toHunkChord(binding: string): string | undefined {
  return bindingIdentity(binding)
    ?.replaceAll("super", "meta")
    .replace("pageUp", "pageup")
    .replace("pageDown", "pagedown");
}
