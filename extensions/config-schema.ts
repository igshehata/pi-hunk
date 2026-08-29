import type { KeyId } from "@earendil-works/pi-tui";

/** Dedicated Pi-hunk chord used while Pi owns the terminal. */
export const PREFIX_KEY = "ctrl+space";
export const OPEN_KEY = "h";
export const SHOW_KEY = "s";

export type ReviewPolicy = "off" | "after-run" | "live";

export interface HunkCommandConfig {
  command: string;
  args: string[];
}

export interface BindingsConfig {
  prefix: KeyId;
  open: KeyId;
  show: KeyId;
}

export interface HunkConfig {
  review: ReviewPolicy;
  followEdits: boolean;
  hunk: HunkCommandConfig;
  bindings: BindingsConfig;
}

export const DEFAULT_BINDINGS_CONFIG: BindingsConfig = {
  prefix: PREFIX_KEY,
  open: OPEN_KEY,
  show: SHOW_KEY,
};

export const DEFAULT_CONFIG: HunkConfig = {
  // Manual review only until the user opts into automatic open.
  review: "off",
  followEdits: true,
  hunk: {
    command: "hunk",
    args: ["diff", "--watch"],
  },
  bindings: { ...DEFAULT_BINDINGS_CONFIG },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReviewPolicy(value: string): value is ReviewPolicy {
  return value === "off" || value === "after-run" || value === "live";
}

const BINDING_MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const BINDING_MODIFIERS = new Set<string>(BINDING_MODIFIER_ORDER);
const BINDING_SPECIAL_KEYS = new Set([
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
const BINDING_BARE_SAFE_KEYS = new Set([
  "insert",
  "clear",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const BINDING_SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?");

/**
 * Validate a prefix without allowing ordinary typing or navigation keys to
 * be swallowed while Pi owns the terminal. Function keys, insert, and clear
 * may be bare; everything else needs ctrl, alt, or super.
 */
function parseBinding(
  value: unknown,
): { base: string; modifiers: string[]; identity: string } | undefined {
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

  if (modifiers.some((modifier) => !BINDING_MODIFIERS.has(modifier))) return undefined;
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  const printable = /^[a-z0-9]$/.test(base) || BINDING_SYMBOL_KEYS.has(base);
  if (!printable && !BINDING_SPECIAL_KEYS.has(base)) return undefined;

  // pi-tui treats modifier order as irrelevant and exposes two names for
  // Escape and Enter. Use one identity for collision checks without rewriting
  // the user's valid spelling in persisted config.
  if (base === "esc") base = "escape";
  else if (base === "return") base = "enter";
  if (base === "escape" && modifiers.length > 0) return undefined;
  modifiers = BINDING_MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  const identity = modifiers.length > 0 ? `${modifiers.join("+")}+${base}` : base;
  return { base, modifiers, identity };
}

/** Canonical terminal-key identity used for safe Hunk chord comparisons. */
export function bindingIdentity(value: unknown): string | undefined {
  return parseBinding(value)?.identity;
}

function bindingsAreDistinct(bindings: BindingsConfig): boolean {
  const identities = Object.values(bindings).map(bindingIdentity);
  return identities.every((identity) => identity !== undefined) && new Set(identities).size === 3;
}

export function isPrefixBinding(value: unknown): value is KeyId {
  const parsed = parseBinding(value);
  if (!parsed) return false;
  if (BINDING_BARE_SAFE_KEYS.has(parsed.base)) return true;
  return parsed.modifiers.some(
    (modifier) => modifier === "ctrl" || modifier === "alt" || modifier === "super",
  );
}

/** Action keys are safe unmodified because they are read only after the prefix. */
export function isHotkeyBinding(value: unknown): value is KeyId {
  const parsed = parseBinding(value);
  return parsed !== undefined && parsed.base !== "escape" && parsed.base !== "esc";
}

function applyHunkCommand(base: HunkCommandConfig, input: unknown): HunkCommandConfig {
  if (!isRecord(input)) return base;
  const next = { ...base, args: [...base.args] };
  if (typeof input.command === "string" && input.command.trim()) {
    next.command = input.command.trim();
  }
  if (Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")) {
    next.args = [...input.args];
  }
  return next;
}

export function applyConfig(base: HunkConfig, input: unknown): HunkConfig {
  if (!isRecord(input)) return base;
  const next = cloneConfig(base);

  if (typeof input.review === "string" && isReviewPolicy(input.review)) {
    next.review = input.review;
  }
  if (typeof input.followEdits === "boolean") next.followEdits = input.followEdits;
  if ("hunk" in input) next.hunk = applyHunkCommand(next.hunk, input.hunk);
  if (isRecord(input.bindings)) {
    if (isPrefixBinding(input.bindings.prefix)) {
      next.bindings.prefix = input.bindings.prefix as KeyId;
    }
    for (const action of ["open", "show"] as const) {
      const value = input.bindings[action];
      if (isHotkeyBinding(value)) next.bindings[action] = value as KeyId;
    }
    if (!bindingsAreDistinct(next.bindings)) {
      next.bindings = { ...base.bindings };
    }
  }
  return next;
}

export function cloneConfig(config: HunkConfig): HunkConfig {
  return {
    review: config.review,
    followEdits: config.followEdits,
    hunk: { command: config.hunk.command, args: [...config.hunk.args] },
    bindings: { ...config.bindings },
  };
}
