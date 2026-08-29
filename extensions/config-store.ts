import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  applyConfig,
  bindingIdentity,
  cloneConfig,
  DEFAULT_BINDINGS_CONFIG,
  DEFAULT_CONFIG,
  isRecord,
  isReviewPolicy,
  isPrefixBinding,
  isHotkeyBinding,
  type HunkConfig,
} from "./config-schema.ts";

/**
 * Config loading and persistence. Precedence (low → high): shipped defaults →
 * global file → PI_HUNK_REVIEW override → session patches held by ConfigStore.
 * Project-local files are diagnosed but never loaded: Pi-hunk configuration is
 * global. Validation and merge semantics live in config-schema.ts; this module
 * only decides WHERE config comes from and goes.
 */

/** Callback for non-fatal config problems (invalid values that fell back). */
export type ConfigWarning = (message: string) => void;

interface ConfigContext {
  cwd: string;
  isProjectTrusted?: () => boolean;
}

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
  let directory: FileHandle | undefined;
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

const CONFIG_LOCK_RETRY_MS = 20;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_MALFORMED_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_MAX_BYTES = 4_096;
const CONFIG_LOCK_RECOVERY_INFIX = ".recovery-";

type ReleaseConfigLock = () => Promise<void>;

interface ConfigLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

interface ConfigLockFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface ConfigLockSnapshot {
  raw?: string;
  owner?: ConfigLockOwner;
  /** PID-only lock written by pi-hunk versions before owner tokens. */
  legacyPid?: number;
  fingerprint: ConfigLockFingerprint;
}

function parseConfigLockOwner(raw: string | undefined): ConfigLockOwner | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      value.token.length > 200 ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt <= 0
    ) {
      return undefined;
    }
    return {
      pid: value.pid as number,
      token: value.token,
      createdAt: value.createdAt,
    };
  } catch {
    return undefined;
  }
}

