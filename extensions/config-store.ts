import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
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

/** Callback for non-fatal config problems (invalid values that fell back). */
export type ConfigWarning = (message: string) => void;

type JsonReadResult =
  | { status: "missing" }
  | { status: "valid"; value: unknown }
  | { status: "malformed"; detail: string };

/** ENOENT, JSON syntax, and real read failures have deliberately distinct semantics. */
async function readJson(path: string): Promise<JsonReadResult> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw new Error(
      `Could not read Hunk config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return { status: "valid", value: JSON.parse(source) };
  } catch (error) {
    return {
      status: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readConfigLayer(path: string, onWarning?: ConfigWarning): Promise<unknown> {
  const result = await readJson(path);
  if (result.status === "valid") return result.value;
  if (result.status === "malformed") {
    onWarning?.(`Ignoring malformed Hunk config at ${path}: ${result.detail}`);
  }
  return undefined;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, constants.O_RDONLY);
    await directory.sync();
  } catch (error) {
    // Windows and some filesystems do not permit opening/fsyncing directories.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM" && code !== "ENOTSUP") {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  // The random, mode-0700 directory is created atomically in the destination
  // directory. O_EXCL + O_NOFOLLOW then ensures the file we write is the one
  // this operation created, rather than a preplanted link or shared temp path.
  const temporaryDirectory = await mkdtemp(join(directory, `.${basename(path)}.tmp-`));
  const temporary = join(temporaryDirectory, "config");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    // Unlink/rmdir only the two artifacts created by this operation. Never use
    // recursive cleanup on a path in an attacker-writable parent directory.
    await unlink(temporary).catch((cleanupError) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  } finally {
    await rmdir(temporaryDirectory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export function globalConfigPath(): string {
  return process.env.PI_HUNK_CONFIG ?? join(homedir(), ".pi", "agent", "hunk.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "hunk.json");
}

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
  const { layout } = raw.overlay;
  if (layout !== undefined && !isOverlayLayout(layout)) {
    onWarning(
      `Ignoring invalid overlay.layout ${JSON.stringify(layout)} in ${path}. ` +
        `Use "full", "left", "right", or "float".`,
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
    ["overlay", new Set(["layout"])],
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
  const globalRaw = await readConfigLayer(globalPath, onWarning);
  config = applyConfigLayer(config, globalRaw, globalPath, onWarning);

  if (ctx.isProjectTrusted()) {
    const projectPath = projectConfigPath(ctx.cwd);
    const projectRaw = await readConfigLayer(projectPath, onWarning);
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
  private loadedConfig: HunkConfig = cloneConfig(DEFAULT_CONFIG);
  private sessionOverrides: Record<string, unknown> = {};

  get(): HunkConfig {
    return cloneConfig(this.config);
  }

  /** Config from files/environment before durable runtime session overrides. */
  getLoaded(): HunkConfig {
    return cloneConfig(this.loadedConfig);
  }

  /** Replace and retain the in-memory config until the next session starts. */
  setSession(config: HunkConfig): HunkConfig {
    this.sessionOverrides = { ...cloneConfig(config) };
    this.config = cloneConfig(config);
    return this.get();
  }

  /** Apply and retain a runtime override across file reloads in this Pi session. */
  patchSession(partial: unknown): HunkConfig {
    if (isRecord(partial)) {
      this.sessionOverrides = deepMergeRecords(this.sessionOverrides, partial);
    }
    this.config = applyConfig(this.loadedConfig, this.sessionOverrides);
    return this.get();
  }

  async reload(ctx: ExtensionContext, onWarning?: ConfigWarning): Promise<HunkConfig> {
    this.loadedConfig = await loadConfig(ctx, onWarning);
    this.config = applyConfig(this.loadedConfig, this.sessionOverrides);
    return this.get();
  }

  /** Start a fresh Pi runtime, discarding overrides retained by the prior session. */
  async startSession(ctx: ExtensionContext, onWarning?: ConfigWarning): Promise<HunkConfig> {
    this.sessionOverrides = {};
    return this.reload(ctx, onWarning);
  }

  /**
   * Persist a partial update to global or trusted project config, then reload files
   * beneath the retained runtime session overrides. Project scope requires trust.
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
    // Repair policy: valid JSON remains a sparse deep merge; a malformed target
    // is atomically replaced by this trusted command's sparse patch. Missing and
    // malformed files both use an empty raw base, while genuine read/permission
    // failures still reject without touching the destination.
    const existing = await readJson(path);
    const base = existing.status === "valid" && isRecord(existing.value) ? existing.value : {};
    const patch = isRecord(partial) ? partial : {};
    const merged = deepMergeRecords(base, patch);
    await writeJsonAtomic(path, merged);
    return this.reload(ctx);
  }
}
