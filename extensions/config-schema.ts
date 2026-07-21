import type { KeyId } from "@earendil-works/pi-tui";

/** Dedicated Pi-hunk chord used both by Pi and the focused overlay. */
export const PREFIX_KEY = "ctrl+space";
export const TOGGLE_KEY = "h";
export const SHOW_KEY = "s";

export type ReviewPolicy = "off" | "after-run" | "live";

export interface HunkCommandConfig {
  command: string;
  args: string[];
}

export type OverlayLayout = "full" | "left" | "right" | "float";
export type OverlaySize = number | `${number}%`;

/** Pi-owned presentation only. Hunk's own config remains authoritative. */
export interface OverlayConfig {
  layout: OverlayLayout;
  /** Experimental: re-render Pi beside left/right overlays at the remaining width. */
  experimentalPiWrap: boolean;
}

export interface ResolvedOverlayLayout {
  anchor: "center" | "right-center" | "left-center";
  width: OverlaySize;
  maxHeight: OverlaySize;
}

export interface BindingsConfig {
  prefix: KeyId;
  toggle: KeyId;
  show: KeyId;
}

export interface HunkConfig {
  review: ReviewPolicy;
  followEdits: boolean;
  hunk: HunkCommandConfig;
  overlay: OverlayConfig;
  bindings: BindingsConfig;
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  layout: "right",
  experimentalPiWrap: true,
};

const OVERLAY_LAYOUTS: Record<OverlayLayout, ResolvedOverlayLayout> = {
  full: { anchor: "center", width: "100%", maxHeight: "100%" },
  left: { anchor: "left-center", width: "50%", maxHeight: "100%" },
  right: { anchor: "right-center", width: "50%", maxHeight: "100%" },
  float: { anchor: "center", width: "75%", maxHeight: "75%" },
};

export function isOverlayLayout(value: unknown): value is OverlayLayout {
  return value === "full" || value === "left" || value === "right" || value === "float";
}

export function resolveOverlayLayout(layout: OverlayLayout): ResolvedOverlayLayout {
  return { ...OVERLAY_LAYOUTS[layout] };
}

export const DEFAULT_BINDINGS_CONFIG: BindingsConfig = {
  prefix: PREFIX_KEY,
  toggle: TOGGLE_KEY,
  show: SHOW_KEY,
};

export const DEFAULT_CONFIG: HunkConfig = {
  review: "after-run",
  followEdits: true,
  hunk: {
    command: "hunk",
    args: ["diff", "--watch"],
  },
  overlay: { ...DEFAULT_OVERLAY_CONFIG },
  bindings: { ...DEFAULT_BINDINGS_CONFIG },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReviewPolicy(value: string): value is ReviewPolicy {
  return value === "off" || value === "after-run" || value === "live";
}

const BINDING_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
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
 * be swallowed by the focused Hunk overlay. Function keys, insert, and clear
 * may be bare; everything else needs ctrl, alt, or super.
 */
function parseBinding(value: unknown): { base: string; modifiers: string[] } | undefined {
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
  return { base, modifiers };
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

function applyOverlayConfig(base: OverlayConfig, input: unknown): OverlayConfig {
  if (!isRecord(input)) return base;
  const next = { ...base };
  if (isOverlayLayout(input.layout)) next.layout = input.layout;
  if (typeof input.experimentalPiWrap === "boolean") {
    next.experimentalPiWrap = input.experimentalPiWrap;
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
  if ("overlay" in input) next.overlay = applyOverlayConfig(next.overlay, input.overlay);
  if (isRecord(input.bindings)) {
    if (isPrefixBinding(input.bindings.prefix)) {
      next.bindings.prefix = input.bindings.prefix as KeyId;
    }
    for (const action of ["toggle", "show"] as const) {
      const value = input.bindings[action];
      if (isHotkeyBinding(value)) next.bindings[action] = value as KeyId;
    }
    if (new Set(Object.values(next.bindings)).size !== 3) {
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
    overlay: { ...config.overlay },
    bindings: { ...config.bindings },
  };
}
