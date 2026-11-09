import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { editConfig, type ConfigUI } from "./config-ui.js";
import {
  CAPTURE_FAILURE_EXIT_CODE,
  REVIEW_ENV,
  type Config,
  type ReviewLaunch,
  type View,
} from "./contract.js";
import { formatFeedback, readFeedback } from "./feedback.js";

interface Terminal {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
}
interface Component {
  render(width: number): string[];
  invalidate(): void;
}
export interface HostContext {
  readonly mode: string;
  readonly cwd: string;
  isIdle(): boolean;
  abort(): void;
  readonly ui: ConfigUI & {
    onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
    custom<T>(
      factory: (
        tui: Terminal,
        theme: unknown,
        keys: unknown,
        done: (value: T) => void,
      ) => Component | Promise<Component>,
    ): Promise<T>;
  };
}
export interface HostBindings {
  readonly bridge: string;
  readonly configPath: string;
  matchesKey(data: string, key: string): boolean;
  isKeyRelease(data: string): boolean;
  sendUserMessage(message: string, options?: { deliverAs: "steer" | "followUp" }): void;
}

interface Session {
  readonly ctx: HostContext;
  readonly config: Config;
}
/** Where an edit hands the keyboard back; only a listening session owns the key handler. */
type Restore =
  | { readonly _tag: "None" }
  | { readonly _tag: "Listening"; readonly session: Session };
/**
 * One host lifecycle. Every phase a stop can interrupt owns its `cancel` and the `settled` promise
 * that tells `stop` when the phase is really over; nothing is filled in after the phase starts.
 */
type State =
  | { readonly _tag: "Inactive" }
  | { readonly _tag: "Loading"; readonly settled: Promise<void> }
  | {
      readonly _tag: "Configuring";
      readonly cancel: AbortController;
      readonly settled: Promise<void>;
      readonly restore: Restore;
    }
  | { readonly _tag: "Listening"; readonly session: Session; readonly unsubscribe: () => void }
  | { readonly _tag: "Armed"; readonly session: Session; readonly unsubscribe: () => void }
  | {
      readonly _tag: "Reviewing";
      readonly session: Session;
      readonly cancel: AbortController;
      readonly settled: Promise<LaunchResult>;
    }
  | { readonly _tag: "Stopping"; readonly settled: Promise<void> };

/** The newest `start`/`stop` request, compared by identity so only the latest may proceed. */
type Request = { readonly _tag: "Start" } | { readonly _tag: "Stop" };

/** How far a launch got; only a phase that owns a journal can quote a recovery path. */
type Recovery =
  | { readonly _tag: "Preparing" }
  | { readonly _tag: "Journaled"; readonly journal: string };
/**
 * How a review ended. Only a teardown failure is surfaced from `stop()`; every other ending has
 * already been reported (or is deliberately silent) and sends nothing.
 */
type LaunchResult =
  | { readonly _tag: "Finished" }
  | { readonly _tag: "TeardownFailed"; readonly error: Error };

/** How one interactive configuration edit ended; only a save replaces the active session. */
type ConfigOutcome =
  | { readonly _tag: "Saved"; readonly config: Config }
  | { readonly _tag: "Discarded" }
  | { readonly _tag: "Failed"; readonly error: Error };

type ChildExit =
  | {
      readonly _tag: "Closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly _tag: "SpawnError"; readonly error: Error };
/** The child's lifecycle; `closed` settles with the exit this records. */
type ChildLifecycle =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Exited"; readonly exit: ChildExit };
interface OwnedChild {
  readonly process: ChildProcess;
  readonly closed: Promise<ChildExit>;
  /** Written by the `close` listener alone; the synchronous view for the monitor loop. */
  lifecycle: ChildLifecycle;
}

/** What the owned child and terminal handoff produced. */
type ReviewOutcome =
  | { readonly _tag: "Exited"; readonly exit: ChildExit }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Failed"; readonly error: Error };

/** The first failure a teardown step saw; later failures never replace it. */
type Failure = { readonly _tag: "None" } | { readonly _tag: "Failed"; readonly error: Error };
/** The one-shot release of a frozen launcher. */
type RootRelease = { readonly _tag: "Held" } | { readonly _tag: "Released" };
/** First observation that the child closed; the teardown grace window runs from that tick. */
type ClosedWatch =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Observed"; readonly at: number };

const consumed = { consume: true };
const emptyComponent: Component = { render: () => [], invalidate: () => {} };
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
class HunkTeardownError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause === undefined ? message : message + ": " + asError(cause).message);
    this.name = "HunkTeardownError";
  }
}

const HUNK_INSTALL =
  "Install Hunk 0.22.0 or newer from https://hunk.dev; pi-hunk does not install or upgrade Hunk.";

