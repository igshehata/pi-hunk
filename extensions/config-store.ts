import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyConfig,
  cloneConfig,
  DEFAULT_BINDINGS_CONFIG,
  DEFAULT_CONFIG,
  isOverlayLayout,
  isRecord,
  isReviewPolicy,
  isPrefixBinding,
  isHotkeyBinding,
  type HunkConfig,
} from "./config-schema.ts";

/**
 * Config loading and persistence. Precedence (low → high): shipped defaults →
 * global file → trusted-project file → PI_HUNK_REVIEW override → session
 * patches held by ConfigStore. Validation and merge semantics live in
 * config-schema.ts; this module only decides WHERE config comes from and goes.
 */

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Invalid Hunk config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let temporaryConfigSequence = 0;
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${temporaryConfigSequence++}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function globalConfigPath(): string {
  return process.env.PI_HUNK_CONFIG ?? join(homedir(), ".pi", "agent", "hunk.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "hunk.json");
}

/** Callback for non-fatal config problems (invalid values that fell back). */
export type ConfigWarning = (message: string) => void;

/** Warn for invalid public values handled by config-schema's fallback merge. */
function warnInvalidCoreConfig(raw: unknown, path: string, onWarning?: ConfigWarning): void {
  if (!onWarning || raw === undefined) return;
  if (!isRecord(raw)) {
    onWarning(`Ignoring invalid Hunk config root in ${path}; expected a JSON object.`);
    return;
  }

  if (raw.review !== undefined && (typeof raw.review !== "string" || !isReviewPolicy(raw.review))) {
    onWarning(
      `Ignoring invalid review ${JSON.stringify(raw.review)} in ${path}; expected "off", "after-run", or "live".`,
    );
  }
  if (raw.followEdits !== undefined && typeof raw.followEdits !== "boolean") {
    onWarning(
      `Ignoring invalid followEdits ${JSON.stringify(raw.followEdits)} in ${path}; expected true or false.`,
    );
  }
  if (raw.hunk === undefined) return;
  if (!isRecord(raw.hunk)) {
    onWarning(`Ignoring invalid hunk configuration in ${path}; expected an object.`);
    return;
  }
  if (
    raw.hunk.command !== undefined &&
    (typeof raw.hunk.command !== "string" || !raw.hunk.command.trim())
  ) {
    onWarning(
      `Ignoring invalid hunk.command ${JSON.stringify(raw.hunk.command)} in ${path}; expected a non-empty string.`,
    );
  }
  if (
    raw.hunk.args !== undefined &&
    (!Array.isArray(raw.hunk.args) || !raw.hunk.args.every((arg) => typeof arg === "string"))
  ) {
    onWarning(`Ignoring invalid hunk.args in ${path}; expected an array of strings.`);
  }
}

/** Warn when a configured Pi-hunk chord would be dropped or collide. */
function warnInvalidBindings(
  raw: unknown,
  path: string,
  inherited: HunkConfig["bindings"],
  onWarning?: ConfigWarning,
): void {
  if (!onWarning || !isRecord(raw) || !isRecord(raw.bindings)) return;
  const validators = {
    prefix: isPrefixBinding,
    toggle: isHotkeyBinding,
    show: isHotkeyBinding,
  };
  for (const action of ["prefix", "toggle", "show"] as const) {
    const value = raw.bindings[action];
    if (value === undefined || validators[action](value)) continue;
    onWarning(
      `Ignoring invalid bindings.${action} ${JSON.stringify(value)} in ${path}. ` +
        `Use a pi-tui key id like "${DEFAULT_BINDINGS_CONFIG[action]}".` +
        (action === "prefix" ? " Plain typing and navigation keys cannot be prefixes." : ""),
    );
  }
  const bindings = {
    prefix: isPrefixBinding(raw.bindings.prefix) ? raw.bindings.prefix : inherited.prefix,
    toggle: isHotkeyBinding(raw.bindings.toggle) ? raw.bindings.toggle : inherited.toggle,
    show: isHotkeyBinding(raw.bindings.show) ? raw.bindings.show : inherited.show,
  };
  if (new Set(Object.values(bindings)).size !== 3) {
    onWarning(
      `Ignoring colliding Hunk bindings in ${path}; prefix, toggle, and show must use distinct keys.`,
    );
  }
}

function warnInvalidOverlayConfig(raw: unknown, path: string, onWarning?: ConfigWarning): void {
  if (!onWarning || !isRecord(raw) || !isRecord(raw.overlay)) return;
  const { layout, experimentalPiWrap } = raw.overlay;
  if (layout !== undefined && !isOverlayLayout(layout)) {
    onWarning(
      `Ignoring invalid overlay.layout ${JSON.stringify(layout)} in ${path}. ` +
        `Use "full", "left", "right", or "float".`,
    );
  }
  if (experimentalPiWrap !== undefined && typeof experimentalPiWrap !== "boolean") {
    onWarning(
      `Ignoring invalid overlay.experimentalPiWrap ${JSON.stringify(experimentalPiWrap)} in ${path}; ` +
        `expected true or false.`,
    );
  }
}

function warnUnknownConfig(raw: unknown, path: string, onWarning?: ConfigWarning): void {
  if (!onWarning || !isRecord(raw)) return;
  const knownTopLevel = new Set(["review", "followEdits", "hunk", "overlay", "bindings"]);
  const unknown = Object.keys(raw)
    .filter((key) => !knownTopLevel.has(key))
    .map((key) => key);
  const nested: Array<[string, Set<string>]> = [
    ["hunk", new Set(["command", "args"])],
    ["overlay", new Set(["layout", "experimentalPiWrap"])],
    ["bindings", new Set(["prefix", "toggle", "show"])],
  ];
  for (const [section, keys] of nested) {
    const value = raw[section];
    if (!isRecord(value)) continue;
    unknown.push(
      ...Object.keys(value)
        .filter((key) => !keys.has(key))
        .map((key) => `${section}.${key}`),
    );
  }
  if (unknown.length > 0) {
    onWarning(
      `Ignoring unknown Hunk config key${unknown.length > 1 ? "s" : ""} in ${path}: ${unknown.join(", ")}.`,
    );
  }
}

function applyConfigLayer(
  config: HunkConfig,
  raw: unknown,
  path: string,
  onWarning?: ConfigWarning,
): HunkConfig {
  warnInvalidCoreConfig(raw, path, onWarning);
  warnUnknownConfig(raw, path, onWarning);
  warnInvalidBindings(raw, path, config.bindings, onWarning);
  warnInvalidOverlayConfig(raw, path, onWarning);
  return applyConfig(config, raw);
}

export async function loadConfig(
  ctx: ExtensionContext,
  onWarning?: ConfigWarning,
): Promise<HunkConfig> {
  let config = cloneConfig(DEFAULT_CONFIG);
  const globalPath = globalConfigPath();
  const globalRaw = await readJson(globalPath);
  config = applyConfigLayer(config, globalRaw, globalPath, onWarning);

  if (ctx.isProjectTrusted()) {
    const projectPath = projectConfigPath(ctx.cwd);
    const projectRaw = await readJson(projectPath);
    config = applyConfigLayer(config, projectRaw, projectPath, onWarning);
  }

  const reviewOverride = process.env.PI_HUNK_REVIEW;
  if (reviewOverride) {
    if (isReviewPolicy(reviewOverride)) config.review = reviewOverride;
    else {
      onWarning?.(
        `Ignoring invalid PI_HUNK_REVIEW ${JSON.stringify(reviewOverride)}; expected "off", "after-run", or "live".`,
      );
    }
  }
  return config;
}

export type ConfigScope = "session" | "global" | "project";

/**
 * Deep-merge only the keys present in `patch` onto `base`. Nested plain objects
 * merge recursively; arrays and primitives replace wholesale. Keys absent from
 * `patch` are preserved untouched. Never materializes schema defaults.
 */
function deepMergeRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isRecord(value) && isRecord(existing) ? deepMergeRecords(existing, value) : value;
  }
  return out;
}

