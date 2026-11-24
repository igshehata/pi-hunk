import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./contract.js";

export const DEFAULT_CONFIG: Config = Object.freeze({
  prefix: "ctrl+space",
  diff: "h",
  show: "s",
  log: "l",
  branch: "b",
  codebase: "c",
  send: "enter",
  delivery: "steer",
  mode: "static",
  comments: "live",
});

/**
 * Every field this build understands. `base` has no default to fall back on, so it is kept
 * beside `DEFAULT_CONFIG` rather than in it: an unknown-field check that read the defaults alone
 * would report a `base` the user set as a field from a newer build and drop it on Save.
 */
const knownFields: ReadonlySet<string> = new Set([...Object.keys(DEFAULT_CONFIG), "base"]);

const modifiers = ["ctrl", "alt", "shift"] as const;
const keyPattern =
  /^((?:(?:ctrl|alt|shift)\+)*)([!-~]|space|enter|tab|escape|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/;

function key(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a key string`);
  const match = keyPattern.exec(value.trim());
  if (!match) throw new Error(`${field} is not a supported key: ${JSON.stringify(value)}`);
  const parts = match[1]!.split("+").filter(Boolean);
  const selected = new Set(parts);
  if (selected.size !== parts.length) throw new Error(`${field} repeats a modifier`);
  let base = match[2]!;
  if (/^[A-Z]$/.test(base)) {
    selected.add("shift");
    base = base.toLowerCase();
  }
  // Stay within both hosts' and Hunk's public shortcut grammars.
  if (base === "+" || base === '"') {
    throw new Error(`${field} uses a symbol Pi cannot bind: ${JSON.stringify(base)}`);
  }
  if (base === "escape" && selected.size > 0) {
    throw new Error(`${field}: Escape cannot have modifiers`);
  }
  if (selected.has("shift") && base.length === 1 && (base < "a" || base > "z")) {
    throw new Error(`${field}: use a literal symbol instead of Shift with a non-letter key`);
  }
  return [...modifiers.filter((modifier) => selected.has(modifier)), base].join("+");
}

/** A base branch is named, not composed: one git ref, no whitespace and nothing to split. */
function branchName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /\s/.test(value))
    throw new Error("base must be a branch name");
  return value;
}

/**
 * Keys an older file cannot set, and the release that added them: their defaults may already be
 * one of that file's keys.
 */
const addedKeys: Readonly<Record<string, string>> = { branch: "2.0", codebase: "2.0", send: "2.1" };

/**
 * Two actions on one key after the prefix is refused by naming both and the key. An older file
 * never set the keys later releases added, so a new key's default can collide with a key the user
 * chose long ago: the error says so, and how to resolve it.
 */
function collisions(supplied: Record<string, unknown>, keys: Record<string, string>): void {
  const owner = new Map<string, string>();
  for (const [field, bound] of Object.entries(keys)) {
    const first = owner.get(bound);
    if (first === undefined) {
      owner.set(bound, field);
      continue;
    }
    const clash = `${first} and ${field} both use ${JSON.stringify(bound)}`;
    const unset = [first, field].find(
      (key) => Object.hasOwn(addedKeys, key) && supplied[key] === undefined,
    );
    if (unset === undefined) throw new Error(`${clash}. Give each its own key.`);
    const chosen = unset === field ? first : field;
    throw new Error(
      `${clash}: ${unset} is a key added in pi-hunk ${addedKeys[unset]} and defaults to ${JSON.stringify(bound)}. Set ${unset} to another key, or change ${chosen}.`,
    );
  }
}

/** A parsed file: the settings this build understands, plus the ones it had to skip. */
export interface ParsedConfig {
  readonly config: Config;
  /** Fields a newer build wrote. They are ignored, named, and dropped by the next Save. */
  readonly ignored: readonly string[];
}

export function parseConfig(value: unknown): ParsedConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configuration must be a JSON object");
  }
  const supplied = value as Record<string, unknown>;
  // A rolled-back build must keep working with a file a newer one wrote, so an unknown field is
  // reported to the user and ignored instead of disabling every known setting.
  const ignored = Object.keys(supplied).filter((field) => !knownFields.has(field));
  const prefix = key(
    supplied.prefix === undefined ? DEFAULT_CONFIG.prefix : supplied.prefix,
    "prefix",
  );
  const diff = key(supplied.diff === undefined ? DEFAULT_CONFIG.diff : supplied.diff, "diff");
  const show = key(supplied.show === undefined ? DEFAULT_CONFIG.show : supplied.show, "show");
  const log = key(supplied.log === undefined ? DEFAULT_CONFIG.log : supplied.log, "log");
  const branch = key(
    supplied.branch === undefined ? DEFAULT_CONFIG.branch : supplied.branch,
    "branch",
  );
  const codebase = key(
    supplied.codebase === undefined ? DEFAULT_CONFIG.codebase : supplied.codebase,
    "codebase",
  );
  const send = key(supplied.send === undefined ? DEFAULT_CONFIG.send : supplied.send, "send");
  const delivery = supplied.delivery === undefined ? DEFAULT_CONFIG.delivery : supplied.delivery;
  collisions(supplied, { diff, show, log, branch, codebase, send });
  if ([diff, show, log, branch, codebase, send].includes("escape")) {
    throw new Error("Escape is reserved for canceling the prefix");
  }
  if (delivery !== "steer" && delivery !== "followUp" && delivery !== "interrupt") {
    throw new Error("delivery must be steer, followUp, or interrupt");
  }
  const mode = supplied.mode === undefined ? DEFAULT_CONFIG.mode : supplied.mode;
  if (mode !== "static" && mode !== "multiplexer") {
    throw new Error("mode must be static or multiplexer");
  }
  const comments = supplied.comments === undefined ? DEFAULT_CONFIG.comments : supplied.comments;
  if (comments !== "live" && comments !== "batch") {
    throw new Error("comments must be live or batch");
  }
  const base = supplied.base === undefined ? undefined : branchName(supplied.base);
  return {
    config: {
      prefix,
      diff,
      show,
      log,
      branch,
      codebase,
      send,
      delivery,
      mode,
      comments,
      ...(base === undefined ? {} : { base }),
    },
    ignored,
  };
}

/**
 * A file the extension can work with, or one it cannot: a broken file is reported, never replaced,
 * so `/hunk config` can open on defaults and leave the write to an explicit Save.
 */
export type ConfigLoad =
  | { readonly _tag: "Loaded"; readonly config: Config; readonly ignored: readonly string[] }
  | { readonly _tag: "Broken"; readonly message: string };

export async function loadConfig(path: string): Promise<ConfigLoad> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { _tag: "Loaded", config: DEFAULT_CONFIG, ignored: [] };
    }
    // An unreadable file is not a malformed one: a Save over it could destroy valid settings.
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const { config, ignored } = parseConfig(JSON.parse(text));
    return { _tag: "Loaded", config, ignored };
  } catch (error) {
    return {
      _tag: "Broken",
      message: `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function saveConfig(path: string, value: unknown): Promise<Config> {
  // An accepted save must settle before an interrupted session can reload this path, so there is no
  // cancellation signal to observe: once this promise starts writing, it runs to completion.
  try {
    const { config } = parseConfig(value);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.pi-hunk-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Save failed and temporary file could not be removed: ${temporary}`,
        );
      }
      throw error;
    }
    // Rename consumes the temporary file; no fallible cleanup follows the commit.
    return config;
  } catch (error) {
    throw new Error(
      `Cannot save ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