/** How long `interrupt` delivery waits for the aborted turn to become idle before queueing. */
const INTERRUPT_IDLE_TIMEOUT_MS = 30_000;

/** Journals a `stop()` took over, each named once by the first hook that has the terminal back. */
const abandoned = new Set<string>();
let abandonedHook = false;

/**
 * Writes the recovery notices to stderr, the one channel that survives the host TUI: a `ui.notify`
 * raised after the TUI is gone can never render. `stop()` can end a review while the TUI is gone
 * (Pi: the notice waits for the `exit` handler, once the terminal is restored) or still closing
 * (OMP: the host reports after its shutdown handler resolves). Whichever runs first drains the set.
 */
function flushAbandoned(): void {
  if (abandoned.size === 0) return;
  const notices = [...abandoned].map(
    (path) => `pi-hunk: the Hunk review ended without handoff; your comments are saved at ${path}`,
  );
  abandoned.clear();
  try {
    writeSync(2, `\n${notices.join("\n")}\n`);
  } catch {
    // A terminal that is already gone loses the notice; the journals themselves stay on disk.
  }
}

/** Remembers an abandoned journal until a hook with a restored terminal can name it. */
function announce(journal: string): void {
  abandoned.add(journal);
  if (abandonedHook) return;
  abandonedHook = true;
  process.on("exit", flushAbandoned);
}

/**
 * Ends a review `stop()` took over. The child is already closed, so its journal is final: one that
 * captured comments (or failed partway) is kept and named, because it is the only copy of them. One
 * that captured nothing is discarded exactly as an empty review is on a normal close.
 */
async function abandonReview(recovery: Recovery): Promise<void> {
  if (recovery._tag !== "Journaled") return;
  const { journal } = recovery;
  const read = await readFeedback(journal).catch(() => undefined);
  const captured =
    read === undefined
      ? await stat(journal).then(
          (info) => info.size > 0,
          () => false,
        )
      : read.notes.length > 0 || read.uncommitted !== undefined;
  if (captured) announce(journal);
  else await rm(dirname(journal), { recursive: true }).catch(() => {});
}

/**
 * Waits `ms`, returning as soon as `signal` aborts. Callers re-check `signal.aborted`; an abort is
 * never an error, because a cancelled operation sends nothing.
 */
async function idleTick(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** Resolves when `signal` aborts; never settles while the operation runs, and never rejects. */
function untilAborted(signal: AbortSignal): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  if (signal.aborted) resolve(undefined);
  else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  return promise;
}

async function requireHunk(signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(
    "hunk",
    ["--version"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, signal },
    (error, stdout, stderr) => {
      if (error) {
        if ("code" in error && error.code === "ENOENT") {
          reject(new Error(`hunk was not found on PATH. ${HUNK_INSTALL}`));
          return;
        }
        reject(
          new Error(
            `Cannot run hunk: ${(stderr && stderr.trim()) || error.message}. pi-hunk requires Hunk 0.22.0 or newer. ${HUNK_INSTALL}`,
          ),
        );
        return;
      }
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
      if (match && Number(match[1]) === 0 && Number(match[2]) < 22) {
        reject(
          new Error(
            `pi-hunk requires Hunk 0.22.0 or newer; PATH hunk reports ${match[0]}. ${HUNK_INSTALL}`,
          ),
        );
        return;
      }
      // Successful --version without x.y.z is not treated as outdated.
      // Launch continues; the bridge still throws if apiVersion < 25.
      resolve();
    },
  );
  await promise;
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly tty: string;
  readonly start: string;
}

const PS_ARGUMENTS = ["-axo", "pid=,ppid=,pgid=,sess=,tty=,lstart=,command="] as const;
/** `ps` has no fixed location: NixOS and busybox put it on `PATH` only. */
const PS_CANDIDATES = ["ps", "/bin/ps", "/usr/bin/ps"] as const;
/** The binary that last worked; a resolved `ps` is not searched for again. */
let psBinary: string | undefined;

function readProcessTable(): string {
  let missing: unknown;
  for (const binary of psBinary === undefined ? PS_CANDIDATES : [psBinary]) {
    try {
      const output = execFileSync(binary, PS_ARGUMENTS, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // The parser reads fixed-width fields, so the table must never be localized.
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        // Long command lines on a busy host exceed Node's 1 MiB default.
        maxBuffer: 16 * 1024 * 1024,
      });
      psBinary = binary;
      return output;
    } catch (error) {
      // A ps that ran and failed is the answer; only a missing binary earns another candidate.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      missing ??= error;
    }
  }
  throw missing ?? new Error("No ps binary found on PATH");
}

