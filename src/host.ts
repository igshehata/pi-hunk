import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
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

type Chord = "Idle" | "Armed";
interface Session {
  readonly ctx: HostContext;
  readonly config: Config;
}
interface Operation {
  readonly cancel: AbortController;
  settled: Promise<void>;
  journal?: string;
  teardownError?: Error;
}
type State =
  | { readonly _tag: "Inactive" }
  | { readonly _tag: "Loading"; readonly operation: Operation }
  | { readonly _tag: "Configuring"; readonly operation: Operation }
  | {
      readonly _tag: "Listening";
      readonly session: Session;
      readonly unsubscribe: () => void;
      chord: Chord;
    }
  | { readonly _tag: "Reviewing"; readonly session: Session; readonly operation: Operation }
  | { readonly _tag: "Stopping"; readonly settled: Promise<void> };

type ChildExit =
  | {
      readonly _tag: "Closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly _tag: "SpawnError"; readonly error: Error };
interface OwnedChild {
  readonly process: ChildProcess;
  readonly closed: Promise<ChildExit>;
  state: { readonly _tag: "Running" } | { readonly _tag: "Closed" };
}

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

function processTable(): Map<number, ProcessIdentity> {
  if (process.platform === "win32") return new Map();
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,sess=,tty=,lstart=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
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

async function waitForProcesses(processes: ReadonlyMap<number, ProcessIdentity>): Promise<void> {
  if (processes.size === 0) return;
  const deadline = Date.now() + 2_000;
  for (;;) {
    let current: Map<number, ProcessIdentity>;
    try {
      current = processTable();
    } catch (error) {
      throw new HunkTeardownError("Cannot verify owned Hunk process termination", error);
    }
    const live = liveProcesses(processes, current);
    if (live.length === 0) return;
    if (Date.now() >= deadline) {
      throw new HunkTeardownError(
        "Owned Hunk processes did not exit: " + live.map((process) => process.pid).join(", "),
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function startChild(launch: ReviewLaunch, bridge: string): OwnedChild {
  const child = spawn("hunk", [launch.view, "--extension", bridge], {
    cwd: launch.cwd,
    env: { ...process.env, [REVIEW_ENV]: JSON.stringify(launch) },
    stdio: "inherit",
  });
  let spawnError: Error | undefined;
  const { promise, resolve } = Promise.withResolvers<ChildExit>();
  const owned: OwnedChild = { process: child, state: { _tag: "Running" }, closed: promise };
  child.once("error", (error) => {
    spawnError = error;
  });
  // `exit` precedes stdio closure; only `close` is the handoff boundary.
  child.once("close", (code, signal) => {
    owned.state = { _tag: "Closed" };
    resolve(
      spawnError ? { _tag: "SpawnError", error: spawnError } : { _tag: "Closed", code, signal },
    );
  });
  return owned;
}

function closeChild(child: OwnedChild): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (child.state._tag === "Closed") return;
    const rootPid = child.process.pid;
    if (rootPid === undefined) {
      signalChild(child.process, "SIGTERM");
      await child.closed;
      return;
    }

    const descendants = new Map<number, ProcessIdentity>();
    const terminated = new Set<number>();
    let root: ProcessIdentity | undefined;
    let failure: Error | undefined;
    let table: Map<number, ProcessIdentity> | undefined;
    const remember = (error: unknown) => {
      failure ??= asError(error);
    };
    const refresh = (): Map<number, ProcessIdentity> | undefined => {
      try {
        table = processTable();
        const currentRoot = table.get(rootPid);
        const capture = (anchorPid: number, expected: ProcessIdentity) => {
          if (!root) return;
          const currentAnchor = table!.get(anchorPid);
          if (
            !currentAnchor ||
            !sameProcess(expected, currentAnchor) ||
            !sameProcessGroup(root, currentAnchor)
          )
            return;
          for (const process of descendantsOf(anchorPid, table!, root)) {
            const known = descendants.get(process.pid);
            if (!known) descendants.set(process.pid, process);
            else if (!sameProcess(known, process)) terminated.add(process.pid);
          }
        };
        if (currentRoot && (root === undefined || sameProcess(root, currentRoot))) {
          root ??= currentRoot;
          capture(rootPid, currentRoot);
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
              capture(known.pid, known);
          }
        }
        return table;
      } catch (error) {
        table = undefined;
        remember(error);
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
    const sendRoot = (
      signal: NodeJS.Signals,
      current: Map<number, ProcessIdentity> | undefined,
    ) => {
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
    refresh();
    sendRoot("SIGSTOP", table);
    refresh();
    sendDescendants(table);

    let monitoring = true;
    let released = false;
    let closedAt: number | undefined;
    const startedAt = Date.now();
    const releaseRoot = (current: Map<number, ProcessIdentity>) => {
      if (released) return;
      released = true;
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
    const monitor = (async () => {
      while (monitoring) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        if (!monitoring) break;
        if (child.state._tag === "Closed") closedAt ??= Date.now();
        const current = refresh();
        sendDescendants(current);
        const live = current === undefined ? undefined : liveProcesses(descendants, current);
        if (
          !released &&
          child.state._tag === "Running" &&
          current !== undefined &&
          live !== undefined &&
          live.length === 0
        )
          releaseRoot(current);
        if (child.state._tag === "Closed") {
          if (live?.length === 0) break;
          if (closedAt !== undefined && Date.now() - closedAt >= 2_000) break;
        } else if (Date.now() - startedAt >= 2_000) {
          break;
        }
      }
    })().catch((error) => {
      remember(error);
    });
    try {
      await Promise.race([child.closed, monitor]);
      if (child.state._tag === "Running")
        throw new HunkTeardownError("Hunk process teardown did not settle", failure);
      await child.closed;
      await monitor;
      if (failure)
        throw new HunkTeardownError("Hunk process teardown could not be verified", failure);
      await waitForProcesses(descendants);
    } finally {
      monitoring = false;
      clearTimeout(escalation);
      await monitor;
    }
  });
}

/** One lifecycle shared by the native Pi and OMP entrypoints. */
export function createHost(bindings: HostBindings) {
  let state: State = { _tag: "Inactive" };
  let generation = 0;

  function stopCurrent(): Promise<void> {
    if (state._tag === "Stopping") return state.settled;
    if (state._tag === "Inactive") return Promise.resolve();
    if (state._tag === "Listening") {
      state.unsubscribe();
      state = { _tag: "Inactive" };
      return Promise.resolve();
    }
    const operation = state.operation;
    // Invalidate ownership before cancellation so a closing child cannot send.
    const stopping: State = {
      _tag: "Stopping",
      settled: operation.settled.then(() => {
        if (state === stopping) state = { _tag: "Inactive" };
        if (operation.teardownError) throw operation.teardownError;
      }),
    };
    state = stopping;
    operation.cancel.abort();
    return stopping.settled;
  }

  function listen(session: Session): void {
    const listening: Extract<State, { _tag: "Listening" }> = {
      _tag: "Listening",
      session,
      chord: "Idle",
      unsubscribe: session.ctx.ui.onTerminalInput((data) => {
        // No Effects, fibers, closures, or objects on ordinary inactive input.
        if (state !== listening || bindings.isKeyRelease(data)) return;
        if (listening.chord === "Idle") {
          if (!bindings.matchesKey(data, session.config.prefix)) return;
          listening.chord = "Armed";
          return consumed;
        }
        listening.chord = "Idle";
        if (bindings.matchesKey(data, "escape")) return consumed;
        const view = bindings.matchesKey(data, session.config.diff)
          ? "diff"
          : bindings.matchesKey(data, session.config.show)
            ? "show"
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
    const operation: Operation = { cancel: new AbortController(), settled: Promise.resolve() };
    const reviewing: State = { _tag: "Reviewing", session, operation };
    state = reviewing;
    const active = () => state === reviewing && !operation.cancel.signal.aborted;
    const program = Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => access(bindings.bridge), catch: asError });
      const directory = yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "pi-hunk-")),
        catch: asError,
      });
      operation.journal = join(directory, "notes.jsonl");
      yield* Effect.tryPromise({
        try: () => writeFile(operation.journal!, "", { mode: 0o600, flag: "wx" }),
        catch: asError,
      });
      const launchData: ReviewLaunch = {
        cwd: session.ctx.cwd,
        view,
        config: session.config,
        journal: operation.journal,
      };
      // The async factory does not mount a replacement editor. `done` closes it
      // after the scoped child and terminal have both finished restoring.
      const outcome = yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            session.ctx.ui.custom<Exit.Exit<ChildExit, Error>>(async (tui, _theme, _keys, done) => {
              const childProgram = Effect.scoped(
                Effect.gen(function* () {
                  yield* Effect.acquireRelease(Effect.succeed(tui), () =>
                    Effect.sync(() => {
                      tui.start();
                      tui.requestRender(true);
                    }),
                  );
                  yield* Effect.sync(() => {
                    tui.stop();
                  });
                  const child = yield* Effect.acquireRelease(
                    Effect.try({
                      try: () => startChild(launchData, bindings.bridge),
                      catch: asError,
                    }),
                    closeChild,
                  );
                  return yield* Effect.promise(() => child.closed);
                }),
              );
              const exit = await Effect.runPromiseExit(childProgram, {
                signal: operation.cancel.signal,
              });
              if (Exit.isFailure(exit)) {
                const error = Cause.squash(exit.cause);
                if (error instanceof HunkTeardownError) operation.teardownError = error;
              }
              done(exit);
              return emptyComponent;
            }),
          catch: asError,
        }),
      );
      if (Exit.isFailure(outcome)) {
        const error = Cause.squash(outcome.cause);
        if (error instanceof HunkTeardownError) operation.teardownError = error;
        if (!active()) return;
        return yield* Effect.fail(error);
      }
      if (!active()) return;
      const childExit = outcome.value;
      if (childExit._tag === "SpawnError") return yield* Effect.fail(childExit.error);
      if (childExit.code === CAPTURE_FAILURE_EXIT_CODE) {
        return yield* Effect.fail(
          new Error(
            "Hunk comment capture failed; the recovery journal may be incomplete and was not submitted.",
          ),
        );
      }
      const abnormal = childExit.code !== 0 || childExit.signal !== null;
      if (abnormal)
        session.ctx.ui.notify(
          `Hunk exited ${childExit.signal ?? `with code ${childExit.code}`}; saved comments will still be handed off. Recovery: ${operation.journal}`,
          "warning",
        );
      const notes = yield* readFeedback(operation.journal);
      if (!active()) return;
      if (notes.length === 0) {
        if (!abnormal)
          yield* Effect.tryPromise({
            try: () => rm(directory, { recursive: true }),
            catch: asError,
          });
        return;
      }
      if (!session.ctx.isIdle() && session.config.delivery === "interrupt") {
        // Native abort returns void. In particular Pi restores prior queues to
        // its composer; we neither await abort nor replace those native semantics.
        session.ctx.abort();
        while (!session.ctx.isIdle()) yield* Effect.sleep(20);
      }
      if (!active()) return;
      const message = formatFeedback(notes);
      if (session.ctx.isIdle()) bindings.sendUserMessage(message);
      else
        bindings.sendUserMessage(message, {
          deliverAs: session.config.delivery === "followUp" ? "followUp" : "steer",
        });
      // Native sendUserMessage returns void and hides asynchronous failures.
      // Retain recovery rather than treating call acceptance as a receipt.
    });
    operation.settled = Effect.runPromise(program, { signal: operation.cancel.signal })
      .catch((error: unknown) => {
        if (active())
          session.ctx.ui.notify(
            `Hunk review failed: ${asError(error).message}${operation.journal ? `\nRecovery: ${operation.journal}` : ""}`,
            "error",
          );
      })
      .finally(() => {
        if (active()) listen(session);
      });
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
    if (state._tag !== "Listening" && state._tag !== "Inactive") {
      ctx.ui.notify("Finish the current Hunk operation before configuring it.", "warning");
      return;
    }

    const previous = state._tag === "Listening" ? state.session : undefined;
    if (state._tag === "Listening") state.unsubscribe();
    const operation: Operation = { cancel: new AbortController(), settled: Promise.resolve() };
    const configuring: State = { _tag: "Configuring", operation };
    state = configuring;
    const active = () => state === configuring && !operation.cancel.signal.aborted;
    let saved: Config | undefined;

    operation.settled = Effect.runPromise(editConfig(bindings.configPath, ctx.ui), {
      signal: operation.cancel.signal,
    })
      .then((config) => {
        if (!active() || !config) return;
        saved = config;
        ctx.ui.notify(
          `Hunk configuration saved to ${bindings.configPath}. Changes are active.`,
          "info",
        );
      })
      .catch((error: unknown) => {
        if (active())
          ctx.ui.notify(`Hunk configuration failed: ${asError(error).message}`, "error");
      })
      .finally(() => {
        if (!active()) return;
        if (saved) listen({ ctx, config: saved });
        else if (previous) listen(previous);
        else state = { _tag: "Inactive" };
      });
    await operation.settled;
  }

  async function start(ctx: HostContext): Promise<void> {
    const request = ++generation;
    await stopCurrent();
    if (request !== generation || ctx.mode !== "tui") return;
    const operation: Operation = { cancel: new AbortController(), settled: Promise.resolve() };
    const loading: State = { _tag: "Loading", operation };
    state = loading;
    operation.settled = Effect.runPromise(loadConfig(bindings.configPath), {
      signal: operation.cancel.signal,
    })
      .then((config) => {
        if (state === loading) listen({ ctx, config });
      })
      .catch((error: unknown) => {
        if (state !== loading) return;
        state = { _tag: "Inactive" };
        ctx.ui.notify(`Hunk configuration failed: ${asError(error).message}`, "error");
      });
    await operation.settled;
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
      generation++;
      return stopCurrent();
    },
  };
}