export class ConfigStore {
  private config: HunkConfig = cloneConfig(DEFAULT_CONFIG);

  get(): HunkConfig {
    return cloneConfig(this.config);
  }

  /** Replace the in-memory session config. */
  setSession(config: HunkConfig): HunkConfig {
    this.config = cloneConfig(config);
    return this.get();
  }

  patchSession(partial: unknown): HunkConfig {
    this.config = applyConfig(this.config, partial);
    return this.get();
  }

  async reload(ctx: ExtensionContext, onWarning?: ConfigWarning): Promise<HunkConfig> {
    this.config = await loadConfig(ctx, onWarning);
    return this.get();
  }

  /**
   * Persist a partial update to global or trusted project config, then reload session.
   * Project scope requires a trusted project.
   */
  async resetProject(ctx: ExtensionContext): Promise<HunkConfig> {
    if (!ctx.isProjectTrusted()) throw new Error("Project config requires a trusted project.");
    await rm(projectConfigPath(ctx.cwd), { force: true });
    return this.reload(ctx);
  }

  async persist(
    ctx: ExtensionContext,
    scope: "global" | "project",
    partial: unknown,
  ): Promise<HunkConfig> {
    if (scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error("Project config requires a trusted project.");
    }
    const path = scope === "global" ? globalConfigPath() : projectConfigPath(ctx.cwd);
    // Sparse write: preserve the existing raw file and deep-merge only the patch
    // keys. Never materialize defaults into the file so it stays minimal and any
    // key the user did not set continues to track the shipped defaults.
    const existing = await readJson(path);
    const base = isRecord(existing) ? existing : {};
    const patch = isRecord(partial) ? partial : {};
    const merged = deepMergeRecords(base, patch);
    await writeJsonAtomic(path, merged);
    return this.reload(ctx);
  }
}