function processTable(): Map<number, ProcessIdentity> {
  if (process.platform === "win32") return new Map();
  const output = readProcessTable();
  const processes = new Map<number, ProcessIdentity>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);
    if (match)
      processes.set(Number(match[1]), {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        sid: Number(match[4]),
        tty: match[5],
        start: match[6],
      });
  }
  return processes;
}

function descendantsOf(
  rootPid: number,
  processes: ReadonlyMap<number, ProcessIdentity>,
  owner?: ProcessIdentity,
): ProcessIdentity[] {
  const descendants = new Map<number, ProcessIdentity>();
  let added = true;
  while (added) {
    added = false;
    for (const process of processes.values()) {
      if (
        !descendants.has(process.pid) &&
        (process.ppid === rootPid || descendants.has(process.ppid)) &&
        (owner === undefined || sameProcessGroup(owner, process))
      ) {
        descendants.set(process.pid, process);
        added = true;
      }
    }
  }
  return [...descendants.values()];
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.start === b.start;
}
function sameProcessGroup(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pgid === b.pgid && a.sid === b.sid && a.tty === b.tty;
}

function signalIdentity(
  expected: ProcessIdentity,
  signal: NodeJS.Signals,
  processes: ReadonlyMap<number, ProcessIdentity>,
): boolean {
  const current = processes.get(expected.pid);
  if (!current || !sameProcess(expected, current)) return false;
  try {
    process.kill(expected.pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function liveProcesses(
  expected: ReadonlyMap<number, ProcessIdentity>,
  processes: ReadonlyMap<number, ProcessIdentity>,
): ProcessIdentity[] {
  return [...expected.values()].filter((process) => {
    const current = processes.get(process.pid);
    return current !== undefined && sameProcess(process, current);
  });
}

/** A table that stops being readable ends verification instead of failing the teardown. */
async function waitForProcesses(
  processes: ReadonlyMap<number, ProcessIdentity>,
  onUnavailable: (error: Error) => void,
): Promise<void> {
  if (processes.size === 0) return;
  const deadline = Date.now() + 2_000;
  for (;;) {
    let current: Map<number, ProcessIdentity>;
    try {
      current = processTable();
    } catch (error) {
      onUnavailable(asError(error));
      return;
    }
    const live = liveProcesses(processes, current);
    if (live.length === 0) return;
    if (Date.now() >= deadline) {
      throw new HunkTeardownError(
        "Owned Hunk processes did not exit: " + live.map((process) => process.pid).join(", "),
      );
    }
    await delay(20);
  }
}

function startChild(launch: ReviewLaunch, bridge: string): OwnedChild {
  const child = spawn("hunk", [launch.view, "--extension", bridge], {
    cwd: launch.cwd,
    env: { ...process.env, [REVIEW_ENV]: JSON.stringify(launch) },
    stdio: "inherit",
  });
  // A spawn failure arrives as an `error` event before `close`; it replaces the exit.
  let failed: { readonly _tag: "Running" } | { readonly _tag: "Failed"; readonly error: Error } = {
    _tag: "Running",
  };
  const { promise, resolve } = Promise.withResolvers<ChildExit>();
  const owned: OwnedChild = { process: child, lifecycle: { _tag: "Running" }, closed: promise };
  child.once("error", (error) => {
    failed = { _tag: "Failed", error };
  });
  // `exit` precedes stdio closure; only `close` is the handoff boundary.
  child.once("close", (code, signal) => {
    const exit: ChildExit =
      failed._tag === "Failed"
        ? { _tag: "SpawnError", error: failed.error }
        : { _tag: "Closed", code, signal };
    owned.lifecycle = { _tag: "Exited", exit };
    resolve(exit);
  });
  return owned;
}

/** True when `settled` finished before the deadline; the wait itself never rejects. */
async function settledWithin(settled: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    settled.then(
      () => true,
      () => true,
    ),
    delay(milliseconds).then(() => false),
  ]);
}

async function closeChild(child: OwnedChild, warn: (message: string) => void): Promise<void> {
  if (child.lifecycle._tag === "Exited") return;
  const rootPid = child.process.pid;
  if (rootPid === undefined) {
    signalChild(child.process, "SIGTERM");
    await child.closed;
    return;
  }

  const descendants = new Map<number, ProcessIdentity>();
  const terminated = new Set<number>();
  let root: ProcessIdentity | undefined;
  /** Set once the process table cannot be read; teardown then owns only the direct child. */
  let unenumerable: Error | undefined;
  let warned = false;
  /** Warned once per teardown: a host without a readable table is not a per-tick event. */
  const reportUnenumerable = (error: Error): void => {
    if (warned) return;
    warned = true;
    warn(
      `Cannot read the process table (${error.message}); stopping only the Hunk process itself. Processes it started may survive.`,
    );
  };
  /**
   * Without a table no descendant can be enumerated or identity-checked, so the launcher
   * pi-hunk spawned is the only handle. It is stopped directly and the teardown is not
   * failed for processes it could not see.
   */
  const stopDirect = async (): Promise<void> => {
    // A frozen launcher still has to be let go before a signal can reach it.
    signalChild(child.process, "SIGCONT");
    signalChild(child.process, "SIGTERM");
    if (await settledWithin(child.closed, 1_000)) return;
    signalChild(child.process, "SIGKILL");
    if (!(await settledWithin(child.closed, 2_000)))
      throw new HunkTeardownError("Hunk process teardown did not settle");
  };
  /** First failure any teardown step saw; later failures never replace it. */
  const failure: { current: Failure } = { current: { _tag: "None" } };
  const remember = (error: unknown) => {
    if (failure.current._tag === "None")
      failure.current = { _tag: "Failed", error: asError(error) };
  };
  const capture = (
    table: Map<number, ProcessIdentity>,
    anchorPid: number,
    expected: ProcessIdentity,
  ) => {
    if (!root) return;
    const currentAnchor = table.get(anchorPid);
    if (
      !currentAnchor ||
      !sameProcess(expected, currentAnchor) ||
      !sameProcessGroup(root, currentAnchor)
    )
      return;
    for (const process of descendantsOf(anchorPid, table, root)) {
      const known = descendants.get(process.pid);
      if (!known) descendants.set(process.pid, process);
      else if (!sameProcess(known, process)) terminated.add(process.pid);
    }
  };
  const refresh = (): Map<number, ProcessIdentity> | undefined => {
    try {
      const table = processTable();
      const currentRoot = table.get(rootPid);
      if (currentRoot && (root === undefined || sameProcess(root, currentRoot))) {
        root ??= currentRoot;
        capture(table, rootPid, currentRoot);
      }
      // A launcher may exit before a captured child spawns its own child. Keep each
      // live, identity-checked descendant as an anchor without widening ownership.
      if (root) {
        for (const known of descendants.values()) {
          const currentAnchor = table.get(known.pid);
          if (
            currentAnchor &&
            sameProcess(known, currentAnchor) &&
            sameProcessGroup(root, currentAnchor)
          )
            capture(table, known.pid, known);
        }
      }
      return table;
    } catch (error) {
      // A host without a usable ps still has to be able to close its own child.
      unenumerable ??= asError(error);
      return undefined;
    }
  };
  const send = (
    process: ProcessIdentity,
    signal: NodeJS.Signals,
    current: Map<number, ProcessIdentity> | undefined,
  ): boolean => {
    if (!current) return false;
    try {
      return signalIdentity(process, signal, current);
    } catch (error) {
      remember(error);
      return false;
    }
  };
  const sendDescendants = (current: Map<number, ProcessIdentity> | undefined) => {
    if (!current) return;
    for (const process of descendants.values()) {
      if (terminated.has(process.pid)) continue;
      if (send(process, "SIGTERM", current)) terminated.add(process.pid);
    }
  };
  const sendRoot = (signal: NodeJS.Signals, current: Map<number, ProcessIdentity> | undefined) => {
    if (root && current) send(root, signal, current);
    else {
      try {
        signalChild(child.process, signal);
      } catch (error) {
        remember(error);
      }
    }
  };

  // Freeze the launcher before rescanning so its captured descendants remain
  // traversal anchors until the owned tree is drained.
  const initial = refresh();
  if (unenumerable) {
    reportUnenumerable(unenumerable);
    await stopDirect();
    return;
  }
  sendRoot("SIGSTOP", initial);
  sendDescendants(refresh());

  const startedAt = Date.now();
  let release: RootRelease = { _tag: "Held" };
  let observed: ClosedWatch = { _tag: "Running" };
  const releaseRoot = (current: Map<number, ProcessIdentity>) => {
    if (release._tag === "Released") return;
    release = { _tag: "Released" };
    sendRoot("SIGTERM", current);
    sendRoot("SIGCONT", current);
  };
  const escalation = setTimeout(() => {
    const current = refresh();
    if (current) {
      for (const process of descendants.values()) send(process, "SIGKILL", current);
      if (root) send(root, "SIGKILL", current);
    } else {
      try {
        signalChild(child.process, "SIGKILL");
      } catch (error) {
        remember(error);
      }
    }
  }, 500);
  const monitorRun = new AbortController();
  const monitor = (async () => {
    while (!monitorRun.signal.aborted) {
      await idleTick(20, monitorRun.signal);
      if (monitorRun.signal.aborted) break;
      if (child.lifecycle._tag === "Exited" && observed._tag === "Running")
        observed = { _tag: "Observed", at: Date.now() };
      const current = refresh();
      sendDescendants(current);
      const live = current === undefined ? undefined : liveProcesses(descendants, current);
      if (
        release._tag === "Held" &&
        child.lifecycle._tag === "Running" &&
        current !== undefined &&
        live !== undefined &&
        live.length === 0
      )
        releaseRoot(current);
      if (child.lifecycle._tag === "Exited") {
        if (live?.length === 0) break;
        if (observed._tag === "Observed" && Date.now() - observed.at >= 2_000) break;
      } else if (Date.now() - startedAt >= 2_000) {
        break;
      }
    }
  })().catch((error) => {
    remember(error);
  });
  try {
    await Promise.race([child.closed, monitor]);
    const atSettle: Failure = failure.current;
    if (child.lifecycle._tag === "Running") {
      // The table can disappear mid-teardown; the launcher is still ours to stop.
      if (unenumerable) {
        reportUnenumerable(unenumerable);
        await stopDirect();
        return;
      }
      throw new HunkTeardownError(
        "Hunk process teardown did not settle",
        atSettle._tag === "Failed" ? atSettle.error : undefined,
      );
    }
    await child.closed;
    await monitor;
    const atVerify: Failure = failure.current;
    if (atVerify._tag === "Failed")
      throw new HunkTeardownError("Hunk process teardown could not be verified", atVerify.error);
    // Nothing captured before the table went away can be verified afterwards.
    await waitForProcesses(descendants, (error) => {
      unenumerable ??= error;
    });
    if (unenumerable) reportUnenumerable(unenumerable);
  } finally {
    monitorRun.abort();
    clearTimeout(escalation);
    await monitor;
  }
}

/** The child is closed first, then the terminal comes back, on every exit path. */
async function runChild(
  tui: Terminal,
  launch: ReviewLaunch,
  bridge: string,
  signal: AbortSignal,
  warn: (message: string) => void,
  hostClosing: () => boolean,
): Promise<ReviewOutcome> {
  let outcome: ReviewOutcome;
  try {
    tui.stop();
    outcome = await ownChild(launch, bridge, signal, warn);
  } catch (error) {
    outcome = { _tag: "Failed", error: asError(error) };
  }
  // A review the host's own shutdown cancelled leaves the terminal to the host, which restores
  // it right after this settles. Starting the TUI here would make it query the terminal while
  // that restore is already in flight: the reply arrives once the shell owns the tty again and
  // the line discipline echoes it. Every other ending (a close, a session switch) restarts it.
  if (!hostClosing()) {
    tui.start();
    tui.requestRender(true);
  }
  return outcome;
}

/** The child is closed before this settles, including on cancellation and on errors. */
async function ownChild(
  launch: ReviewLaunch,
  bridge: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<ReviewOutcome> {
  const child = startChild(launch, bridge);
  try {
    // A cancelled review stops waiting for a child that would never exit by itself.
    const exit = await Promise.race([child.closed, untilAborted(signal)]);
    if (exit === undefined) return { _tag: "Cancelled" };
    return { _tag: "Exited", exit };
  } finally {
    await closeChild(child, warn);
  }
}

/** How long an interrupt waits for the review teardown before reporting and re-raising anyway. */
const INTERRUPT_GRACE_MS = 5_000;

/** One lifecycle shared by the native Pi and OMP entrypoints. */
export function createHost(bindings: HostBindings) {
  let state: State = { _tag: "Inactive" };
  /** The newest start or stop request; identity decides which one may still take over. */
  let request: Request = { _tag: "Stop" };
  /** Journal of the review that is open right now; only an interrupted review falls back to it. */
  let pendingJournal: string | undefined;
  /**
   * True between the host's `stop()` and a later `start()`: the host is leaving and restores the
   * terminal itself, so a review cancelled now must not start the host TUI again. `start()` clears
   * it, because a host that keeps running after a `stop()` (a session replacement) owns a live TUI.
   */
  let hostClosing = false;

  function stopCurrent(): Promise<void> {
    switch (state._tag) {
      case "Inactive":
        return Promise.resolve();
      case "Stopping":
        return state.settled;
      case "Listening":
      case "Armed":
        state.unsubscribe();
        state = { _tag: "Inactive" };
        return Promise.resolve();
      case "Loading":
      case "Configuring":
      case "Reviewing": {
        const previous = state;
        // Only a review can end in a teardown failure, and `stop` must surface exactly that.
        const failure: Promise<Error | undefined> =
          previous._tag === "Reviewing"
            ? previous.settled.then((result) =>
                result._tag === "TeardownFailed" ? result.error : undefined,
              )
            : previous.settled.then(() => undefined);
        // Invalidate ownership before cancellation so a closing child cannot send.
        const stopping: State = {
          _tag: "Stopping",
          settled: failure.then((error) => {
            if (state === stopping) state = { _tag: "Inactive" };
            if (error) throw error;
          }),
        };
        state = stopping;
        if (previous._tag !== "Loading") previous.cancel.abort();
        return stopping.settled;
      }
    }
  }

  /**
   * SIGINT while Hunk owns the terminal. Neither host's own signal path can close the review:
   * Pi re-raises through `signal-exit`, which only re-raises while no foreign listener holds the
   * signal, and an OMP shutdown is already racing the child. So the listener closes the review
   * itself, names the journal, and re-raises the signal with itself removed, which restores the
   * host's own termination path (Pi: re-raise; OMP: its idempotent shutdown handler). It exists
   * only while a review is open, because it disables the default termination both hosts rely on
   * outside one.
   */
  function watchInterrupt(): () => void {
    let ending = false;
    const release = (): void => {
      process.removeListener("SIGINT", handler);
      // A teardown that never settled leaves the review's journal unnamed; it is the only copy.
      if (pendingJournal !== undefined && abandoned.size === 0) announce(pendingJournal);
      // The host repaints its own screen while the review closes; a notice written there is
      // discarded with the alternate screen when the signal is re-raised. Leave it first.
      try {
        writeSync(2, "\x1b[?1049l");
      } catch {
        // A terminal that is already gone keeps the journal on disk; nothing to name it to.
      }
      flushAbandoned();
      process.kill(process.pid, "SIGINT");
    };
    const handler = (): void => {
      // A second interrupt is the user refusing to wait for a teardown that may be hung.
      if (ending) {
        release();
        return;
      }
      ending = true;
      void Promise.race([stopCurrent().catch(() => undefined), delay(INTERRUPT_GRACE_MS)]).then(
        release,
      );
    };
    process.on("SIGINT", handler);
    return () => process.removeListener("SIGINT", handler);
  }

  function listen(session: Session): void {
    const listening: Extract<State, { _tag: "Listening" }> = {
      _tag: "Listening",
      session,
      unsubscribe: session.ctx.ui.onTerminalInput((data) => {
        // Ordinary inactive input allocates nothing and touches no state.
        if (bindings.isKeyRelease(data)) return;
        if (state === listening) {
          if (!bindings.matchesKey(data, session.config.prefix)) return;
          state = { _tag: "Armed", session, unsubscribe: listening.unsubscribe };
          return consumed;
        }
        // Only the armed handler of this session may launch; a stale one owns nothing.
        if (state._tag !== "Armed" || state.session !== session) return;
        state = listening;
        if (bindings.matchesKey(data, "escape")) return consumed;
        const view = bindings.matchesKey(data, session.config.diff)
          ? "diff"
          : bindings.matchesKey(data, session.config.show)
            ? "show"
            : bindings.matchesKey(data, session.config.log)
              ? "log"
              : undefined;
        if (!view) return;
        listening.unsubscribe();
        launch(session, view);
        return consumed;
      }),
    };
    state = listening;
  }

  function launch(session: Session, view: View): void {
    const cancel = new AbortController();
    const { promise: settled, resolve } = Promise.withResolvers<LaunchResult>();
    const reviewing: State = { _tag: "Reviewing", session, cancel, settled };
    state = reviewing;
    const detach = watchInterrupt();
    const active = () => state === reviewing && !cancel.signal.aborted;
    const finish = (result: LaunchResult) => {
      // The interrupt guard belongs to this review only; outside one it disables default death.
      detach();
      // Ownership comes back before `settled` resolves, as the old finalizer order required.
      if (active()) listen(session);
      resolve(result);
    };
    void runReview(session, view, cancel.signal, active)
      .then(finish, () => finish({ _tag: "Finished" }))
      // A host UI failure while restoring ownership must never leave `stop` waiting forever.
      .catch(() => resolve({ _tag: "Finished" }));
  }

  async function runReview(
    session: Session,
    view: View,
    signal: AbortSignal,
    active: () => boolean,
  ): Promise<LaunchResult> {
    let recovery: Recovery = { _tag: "Preparing" };
    try {
      await access(bindings.bridge);
      signal.throwIfAborted();
      await requireHunk(signal);
      const directory = await mkdtemp(join(tmpdir(), "pi-hunk-"));
      const journal = join(directory, "notes.jsonl");
      // From here a failure still names the journal, so saved comments stay recoverable.
      recovery = { _tag: "Journaled", journal };
      pendingJournal = journal;
      await writeFile(journal, "", { mode: 0o600, flag: "wx" });
      signal.throwIfAborted();
      const launchData: ReviewLaunch = {
        cwd: session.ctx.cwd,
        view,
        config: session.config,
        journal,
      };
      // The async factory does not mount a replacement editor. `done` closes it
      // after the child and terminal have both finished restoring.
      let teardownWarning: string | undefined;
      const outcome = await session.ctx.ui.custom<ReviewOutcome>(
        async (tui, _theme, _keys, done) => {
          done(
            await runChild(
              tui,
              launchData,
              bindings.bridge,
              signal,
              (message) => {
                teardownWarning ??= message;
              },
              () => hostClosing,
            ),
          );
          return emptyComponent;
        },
      );
      // A teardown that could not enumerate processes is reported once the terminal is back,
      // including while the host is stopping: the survivor outlives the review.
      const warning = teardownWarning;
      if (warning !== undefined) {
        try {
          session.ctx.ui.notify(warning, "warning");
        } catch {
          // A dying host UI must not turn a reported teardown warning into an exit.
        }
      }
      if (outcome._tag === "Cancelled") {
        // `stop()` ended the review; nothing was handed off, so the journal is the only copy.
        await abandonReview(recovery);
        return { _tag: "Finished" };
      }
      if (outcome._tag === "Failed") throw outcome.error;
      const childExit = outcome.exit;
      if (childExit._tag === "SpawnError") throw childExit.error;
      if (childExit.code === CAPTURE_FAILURE_EXIT_CODE)
        throw new Error(
          "Hunk comment capture failed; the recovery journal may be incomplete and was not submitted.",
        );
      const abnormal = childExit.code !== 0 || childExit.signal !== null;
      if (abnormal)
        session.ctx.ui.notify(
          `Hunk exited ${childExit.signal ?? `with code ${childExit.code}`}; saved comments will still be handed off. Recovery: ${journal}`,
          "warning",
        );
      const read = await readFeedback(journal, signal);
      if (!active()) {
        await abandonReview(recovery);
        return { _tag: "Finished" };
      }
      const { notes, uncommitted } = read;
      // An interrupted append costs only that record; say which one and what still survived.
      if (uncommitted !== undefined)
        session.ctx.ui.notify(
          `Hunk journal ${journal} ends with an unfinished record (line ${uncommitted.line}), which was not replayed. ${
            notes.length === 0
              ? "No comment was captured; the journal is kept for recovery."
              : `${notes.length} saved comment(s) were handed off; the newest saved change may be missing.`
          }`,
          "warning",
        );
      if (notes.length === 0) {
        if (!abnormal && uncommitted === undefined) await rm(directory, { recursive: true });
        return { _tag: "Finished" };
      }
      if (!session.ctx.isIdle() && session.config.delivery === "interrupt") {
        // Native abort returns void. In particular Pi restores prior queues to
        // its composer; we neither await abort nor replace those native semantics.
        session.ctx.abort();
        // An abort that never makes the session idle must not leave the review silent and the
        // keyboard unowned: the wait is bounded and says what it is waiting for.
        const deadline = Date.now() + INTERRUPT_IDLE_TIMEOUT_MS;
        let announced = false;
        while (!session.ctx.isIdle() && !signal.aborted && Date.now() < deadline) {
          if (!announced) {
            announced = true;
            session.ctx.ui.notify(
              "Hunk review: interrupting the current turn; waiting for the agent to become idle.",
              "info",
            );
          }
          await idleTick(20, signal);
        }
        if (!session.ctx.isIdle() && !signal.aborted)
          session.ctx.ui.notify(
            `Hunk review: the agent is still busy after interrupting; the comments were queued as a follow-up. Recovery: ${journal}`,
            "warning",
          );
      }
      if (!active()) {
        await abandonReview(recovery);
        return { _tag: "Finished" };
      }
      const message = formatFeedback(notes);
      if (session.ctx.isIdle()) bindings.sendUserMessage(message);
      else
        bindings.sendUserMessage(message, {
          // An interrupt that timed out falls back to the follow-up queue; comments are never
          // dropped because the turn did not stop.
          deliverAs: session.config.delivery === "steer" ? "steer" : "followUp",
        });
      // Native sendUserMessage returns void and hides asynchronous failures.
      // Retain recovery rather than treating call acceptance as a receipt.
      return { _tag: "Finished" };
    } catch (error) {
      const failure = asError(error);
      if (!active()) await abandonReview(recovery);
      else
        session.ctx.ui.notify(
          `Hunk review failed: ${failure.message}${recovery._tag === "Journaled" ? `\nRecovery: ${recovery.journal}` : ""}`,
          "error",
        );
      return failure instanceof HunkTeardownError
        ? { _tag: "TeardownFailed", error: failure }
        : { _tag: "Finished" };
    } finally {
      // Only an open review can be interrupted into an unnamed journal; reviews are serialized.
      pendingJournal = undefined;
    }
  }

  async function configure(args: string, ctx: HostContext): Promise<void> {
    if (args.trim() !== "config") {
      ctx.ui.notify("Usage: /hunk config", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Hunk configuration requires an interactive terminal.", "warning");
      return;
    }
    if (state._tag !== "Listening" && state._tag !== "Armed" && state._tag !== "Inactive") {
      ctx.ui.notify("Finish the current Hunk operation before configuring it.", "warning");
      return;
    }

    const restore: Restore =
      state._tag === "Inactive" ? { _tag: "None" } : { _tag: "Listening", session: state.session };
    if (state._tag !== "Inactive") state.unsubscribe();
    const cancel = new AbortController();
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const configuring: State = { _tag: "Configuring", cancel, settled, restore };
    state = configuring;
    const active = () => state === configuring && !cancel.signal.aborted;
    const finish = (outcome: ConfigOutcome) => {
      if (!active()) return;
      if (outcome._tag === "Saved") {
        ctx.ui.notify(
          `Hunk configuration saved to ${bindings.configPath}. Changes are active.`,
          "info",
        );
        if (!active()) return;
        listen({ ctx, config: outcome.config });
        return;
      }
      if (outcome._tag === "Failed")
        ctx.ui.notify(`Hunk configuration failed: ${outcome.error.message}`, "error");
      if (!active()) return;
      if (restore._tag === "Listening") listen(restore.session);
      else state = { _tag: "Inactive" };
    };
    void editConfig(bindings.configPath, ctx.ui, cancel.signal)
      .then(
        (config): ConfigOutcome =>
          config === undefined ? { _tag: "Discarded" } : { _tag: "Saved", config },
        (error: unknown): ConfigOutcome => ({ _tag: "Failed", error: asError(error) }),
      )
      .then((outcome) => {
        finish(outcome);
        resolve();
      })
      // A host UI failure while restoring the keyboard must never leave `stop` waiting forever.
      .catch(() => resolve());
    await settled;
  }

  async function start(ctx: HostContext): Promise<void> {
    const mine: Request = { _tag: "Start" };
    request = mine;
    // This host is alive: a review cancelled here must restore its TUI like any other close.
    hostClosing = false;
    // A previous teardown can fail on unverifiable process cleanup. That error belongs to
    // `stop()`; the replacement session still needs its keyboard, so report it and load.
    const teardown = await stopCurrent().then(
      () => undefined,
      (error: unknown) => asError(error),
    );
    // A later start or stop supersedes this request while teardown is awaited.
    if (request !== mine || ctx.mode !== "tui") return;
    if (teardown !== undefined)
      ctx.ui.notify(`Previous Hunk review cleanup failed: ${teardown.message}`, "error");
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const loading: State = { _tag: "Loading", settled };
    state = loading;
    void loadConfig(bindings.configPath)
      .then((loaded) => {
        if (state !== loading) return;
        if (loaded._tag === "Broken") {
          state = { _tag: "Inactive" };
          ctx.ui.notify(
            `${loaded.message}\nHunk shortcuts are off until this file is fixed. Run /hunk config to review it and replace it on Save, or repair the file directly.`,
            "error",
          );
          return;
        }
        if (loaded.ignored.length > 0)
          ctx.ui.notify(
            `Hunk configuration at ${bindings.configPath} sets unknown field(s) ${loaded.ignored.join(", ")}; they are ignored and the known settings apply.`,
            "warning",
          );
        listen({ ctx, config: loaded.config });
      })
      .catch((error: unknown) => {
        if (state !== loading) return;
        state = { _tag: "Inactive" };
        ctx.ui.notify(`Hunk configuration failed: ${asError(error).message}`, "error");
      })
      .then(
        () => resolve(),
        () => resolve(),
      );
    await settled;
  }

  return {
    start,
    command: {
      description: "Configure Hunk review shortcuts and feedback delivery",
      getArgumentCompletions: (argumentPrefix: string) =>
        "config".startsWith(argumentPrefix)
          ? [{ value: "config", label: "config", description: "Configure Hunk" }]
          : null,
      handler: configure,
    },
    stop: () => {
      request = { _tag: "Stop" };
      hostClosing = true;
      return stopCurrent();
    },
    /** OMP restores the terminal after its shutdown handler, so it reports once `stop` settles. */
    announceAbandoned: flushAbandoned,
  };
}
