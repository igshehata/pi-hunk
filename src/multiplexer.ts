import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { REVIEW_ENV, type ReviewLaunch } from "./contract.js";

export type MultiplexerKind = "herdr" | "rex" | "tern";

export interface Pane {
  readonly kind: MultiplexerKind;
  readonly id: string;
}

export interface Multiplexer {
  readonly kind: MultiplexerKind;
  /** Display name for notices: "Herdr" | "Rex" | "Tern". */
  readonly name: string;
  /** Split the host's own pane to the right (50%), run `/bin/sh <launcher>` in `cwd`, and give it the keyboard. */
  open(cwd: string, launcher: string): Promise<Pane>;
  /** Give an open pane the keyboard. */
  focus(pane: Pane): Promise<void>;
  /** Close the pane; resolves (does not throw) when it is already gone. */
  close(pane: Pane): Promise<void>;
  /** True while the pane still exists and its program is running. */
  alive(pane: Pane): Promise<boolean>;
}

/** Panes take a moment to appear, but a CLI that hangs must not hold the host's turn forever. */
const CLI_TIMEOUT_MS = 10_000;
const CLI_MAX_OUTPUT = 1024 * 1024;

interface CliOutcome {
  /** Exit status; null when the CLI never ran (missing binary, timeout, spawn failure). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/**
 * Runs one CLI call without a shell, with the host's environment, and reports the exit instead of
 * throwing: the alive and close paths read a failure as an answer.
 */
function invoke(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliOutcome> {
  const { promise, resolve: settle } = Promise.withResolvers<CliOutcome>();
  execFile(
    binary,
    [...args],
    { encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_OUTPUT, env },
    (error, stdout, stderr) => {
      // `code` is a number for an exit and a string for a spawn failure ("ENOENT").
      const code = error !== null && typeof error.code === "number" ? error.code : null;
      settle({ code: error === null ? 0 : code, stdout, stderr, error: error ?? undefined });
    },
  );
  return promise;
}

/** The CLI's own words: its stderr when it wrote one, otherwise the spawn/timeout error. */
function describe(binary: string, outcome: CliOutcome): string {
  if (outcome.code === null && outcome.error !== undefined) {
    return `${basename(binary)} could not run: ${outcome.error.message}`;
  }
  const detail = outcome.stderr.trim() || outcome.error?.message.trim() || "no error output";
  return `${basename(binary)} failed: ${detail}`;
}

/** Runs one call and returns its stdout; a failure carries the CLI's stderr. */
async function call(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const outcome = await invoke(binary, args, env);
  if (outcome.code !== 0) throw new Error(describe(binary, outcome));
  return outcome.stdout;
}

function parseJson(binary: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${basename(binary)} returned no JSON: ${stdout.trim()}`);
  }
}

/**
 * Reads a pane id at `path`, so a changed CLI shape fails loudly instead of silently. Tern prints
 * its ids as JSON numbers while Herdr and Rex print strings; every id is passed back on a command
 * line, so it is kept as text.
 */
function readId(value: unknown, path: readonly string[], binary: string): string {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`${basename(binary)} returned no ${path.join(".")}`);
    }
    // Checked as an object above; the keys come from `path` because the shape is the CLI's.
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "number" && Number.isSafeInteger(current)) return String(current);
  if (typeof current !== "string" || current === "") {
    throw new Error(`${basename(binary)} returned no ${path.join(".")}`);
  }
  return current;
}

/** Closes a pane through `args`, treating "already closed" as success so teardown is idempotent. */
async function closePane(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  alreadyGone: (outcome: CliOutcome) => boolean,
): Promise<void> {
  const outcome = await invoke(binary, args, env);
  if (outcome.code === 0 || alreadyGone(outcome)) return;
  throw new Error(describe(binary, outcome));
}

/**
 * Herdr exposes no focus-by-id in 0.9.0, so the sibling is reached by focusing right of the host
 * pane. Everything else is addressed by the full pane id (`w1:p2`).
 */
function createHerdr(hostPane: string, binary: string, env: NodeJS.ProcessEnv): Multiplexer {
  const run = (args: readonly string[]) => call(binary, args, env);
  return {
    kind: "herdr",
    name: "Herdr",
    async open(cwd, launcher) {
      // `pane run` types the line into the pane's interactive shell (fish on the owner's machine),
      // where a quote or backslash inside the path would change its meaning; the launcher path is
      // built by the host, so this guard never fires in practice.
      if (/['\\\n]/.test(launcher)) {
        throw new Error(`Cannot start Hunk in Herdr: ${launcher} cannot be quoted for a shell`);
      }
      const stdout = await run([
        "pane",
        "split",
        "--pane",
        hostPane,
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        cwd,
        "--focus",
      ]);
      const id = readId(parseJson(binary, stdout), ["result", "pane", "pane_id"], binary);
      // Only an `exec`ed process makes Herdr close the pane when it exits; a plain `run` would
      // leave the shell prompt behind after `q`.
      await run(["pane", "run", id, `exec /bin/sh '${launcher}'`]);
      return { kind: "herdr", id };
    },
    async focus() {
      // The pane is always the host pane's right neighbour (it was split from it).
      await run(["pane", "focus", "--pane", hostPane, "--direction", "right"]);
    },
    async close(pane) {
      await closePane(binary, ["pane", "close", pane.id], env, (outcome) =>
        // A pane that is already closed is exactly the state this call wants.
        /pane_not_found|not found/i.test(`${outcome.stderr}\n${outcome.stdout}`),
      );
    },
    async alive(pane) {
      const outcome = await invoke(binary, ["pane", "get", pane.id], env);
      return outcome.code === 0;
    },
  };
}

/** Rex exit codes are stable: 0 ok, 3 target not found, 4 server unreachable. */
function createRex(hostPane: string, binary: string, env: NodeJS.ProcessEnv): Multiplexer {
  const run = (args: readonly string[]) => call(binary, args, env);
  return {
    kind: "rex",
    name: "Rex",
    async open(cwd, launcher) {
      const stdout = await run([
        "split",
        // Rex anchors on `$REX_BLOCK` when it runs inside a block, but the id is explicit so a
        // different caller environment can never split someone else's pane.
        "-b",
        hostPane,
        "--split=right",
        "--ratio",
        "50",
        "--focus=true",
        // Never start a server the user did not have running.
        "--autostart=false",
        "--cwd",
        cwd,
        "--json",
        "--",
        "/bin/sh",
        launcher,
      ]);
      const json = parseJson(binary, stdout);
      const ids =
        typeof json === "object" && json !== null && "block_ids" in json
          ? json.block_ids
          : undefined;
      const id = Array.isArray(ids) ? ids[0] : undefined;
      if (typeof id !== "string" || id === "") {
        throw new Error(`${basename(binary)} returned no block_ids[0]: ${stdout.trim()}`);
      }
      return { kind: "rex", id };
    },
    async focus(pane) {
      await run(["focus", pane.id]);
    },
    async close(pane) {
      await closePane(binary, ["block", "close", pane.id], env, (outcome) => outcome.code === 3);
    },
    async alive(pane) {
      const outcome = await invoke(binary, ["block", "inspect", pane.id, "--json"], env);
      return outcome.code === 0;
    },
  };
}

/** Tern's CLI is the `tern` shim on PATH; `TERN_EXE` names the daemon app, not the CLI. */
function createTern(hostPane: string, binary: string, env: NodeJS.ProcessEnv): Multiplexer {
  const run = (args: readonly string[]) => call(binary, args, env);
  return {
    kind: "tern",
    name: "Tern",
    async open(cwd, launcher) {
      // No `--keep-open` (the block must disappear on `q`) and no `--end-on-success` (it ends the
      // whole session). The argv is quoted by Tern itself and run through the user's shell.
      const stdout = await run([
        "split",
        hostPane,
        "right",
        "--cwd",
        cwd,
        "--json",
        "--",
        "/bin/sh",
        launcher,
      ]);
      const id = readId(parseJson(binary, stdout), ["block"], binary);
      // A split never moves focus, so an unfocused pane would leave the user typing into the agent.
      await run(["focus", id, "--json"]);
      return { kind: "tern", id };
    },
    async focus(pane) {
      await run(["focus", pane.id, "--json"]);
    },
    async close(pane) {
      await closePane(binary, ["close", pane.id, "--json"], env, (outcome) =>
        /no block/i.test(`${outcome.stderr}\n${outcome.stdout}`),
      );
    },
    async alive(pane) {
      const outcome = await invoke(binary, ["process", pane.id, "--json"], env);
      // Exit 1 means the block is gone; exit 0 with `child: null` means its program exited but the
      // block is still on screen, which is not a pane Hunk can be focused in.
      if (outcome.code !== 0) return false;
      try {
        const json: unknown = JSON.parse(outcome.stdout);
        if (typeof json !== "object" || json === null || !("child" in json)) return false;
        return json.child !== null && json.child !== undefined;
      } catch {
        // A shape the host cannot read is not a pane it can hand the keyboard to.
        return false;
      }
    },
  };
}

/**
 * Innermost first: Herdr runs inside a terminal app (its variables arrive beside the outer app's),
 * and Rex can run inside Tern. Splitting the deepest host is the only split that puts Hunk beside
 * the pane the user is actually looking at.
 */
export function detectMultiplexer(env: NodeJS.ProcessEnv): Multiplexer | undefined {
  const herdrPane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV === "1" && herdrPane) {
    return createHerdr(herdrPane, env.HERDR_BIN_PATH ?? "herdr", env);
  }
  const rexBlock = env.REX_BLOCK;
  if (rexBlock) {
    return createRex(rexBlock, env.REX_BIN_DIR ? join(env.REX_BIN_DIR, "rex") : "rex", env);
  }
  const ternPane = env.TERN_PANE;
  if (ternPane) return createTern(ternPane, "tern", env);
  return undefined;
}

/** Absolute path of the `hunk` the host would run from `env.PATH`; throws when not found. */
export async function resolveHunk(env: NodeJS.ProcessEnv): Promise<string> {
  // `execFile` would resolve a bare `hunk` through the *host's* PATH, but the pane runs under the
  // user's login shell with its own PATH, so the launcher needs this exact absolute path.
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    // An empty entry means "the current directory", which is not a place the host installs Hunk.
    if (entry === "") continue;
    const candidate = resolve(entry, "hunk");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable or not there; the next entry may hold it.
    }
  }
  throw new Error("hunk was not found on PATH");
}

/** POSIX single quotes: everything is literal, and a quote is closed, escaped and reopened. */
function q(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes the script the pane runs, rather than passing a command line: Tern executes through the
 * user's shell, Herdr types into it and Rex passes no environment at all, so a script is the only
 * shape all three accept. It also pins PATH, which fish/mise rebuild and can point at another Hunk.
 */
export async function writeLauncher(
  path: string,
  options: {
    readonly hunk: string;
    readonly bridge: string;
    readonly launch: ReviewLaunch;
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const forwarded = Object.keys(options.env)
    .filter((key) => key.startsWith("HUNK_"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap((key) => {
      const value = options.env[key];
      return value === undefined ? [] : [`export ${key}=${q(value)}`];
    });
  const script = [
    "#!/bin/sh",
    `export PATH=${q(dirname(options.hunk))}:"$PATH"`,
    `export ${REVIEW_ENV}=${q(JSON.stringify(options.launch))}`,
    ...forwarded,
    // Hunk reviews the directory it starts in. Not every terminal honors its `--cwd` for the
    // pane's shell, so the script moves there itself; a failed `cd` still reaches the record below.
    `cd ${q(options.launch.cwd)} && ${q(options.hunk)} ${options.launch.view} --extension ${q(options.bridge)}`,
    "status=$?",
    // The bridge cannot report its own exit, so this record is how the host learns the review is
    // over (the pane closes itself on exit 0 in all three terminals).
    `printf '{"_tag":"Exited","status":%d}\\n' "$status" >> ${q(options.launch.journal)}`,
    'exit "$status"',
  ].join("\n");
  // `wx` fails when a launcher already exists, so a live pane can never have its script rewritten.
  // 0700: the file carries the review payload, which only the user may read.
  await writeFile(path, `${script}\n`, { flag: "wx", mode: 0o700 });
}
