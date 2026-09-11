import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import type { Config } from "./contract.js";

export const DEFAULT_CONFIG: Config = Object.freeze({
  prefix: "ctrl+space",
  diff: "h",
  show: "s",
  delivery: "steer",
});

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

export function parseConfig(value: unknown): Config {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configuration must be a JSON object");
  }
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, field))
      throw new Error(`Unknown configuration field: ${field}`);
  }
  const supplied = value as Record<string, unknown>;
  const prefix = key(
    supplied.prefix === undefined ? DEFAULT_CONFIG.prefix : supplied.prefix,
    "prefix",
  );
  const diff = key(supplied.diff === undefined ? DEFAULT_CONFIG.diff : supplied.diff, "diff");
  const show = key(supplied.show === undefined ? DEFAULT_CONFIG.show : supplied.show, "show");
  const delivery = supplied.delivery === undefined ? DEFAULT_CONFIG.delivery : supplied.delivery;
  if (diff === show) throw new Error("diff and show must use different trigger keys");
  if (diff === "escape" || show === "escape") {
    throw new Error("Escape is reserved for canceling the prefix");
  }
  if (delivery !== "steer" && delivery !== "followUp" && delivery !== "interrupt") {
    throw new Error("delivery must be steer, followUp, or interrupt");
  }
  return { prefix, diff, show, delivery };
}

export function loadConfig(path: string): Effect.Effect<Config, Error> {
  return Effect.tryPromise({
    try: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return DEFAULT_CONFIG;
        }
        throw error;
      }
      return parseConfig(JSON.parse(text));
    },
    catch: (error) =>
      new Error(`Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`),
  });
}

export function saveConfig(path: string, value: unknown): Effect.Effect<Config, Error> {
  // An accepted save must settle before an interrupted session can reload this path.
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const config = parseConfig(value);
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
      },
      catch: (error) =>
        new Error(`Cannot save ${path}: ${error instanceof Error ? error.message : String(error)}`),
    }),
  );
}