function parseLegacyConfigLockPid(raw: string): number | undefined {
  if (!/^[1-9]\d*\s*$/.test(raw)) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

async function readConfigLockSnapshot(lockPath: string): Promise<ConfigLockSnapshot | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(
      lockPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const stats = await file.stat();
    const fingerprint = {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    if (!stats.isFile() || stats.size > CONFIG_LOCK_MAX_BYTES) return { fingerprint };

    const buffer = Buffer.alloc(CONFIG_LOCK_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CONFIG_LOCK_MAX_BYTES) return { fingerprint };
    const raw = buffer.toString("utf8", 0, bytesRead);
    return {
      raw,
      owner: parseConfigLockOwner(raw),
      legacyPid: parseLegacyConfigLockPid(raw),
      fingerprint,
    };
  } finally {
    await file.close().catch(() => undefined);
  }
}

function sameConfigLockFingerprint(
  left: ConfigLockFingerprint,
  right: ConfigLockFingerprint,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

/** Remove an owner-held lock after the protocol has excluded an entering successor. */
async function removeConfigLockSnapshot(
  lockPath: string,
  expected: ConfigLockSnapshot,
  ownerToken?: string,
): Promise<boolean> {
  const current = await readConfigLockSnapshot(lockPath);
  if (!current) return true;
  if (
    !sameConfigLockFingerprint(current.fingerprint, expected.fingerprint) ||
    (ownerToken !== undefined && current.owner?.token !== ownerToken)
  ) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function configLockOwnerIsDead(pid: number): Promise<boolean> {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means a process exists but cannot be signalled. Unknown platform
    // errors are also treated as live: ESRCH is the only positive dead signal.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function configLockSnapshotIsStale(snapshot: ConfigLockSnapshot): Promise<boolean> {
  const pid = snapshot.owner?.pid ?? snapshot.legacyPid;
  if (pid !== undefined) return configLockOwnerIsDead(pid);
  return Date.now() - snapshot.fingerprint.mtimeMs >= CONFIG_MALFORMED_LOCK_STALE_MS;
}

function configLockRecoveryPrefix(lockPath: string): string {
  return `${basename(lockPath)}${CONFIG_LOCK_RECOVERY_INFIX}`;
}

async function configLockRecoveryPaths(lockPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dirname(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = configLockRecoveryPrefix(lockPath);
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(dirname(lockPath), entry));
}

/**
 * Every recovery contender owns a unique gate. Acquisition checks gates before
 * and after O_EXCL, so no successor can enter while an inspected stale path is
 * being unlinked. Orphan cleanup is safe because a UUID gate is never reused.
 */
async function configLockRecoveryIsActive(lockPath: string): Promise<boolean> {
  for (const recoveryPath of await configLockRecoveryPaths(lockPath)) {
    let snapshot: ConfigLockSnapshot | undefined;
    try {
      snapshot = await readConfigLockSnapshot(recoveryPath);
    } catch {
      return true;
    }
    if (!snapshot) continue;
    if (!(await configLockSnapshotIsStale(snapshot))) return true;
    try {
      await unlink(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

async function withConfigLockRecoveryGate<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const recoveryPath = `${lockPath}${CONFIG_LOCK_RECOVERY_INFIX}${randomUUID()}`;
  const owner: ConfigLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  let gate: FileHandle | undefined;
  try {
    gate = await open(
      recoveryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await gate.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await gate.sync();
    await gate.close();
    gate = undefined;
  } catch (error) {
    await gate?.close().catch(() => undefined);
    await unlink(recoveryPath).catch(() => undefined);
    throw error;
  }

  const release = async (): Promise<void> => {
    try {
      await unlink(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  let result: T;
  try {
    result = await operation();
  } catch (operationError) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Could not recover or release Hunk config lock at ${lockPath}`,
      );
    }
    throw operationError;
  }
  await release();
  return result;
}

/** Recover only a dead owner or an old lock that never gained valid metadata. */
async function recoverStaleConfigLock(lockPath: string): Promise<boolean> {
  let expected: ConfigLockSnapshot | undefined;
  try {
    expected = await readConfigLockSnapshot(lockPath);
    if (!expected || !(await configLockSnapshotIsStale(expected))) return expected === undefined;
  } catch {
    return false;
  }

  return withConfigLockRecoveryGate(lockPath, async () => {
    const current = await readConfigLockSnapshot(lockPath);
    if (!current) return true;
    if (!sameConfigLockFingerprint(current.fingerprint, expected.fingerprint)) return false;
    if (!(await configLockSnapshotIsStale(current))) return false;
    try {
      await unlink(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }).catch(() => false);
}

/** Serialize read/merge/write across Pi processes so sparse global updates cannot be lost. */
async function acquireConfigLock(path: string): Promise<ReleaseConfigLock> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;

  while (true) {
    if (await configLockRecoveryIsActive(lockPath)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting to update Hunk config at ${path}. ` +
            `If no Pi process is updating it, remove ${lockPath} and retry.`,
        );
      }
      await delay(CONFIG_LOCK_RETRY_MS);
      continue;
    }
    let lock: FileHandle | undefined;
    let openedSnapshot: ConfigLockSnapshot | undefined;
    const owner: ConfigLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    try {
      lock = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const openedStats = await lock.stat();
      openedSnapshot = {
        fingerprint: {
          dev: openedStats.dev,
          ino: openedStats.ino,
          size: openedStats.size,
          mtimeMs: openedStats.mtimeMs,
        },
      };
      await lock.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await lock.sync();
      if (await configLockRecoveryIsActive(lockPath)) {
        await lock.close();
        lock = undefined;
        const snapshot = await readConfigLockSnapshot(lockPath);
        if (snapshot?.owner?.token === owner.token) {
          await removeConfigLockSnapshot(lockPath, snapshot, owner.token);
        }
        await delay(CONFIG_LOCK_RETRY_MS);
        continue;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await lock?.close().catch(() => undefined);
        const snapshot = await readConfigLockSnapshot(lockPath);
        if (!snapshot || snapshot.owner?.token !== owner.token) return;
        await removeConfigLockSnapshot(lockPath, snapshot, owner.token);
      };
    } catch (error) {
      await lock?.close().catch(() => undefined);
      if (lock) {
        // If setup failed after O_EXCL succeeded, clean up only that inode. A
        // replacement lock must survive this failed contender.
        const current = await readConfigLockSnapshot(lockPath).catch(() => undefined);
        if (
          current &&
          openedSnapshot &&
          current.fingerprint.dev === openedSnapshot.fingerprint.dev &&
          current.fingerprint.ino === openedSnapshot.fingerprint.ino
        ) {
          await unlink(lockPath).catch(() => undefined);
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleConfigLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting to update Hunk config at ${path}. ` +
            `If no Pi process is updating it, remove ${lockPath} and retry.`,
        );
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }
}

async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireConfigLock(path);
  try {
    return await operation();
  } finally {
    await release();
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
  let file: FileHandle | undefined;
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
  return process.env.PI_HUNK_CONFIG ?? join(getAgentDir(), "hunk.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "hunk.json");
}

function legacyGlobalConfigPath(): string {
  // Before 0.2.1 pi-hunk ignored PI_CODING_AGENT_DIR and always used this path.
  // Prefer HOME explicitly because os.homedir() may cache its first lookup.
  return join(process.env.HOME ?? homedir(), ".pi", "agent", "hunk.json");
}

async function comparableConfigPath(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      canonical = join(await realpath(dirname(path)), basename(path));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
      canonical = resolve(path);
    }
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
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
  if (!onWarning || !isRecord(raw) || raw.bindings === undefined) return;
  if (!isRecord(raw.bindings)) {
    onWarning(`Ignoring invalid bindings configuration in ${path}; expected an object.`);
    return;
  }
  const validators = {
    prefix: isPrefixBinding,
    open: isHotkeyBinding,
    show: isHotkeyBinding,
  };
  for (const action of ["prefix", "open", "show"] as const) {
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
    open: isHotkeyBinding(raw.bindings.open) ? raw.bindings.open : inherited.open,
    show: isHotkeyBinding(raw.bindings.show) ? raw.bindings.show : inherited.show,
  };
  const identities = Object.values(bindings).map(bindingIdentity);
  if (new Set(identities).size !== 3) {
    onWarning(
      `Ignoring colliding Hunk bindings in ${path}; prefix, open, and show must use distinct keys.`,
    );
  }
}

function warnUnknownConfig(raw: unknown, path: string, onWarning?: ConfigWarning): void {
  if (!onWarning || !isRecord(raw)) return;
  const knownTopLevel = new Set(["review", "followEdits", "hunk", "bindings"]);
  const unknown = Object.keys(raw)
    .filter((key) => !knownTopLevel.has(key))
    .map((key) => key);
  const nested: Array<[string, Set<string>]> = [
    ["hunk", new Set(["command", "args"])],
    ["bindings", new Set(["prefix", "open", "show"])],
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
  return applyConfig(config, raw);
}

export async function loadConfig(
  ctx: ConfigContext,
  onWarning?: ConfigWarning,
): Promise<HunkConfig> {
  let config = cloneConfig(DEFAULT_CONFIG);
  const globalPath = globalConfigPath();
  const globalRaw = await readConfigLayer(globalPath, onWarning);
  config = applyConfigLayer(config, globalRaw, globalPath, onWarning);

  if (!process.env.PI_HUNK_CONFIG) {
    const legacyPath = legacyGlobalConfigPath();
    try {
      if ((await comparableConfigPath(legacyPath)) !== (await comparableConfigPath(globalPath))) {
        await access(legacyPath, constants.F_OK);
        onWarning?.(
          `Ignoring legacy Hunk config at ${legacyPath}; Pi's global agent directory is ${globalPath}. ` +
            `Move audited settings to the new path and remove the legacy file.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Legacy discovery is advisory. Symlink loops and permission errors on
        // this obsolete optional path must not block the active global config.
        onWarning?.(
          `Could not inspect legacy Hunk config at ${legacyPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (ctx.isProjectTrusted?.()) {
    const projectPath = projectConfigPath(ctx.cwd);
    try {
      await access(projectPath, constants.F_OK);
      onWarning?.(
        `Ignoring project-local Hunk config at ${projectPath}; Pi-hunk configuration is global. ` +
          `Reapply user-facing settings with /hunk config, do not copy a project-relative ` +
          `hunk.command into global config, and remove the project file.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        onWarning?.(
          `Could not inspect obsolete project-local Hunk config at ${projectPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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

export type ConfigScope = "session" | "global";

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

  async reload(ctx: ConfigContext, onWarning?: ConfigWarning): Promise<HunkConfig> {
    this.loadedConfig = await loadConfig(ctx, onWarning);
    this.config = applyConfig(this.loadedConfig, this.sessionOverrides);
    return this.get();
  }

  /** Start a fresh Pi runtime, discarding overrides retained by the prior session. */
  async startSession(ctx: ConfigContext, onWarning?: ConfigWarning): Promise<HunkConfig> {
    // Clear every value derived from the ending session before I/O. If loading
    // fails, callers see safe defaults rather than old overrides or file data.
    this.sessionOverrides = {};
    this.loadedConfig = cloneConfig(DEFAULT_CONFIG);
    this.config = cloneConfig(DEFAULT_CONFIG);
    return this.reload(ctx, onWarning);
  }

  /** Remove global Hunk overrides and reload defaults plus environment overrides. */
  async resetGlobal(ctx: ConfigContext): Promise<HunkConfig> {
    const path = globalConfigPath();
    await withConfigLock(path, () => rm(path, { force: true }));
    return this.reload(ctx);
  }

  /** Persist a sparse update to Pi's global config directory, then reload it. */
  async persist(ctx: ConfigContext, _scope: "global", partial: unknown): Promise<HunkConfig> {
    const path = globalConfigPath();
    await withConfigLock(path, async () => {
      // Repair policy: valid JSON remains a sparse deep merge; a malformed target
      // is atomically replaced by this command's sparse patch. Missing and
      // malformed files both use an empty raw base, while genuine read/permission
      // failures still reject without touching the destination.
      const existing = await readJson(path);
      const base = existing.status === "valid" && isRecord(existing.value) ? existing.value : {};
      const patch = isRecord(partial) ? partial : {};
      const merged = deepMergeRecords(base, patch);
      await writeJsonAtomic(path, merged);
    });
    return this.reload(ctx);
  }
}
