import { randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { Data, Effect, Either, Schema } from "effect";
import {
  bindingIdentity,
  cloneConfig,
  DEFAULT_CONFIG,
  hotkeysAreValid,
  isActionBinding,
  isPrefixBinding,
  type HunkConfig,
  type Hotkeys,
} from "./model.ts";

const ConfigSchema = Schema.Struct({
  hotkeys: Schema.Struct({
    prefix: Schema.String,
    diff: Schema.String,
    show: Schema.String,
    stash: Schema.String,
  }),
});
const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_STALE_MS = 30_000;

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function globalConfigPath(): string {
  return process.env.PI_HUNK_CONFIG ?? join(getAgentDir(), "hunk.json");
}

export const loadConfig: Effect.Effect<HunkConfig, ConfigError> = Effect.gen(function* () {
  const path = globalConfigPath();
  const readResult = yield* Effect.either(
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
  );
  if (Either.isLeft(readResult)) {
    if ((readResult.left as NodeJS.ErrnoException).code === "ENOENT")
      return cloneConfig(DEFAULT_CONFIG);
    return yield* Effect.fail(
      new ConfigError({
        message: `Could not read Pi-hunk config at ${path}.`,
        cause: readResult.left,
      }),
    );
  }

  const json = yield* Effect.try({
    try: () => JSON.parse(readResult.right) as unknown,
    catch: (cause) =>
      new ConfigError({ message: `Pi-hunk config at ${path} is not valid JSON.`, cause }),
  });
  const decoded = Schema.decodeUnknownEither(ConfigSchema, { onExcessProperty: "error" })(json);
  if (Either.isLeft(decoded)) {
    return yield* Effect.fail(
      new ConfigError({
        message: `Pi-hunk config at ${path} must contain only hotkeys.prefix/diff/show/stash.`,
        cause: decoded.left,
      }),
    );
  }

  const config: HunkConfig = {
    hotkeys: {
      prefix: decoded.right.hotkeys.prefix as KeyId,
      diff: decoded.right.hotkeys.diff as KeyId,
      show: decoded.right.hotkeys.show as KeyId,
      stash: decoded.right.hotkeys.stash as KeyId,
    },
  };
  if (!hotkeysAreValid(config.hotkeys)) {
    return yield* Effect.fail(
      new ConfigError({
        message:
          `Pi-hunk config at ${path} has an unsafe or duplicate hotkey; ` +
          "prefix must be modified and all four keys must be distinct.",
      }),
    );
  }
  return config;
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function acquireConfigLock(path: string): Promise<FileHandle> {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  const recoveryPath = `${path}.recover`;
  while (true) {
    if (await pathExists(recoveryPath)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Pi-hunk config lock ${path}.`);
      }
      await wait(CONFIG_LOCK_RETRY_MS);
      continue;
    }
    try {
      return await open(path, "wx", 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }

    const lock = await stat(path).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (lock && Date.now() - lock.mtimeMs > CONFIG_LOCK_STALE_MS) {
      let recovery: FileHandle | undefined;
      try {
        recovery = await open(recoveryPath, "wx", 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      if (recovery) {
        try {
          const current = await stat(path).catch(() => undefined);
          if (current && Date.now() - current.mtimeMs > CONFIG_LOCK_STALE_MS) {
            await rm(path, { force: true });
          }
        } finally {
          await recovery.close().catch(() => undefined);
          await rm(recoveryPath, { force: true }).catch(() => undefined);
        }
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Pi-hunk config lock ${path}.`);
    }
    await wait(CONFIG_LOCK_RETRY_MS);
  }
}

async function withConfigLock<A>(operation: (path: string) => Promise<A>): Promise<A> {
  const path = globalConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const handle = await acquireConfigLock(lockPath);
  try {
    return await operation(path);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function writeConfig(path: string, config: HunkConfig): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.hunk-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export const resetConfig: Effect.Effect<void, ConfigError> = Effect.tryPromise({
  try: () => withConfigLock((path) => rm(path, { force: true })),
  catch: (cause) =>
    new ConfigError({ message: `Could not reset Pi-hunk config at ${globalConfigPath()}.`, cause }),
});

function bindingFromInput(data: string, kind: "prefix" | "action"): KeyId | undefined {
  const binding = parseKey(data);
  const valid = kind === "prefix" ? isPrefixBinding(binding) : isActionBinding(binding);
  return valid ? (bindingIdentity(binding) as KeyId) : undefined;
}

type ConfigChoice = keyof Hotkeys | "restore" | "done";

async function cancellableUi<T>(
  signal: AbortSignal,
  start: (registerCancel: (cancel: () => void) => void) => Promise<T>,
): Promise<T> {
  let cancel = (): void => {};
  const abort = (): void => cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = start((next) => {
      cancel = next;
      if (signal.aborted) cancel();
    });
    if (signal.aborted) cancel();
    return await result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function selectConfigChoice(
  ctx: ExtensionCommandContext,
  current: HunkConfig,
  signal: AbortSignal,
): Effect.Effect<ConfigChoice | undefined, ConfigError> {
  const options: ReadonlyArray<{ readonly value: ConfigChoice; readonly label: string }> = [
    { value: "prefix", label: `Prefix: ${current.hotkeys.prefix}` },
    { value: "diff", label: `Diff: ${current.hotkeys.diff}` },
    { value: "show", label: `Show: ${current.hotkeys.show}` },
    { value: "stash", label: `Stash: ${current.hotkeys.stash}` },
    { value: "restore", label: "Restore defaults" },
    { value: "done", label: "Done" },
  ];
  return Effect.tryPromise({
    try: () =>
      cancellableUi(signal, (registerCancel) =>
        ctx.ui.custom<ConfigChoice | undefined>((tui, theme, _keybindings, done) => {
          let selected = 0;
          let settled = false;
          const finish = (choice: ConfigChoice | undefined): void => {
            if (settled) return;
            settled = true;
            done(choice);
          };
          registerCancel(() => finish(undefined));
          return {
            render(width: number): string[] {
              return [
                theme.fg("accent", theme.bold(`Pi-hunk hotkeys — ${globalConfigPath()}`)),
                ...options.map((option, index) =>
                  index === selected
                    ? theme.fg("accent", `› ${option.label}`)
                    : `  ${option.label}`,
                ),
                theme.fg("dim", "↑/↓ select · enter edit · esc close"),
              ].map((line) => truncateToWidth(line, width));
            },
            handleInput(data: string): void {
              if (matchesKey(data, "escape")) {
                finish(undefined);
                return;
              }
              if (matchesKey(data, "up")) {
                selected = (selected - 1 + options.length) % options.length;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, "down")) {
                selected = (selected + 1) % options.length;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, "enter")) finish(options[selected]?.value);
            },
            invalidate(): void {},
          };
        }),
      ),
    catch: (cause) => new ConfigError({ message: "Could not open Pi-hunk configuration.", cause }),
  });
}

function captureBinding(
  ctx: ExtensionCommandContext,
  label: string,
  current: KeyId,
  kind: "prefix" | "action",
  unavailable: readonly KeyId[],
  signal: AbortSignal,
): Effect.Effect<KeyId | undefined, ConfigError> {
  return Effect.tryPromise({
    try: () =>
      cancellableUi(signal, (registerCancel) =>
        ctx.ui.custom<KeyId | undefined>((tui, theme, keybindings, done) => {
          const hostBindings = new Set<string>();
          if (kind === "prefix") {
            for (const value of Object.values(keybindings.getResolvedBindings())) {
              if (value === undefined) continue;
              for (const candidate of Array.isArray(value) ? value : [value]) {
                const identity = bindingIdentity(candidate);
                if (identity) hostBindings.add(identity);
              }
            }
          }
          let settled = false;
          const finish = (binding: KeyId | undefined): void => {
            if (settled) return;
            settled = true;
            done(binding);
          };
          registerCancel(() => finish(undefined));
          let feedback: { readonly _tag: "Ready" } | { readonly _tag: "Invalid"; message: string } =
            {
              _tag: "Ready",
            };
          return {
            render(width: number): string[] {
              const lines = [
                theme.fg("accent", theme.bold(`Set Pi-hunk ${label}`)),
                `Current: ${current}`,
                `Press the ${label} you want to use.`,
                theme.fg(
                  "dim",
                  kind === "prefix"
                    ? "Esc cancels. Prefixes must use a modifier or safe function key."
                    : "Esc cancels. Action keys follow the Pi-hunk prefix.",
                ),
              ];
              if (feedback._tag === "Invalid") lines.push(theme.fg("warning", feedback.message));
              return lines.map((line) => truncateToWidth(line, width));
            },
            handleInput(data: string): void {
              if (matchesKey(data, "escape")) {
                finish(undefined);
                return;
              }
              const binding = bindingFromInput(data, kind);
              const identity = bindingIdentity(binding);
              const chordCollision =
                identity !== undefined &&
                unavailable.some((candidate) => bindingIdentity(candidate) === identity);
              const hostCollision =
                kind === "prefix" && identity !== undefined && hostBindings.has(identity);
              if (binding && !chordCollision && !hostCollision) {
                finish(binding);
                return;
              }
              feedback = {
                _tag: "Invalid",
                message: chordCollision
                  ? `That key is already assigned in the Pi-hunk chord (${binding}).`
                  : hostCollision
                    ? `That host hotkey is already assigned (${binding}).`
                    : kind === "prefix"
                      ? "That key would interfere with normal typing."
                      : "That key cannot be used as a Pi-hunk action.",
              };
              tui.requestRender();
            },
            invalidate(): void {
              feedback = { _tag: "Ready" };
            },
          };
        }),
      ),
    catch: (cause) => new ConfigError({ message: `Could not capture the ${label}.`, cause }),
  });
}

function saveHotkey(key: keyof Hotkeys, value: KeyId): Effect.Effect<HunkConfig, ConfigError> {
  return Effect.tryPromise({
    try: () =>
      withConfigLock(async (path) => {
        const latest = await Effect.runPromise(loadConfig);
        const next: HunkConfig = { hotkeys: { ...latest.hotkeys, [key]: value } };
        if (!hotkeysAreValid(next.hotkeys)) {
          throw new ConfigError({
            message: `The ${value} binding now conflicts with another Pi-hunk hotkey.`,
          });
        }
        await writeConfig(path, next);
        return next;
      }),
    catch: (cause) =>
      cause instanceof ConfigError
        ? cause
        : new ConfigError({
            message: `Could not save Pi-hunk config at ${globalConfigPath()}.`,
            cause,
          }),
  });
}

export function configureHotkeys(
  ctx: ExtensionCommandContext,
  runtimeConfig: HunkConfig,
  signal: AbortSignal,
): Effect.Effect<void, ConfigError> {
  return Effect.gen(function* () {
    let current = yield* Effect.catchAll(loadConfig, () =>
      Effect.succeed(cloneConfig(DEFAULT_CONFIG)),
    );
    while (true) {
      const choice = yield* selectConfigChoice(ctx, current, signal);
      if (!choice || choice === "done") return;

      if (choice === "restore") {
        yield* resetConfig;
        current = cloneConfig(DEFAULT_CONFIG);
        ctx.ui.notify(
          `Pi-hunk hotkeys restored. Reload host plugins to activate ${current.hotkeys.prefix}.`,
          "info",
        );
        continue;
      }

      const key = choice;
      const unavailable = Object.entries(current.hotkeys)
        .filter(([candidate]) => candidate !== key)
        .map(([, binding]) => binding);
      const binding = yield* captureBinding(
        ctx,
        `${key} hotkey`,
        current.hotkeys[key],
        key === "prefix" ? "prefix" : "action",
        unavailable,
        signal,
      );
      if (!binding) continue;

      current = yield* saveHotkey(key, binding);
      const runtimeChanged = Object.entries(runtimeConfig.hotkeys).some(
        ([name, value]) => current.hotkeys[name as keyof Hotkeys] !== value,
      );
      ctx.ui.notify(
        `Pi-hunk hotkeys saved in ${globalConfigPath()}.${runtimeChanged ? " Reload host plugins to activate them." : ""}`,
        "info",
      );
    }
  });
}
