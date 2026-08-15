import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";
import { hasNative, spawn } from "zigpty";

export interface PtySubscription {
  dispose(): void;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface OverlayPty {
  /** OS pid of the spawned PTY leader when the backend exposes it. */
  readonly pid?: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  onData(listener: (data: string | Uint8Array) => void): PtySubscription;
  onExit(listener: (event: PtyExit) => void): PtySubscription;
  dispose(): void;
}

export interface SpawnPtyOptions {
  command: string;
  args: string[];
  cwd: string;
  columns: number;
  rows: number;
  env: Record<string, string>;
  /** Grace before escalating POSIX PTY shutdown to SIGKILL. Default: 500ms. */
  shutdownGraceMs?: number;
}

interface ZigPtyLike {
  readonly pid?: number;
  readonly exitCode?: number | null;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  close?(): void;
  onData(listener: (data: string | Uint8Array) => void): PtySubscription;
  onExit(listener: (event: { exitCode: number; signal: number }) => void): PtySubscription;
}

interface ZigPtyBackend {
  hasNative: boolean;
  spawn(command: string, args: string[], options: object): ZigPtyLike;
}

const backend: ZigPtyBackend = { hasNative, spawn };
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
// forkpty children briefly inherit the parent's group before setsid/login_tty.
// Keep the window short, but wide enough for loaded CI hosts and process probes.
const PROCESS_GROUP_CAPTURE_ATTEMPTS = 8;
const PROCESS_GROUP_CAPTURE_RETRY_MS = 5;
const PROCESS_GROUP_PROBE_TIMEOUT_MS = 100;

interface PosixProcessObservation {
  parentProcessId: number;
  processGroupId: number;
}

function startupFailure(message: string): Error {
  return new Error(`Hunk startup failed: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function childPath(options: SpawnPtyOptions): string | undefined {
  if (process.platform !== "win32") return options.env.PATH;
  for (const [key, value] of Object.entries(options.env)) {
    if (key.toLowerCase() === "path") return value;
  }
  return undefined;
}

function windowsExecutableExtensions(options: SpawnPtyOptions): string[] {
  let pathExt: string | undefined;
  for (const [key, value] of Object.entries(options.env)) {
    if (key.toLowerCase() === "pathext") pathExt = value;
  }
  return (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

function candidateVariants(candidate: string, options: SpawnPtyOptions): string[] {
  if (process.platform !== "win32") return [candidate];
  const extensions = windowsExecutableExtensions(options);
  if (extensions.includes(extname(candidate).toLowerCase())) return [candidate];
  return [candidate, ...extensions.map((extension) => candidate + extension)];
}

function inspectCommandCandidate(
  candidate: string,
  options: SpawnPtyOptions,
): "missing" | "executable" | "not-executable" {
  let stats;
  try {
    stats = statSync(candidate);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw startupFailure(
      `cannot inspect command ${JSON.stringify(candidate)} (${code ?? "unknown error"}).`,
    );
  }
  if (!stats.isFile()) return "not-executable";
  if (
    process.platform === "win32" &&
    extname(candidate) !== "" &&
    !windowsExecutableExtensions(options).includes(extname(candidate).toLowerCase())
  ) {
    return "not-executable";
  }
  try {
    accessSync(candidate, process.platform === "win32" ? fsConstants.R_OK : fsConstants.X_OK);
    return "executable";
  } catch {
    return "not-executable";
  }
}

/**
 * Diagnose deterministic launch failures before zigpty forks. The original
 * command and argv are still passed unchanged to the backend: this is lookup
 * validation only, never shell execution or command rewriting. A later backend
 * failure remains possible if the filesystem changes after this TOCTOU-prone
 * advisory check.
 */
function preflightOverlaySpawn(options: SpawnPtyOptions): void {
  const cwd = resolve(options.cwd);
  let cwdStats;
  try {
    cwdStats = statSync(cwd);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw startupFailure(`launch directory does not exist: ${cwd}.`);
    }
    throw startupFailure(`cannot inspect launch directory ${cwd} (${code ?? "unknown error"}).`);
  }
  if (!cwdStats.isDirectory()) {
    throw startupFailure(`launch directory is not a directory: ${cwd}.`);
  }
  try {
    accessSync(
      cwd,
      process.platform === "win32" ? fsConstants.R_OK : fsConstants.R_OK | fsConstants.X_OK,
    );
  } catch {
    throw startupFailure(`launch directory is not accessible: ${cwd}.`);
  }

  const command = options.command;
  if (!command) throw startupFailure("command is empty.");
  const hasPathSeparator =
    command.includes("/") || (process.platform === "win32" && command.includes("\\"));
  const explicit = isAbsolute(command) || hasPathSeparator;
  const bases = explicit
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (childPath(options)?.split(delimiter) ?? []).map((entry) =>
        entry.length === 0
          ? resolve(cwd, command)
          : isAbsolute(entry)
            ? resolve(entry, command)
            : resolve(cwd, entry, command),
      );

  let nonExecutable: string | undefined;
  for (const base of bases) {
    for (const candidate of candidateVariants(base, options)) {
      const inspection = inspectCommandCandidate(candidate, options);
      if (inspection === "executable") return;
      if (inspection === "not-executable" && nonExecutable === undefined) {
        nonExecutable = candidate;
      }
    }
  }

  if (nonExecutable) {
    throw startupFailure(`command is not executable: ${nonExecutable}.`);
  }
  if (explicit) {
    throw startupFailure(`command does not exist: ${bases[0]}.`);
  }
  const path = childPath(options);
  if (path === undefined) {
    throw startupFailure(
      `command ${JSON.stringify(command)} cannot be resolved because PATH is not set in the child environment.`,
    );
  }
  throw startupFailure(`command ${JSON.stringify(command)} was not found on child PATH.`);
}

function validPosixProcessObservation(
  parentProcessId: number,
  processGroupId: number,
): PosixProcessObservation | undefined {
  if (
    !Number.isInteger(parentProcessId) ||
    parentProcessId <= 0 ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return undefined;
  }
  return { parentProcessId, processGroupId };
}

/**
 * Linux exposes ppid/pgrp without an external executable. Besides working in
 * minimal images without ps, this avoids process-spawn latency for leaders that
 * exit soon after forkpty returns. The final `)` is the only stable separator:
 * Linux comm values may contain spaces and closing parentheses.
 */
function observeLinuxProcProcess(pid: number): PosixProcessObservation | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // Fields after comm are: state (3), ppid (4), pgrp (5), ...
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    if (fields.length < 3) return undefined;
    return validPosixProcessObservation(Number(fields[1]), Number(fields[2]));
  } catch {
    return undefined;
  }
}

function observePosixProcess(pid: number): PosixProcessObservation | undefined {
  if (process.platform === "linux") {
    const procObservation = observeLinuxProcProcess(pid);
    if (procObservation) return procObservation;
  }

  try {
    // Supported targets install ps at /bin/ps. Do not depend on Pi's PATH:
    // child launch configuration or minimal parent environments may omit it.
    const result = spawnSync("/bin/ps", ["-o", "ppid=,pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PROCESS_GROUP_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0) return undefined;
    const fields = result.stdout.trim().split(/\s+/);
    if (fields.length !== 2) return undefined;
    return validPosixProcessObservation(Number(fields[0]), Number(fields[1]));
  } catch {
    return undefined;
  }
}

function pauseForProcessGroupRetry(durationMs: number): void {
  try {
    const waiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(waiter, 0, 0, durationMs);
  } catch {
    // If synchronous waiting is unavailable, retry immediately rather than
    // turning optional group capture into a post-spawn initialization failure.
  }
}

function posixProcessAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

/** @internal Exported only for deterministic ownership-probe regression tests. */
export function __captureOwnedPosixProcessGroupFromProbe(
  pid: number,
  expectedParentProcessId: number,
  probe: () => PosixProcessObservation | undefined,
  pause: (durationMs: number) => void,
  isAlive: (pid: number) => boolean = posixProcessAppearsAlive,
): number | undefined {
  for (let attempt = 0; attempt < PROCESS_GROUP_CAPTURE_ATTEMPTS; attempt += 1) {
    const observation = probe();
    if (observation) {
      // A changed parent may mean the pid exited and was reused. Never continue
      // probing, let alone authorize negative-pid signalling.
      if (observation.parentProcessId !== expectedParentProcessId) return undefined;
      if (observation.processGroupId === pid) return pid;
      // Still our child, but still in the inherited group: retry.
    } else if (!isAlive(pid)) {
      // Probe failure with a dead pid: stop. Inferring pgid === pid after the
      // leader disappeared would authorize an unsafe blind negative-PID signal;
      // there is no longer a parent/group observation that proves ownership.
      return undefined;
    }

    // Retry while the forkpty child is still ours and either has not become
    // the terminal process-group leader yet or the ownership probe failed.
    if (attempt + 1 < PROCESS_GROUP_CAPTURE_ATTEMPTS) pause(PROCESS_GROUP_CAPTURE_RETRY_MS);
  }
  return undefined;
}

/**
 * zigpty's native Unix backend uses forkpty and exposes only the child pid. A
 * forkpty child becomes the leader of its fresh terminal process group, but
 * the parent can briefly run before the child's setsid/login_tty setup. Probe
 * that transition a few times while every observation still proves the child
 * belongs to this Node process. Fake/unsupported backends and platforms safely
 * retain leader-only backend signalling.
 */
function captureOwnedPosixProcessGroup(pid: number | undefined): number | undefined {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    pid === undefined ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return undefined;
  }

  return __captureOwnedPosixProcessGroupFromProbe(
    pid,
    process.pid,
    () => observePosixProcess(pid),
    pauseForProcessGroupRetry,
  );
}

function signalOwnedPosixProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The complete group may have exited immediately before the signal.
  }
}

function ownedPosixProcessGroupIsAlive(processGroupId: number | undefined): boolean {
  if (processGroupId === undefined) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM still proves the group exists; it does not authorize signalling it.
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

/** Spawn only a real PTY: PipePty cannot correctly host the interactive overlay. */
export function spawnOverlayPty(
  options: SpawnPtyOptions,
  implementation: ZigPtyBackend = backend,
): OverlayPty {
  if (!implementation.hasNative) {
    throw new Error(
      "Hunk overlay requires zigpty native PTY bindings, but none are available for this platform/architecture. Install pi-hunk on a supported macOS/Linux target, or review zigpty platform support and build prerequisites.",
    );
  }

  preflightOverlaySpawn(options);

  const pty = implementation.spawn(options.command, options.args, {
    name: "xterm-256color",
    cols: options.columns,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    // Ghostty is the terminal decoder. Keep ZigPTY from decoding or replacing
    // bytes before the VT stream reaches it.
    encoding: null,
  });

  const pid = pty.pid;
  // Only the installed native zigpty backend carries the forkpty ownership
  // invariant. Injectable/fake backends may expose arbitrary pids and must
  // never authorize process-group signalling.
  const canOwnProcessGroup = implementation === backend;
  let ownedProcessGroup = canOwnProcessGroup ? captureOwnedPosixProcessGroup(pid) : undefined;
  const shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  const exitListeners = new Set<{
    active: boolean;
    listener: (event: PtyExit) => void;
  }>();
  let disposed = false;
  let exited = false;
  let exitEvent: PtyExit | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;

  const backendHasExited = () => exited || (pty.exitCode !== undefined && pty.exitCode !== null);
  // Dispose often runs long after the forkpty setsid race. If spawn-time capture
  // failed, re-probe once before signalling so descendants still get group kills.
  const resolveOwnedProcessGroup = (): number | undefined => {
    if (ownedProcessGroup !== undefined || !canOwnProcessGroup) return ownedProcessGroup;
    ownedProcessGroup = captureOwnedPosixProcessGroup(pid);
    return ownedProcessGroup;
  };
  const clearEscalation = () => {
    if (!escalationTimer) return;
    clearTimeout(escalationTimer);
    escalationTimer = undefined;
  };
  const notifyExitListener = (
    subscription: { active: boolean; listener: (event: PtyExit) => void },
    event: PtyExit,
  ) => {
    if (!subscription.active) return;
    try {
      subscription.listener(event);
    } catch {
      // Listener failures must not block other listeners or shutdown cleanup.
    }
  };
  const markExited = (event: PtyExit) => {
    if (exited) return;
    const settled: PtyExit =
      event.signal === undefined
        ? { exitCode: event.exitCode }
        : { exitCode: event.exitCode, signal: event.signal };
    exited = true;
    exitEvent = settled;
    // The leader exit does not imply its process group is empty. Keep an
    // already-armed escalation alive while owned descendants remain.
    if (!disposed || !ownedPosixProcessGroupIsAlive(ownedProcessGroup)) clearEscalation();
    const listeners = [...exitListeners];
    exitListeners.clear();
    for (const listener of listeners) notifyExitListener(listener, settled);
  };
  try {
    pty.onExit(markExited);
    const reconciledExitCode = pty.exitCode;
    if (reconciledExitCode !== undefined && reconciledExitCode !== null) {
      markExited({ exitCode: reconciledExitCode, signal: 0 });
    }
  } catch (error) {
    // spawn() already transferred ownership to us. If listener setup fails,
    // no adapter is returned to dispose it later, so cleanup must be immediate.
    const group = resolveOwnedProcessGroup();
    if (group !== undefined) {
      signalOwnedPosixProcessGroup(group, "SIGKILL");
    } else {
      try {
        pty.kill("SIGKILL");
      } catch {
        // Best effort: the process may already have exited.
      }
    }
    try {
      pty.close?.();
    } catch {
      // Backend cleanup must not hide the initialization error.
    }
    throw error;
  }

  const forceClose = () => {
    escalationTimer = undefined;
    const group = resolveOwnedProcessGroup();
    const groupAlive = ownedPosixProcessGroupIsAlive(group);
    if (!groupAlive && backendHasExited()) return;
    if (groupAlive && group !== undefined) {
      // A process-group ID cannot be reused while any member of that group
      // remains, so the captured leader-owned group still identifies only this
      // PTY tree even when the leader itself exited during the TERM window.
      signalOwnedPosixProcessGroup(group, "SIGKILL");
    } else {
      try {
        pty.kill("SIGKILL");
      } catch {
        // Process may have exited between the liveness check and the signal.
      }
    }
    // Do not call close() after signalling. zigpty's Unix exit callback destroys
    // its ReadStream (which owns/closes the master fd) without setting the
    // backend's private `_closed` flag; a later closeSync on that same fd emits
    // a process warning and can race fd reuse. SIGKILL guarantees the owned
    // leader/group exit callback will perform backend descriptor cleanup.
  };

  const armEscalation = () => {
    if (shutdownGraceMs <= 0) {
      forceClose();
      return;
    }
    escalationTimer = setTimeout(forceClose, shutdownGraceMs);
    escalationTimer.unref?.();
  };

  return {
    pid: pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined,
    write: (data) => pty.write(data),
    resize: (columns, rows) => pty.resize(columns, rows),
    onData: (listener) =>
      pty.onData((data) => {
        // Buffer is a Uint8Array subclass. Preserve its exact view rather than
        // decoding/re-encoding bytes; libghostty accepts Uint8Array chunks.
        listener(
          typeof data === "string"
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      }),
    onExit: (listener) => {
      const subscription = { active: true, listener };
      const settledExit = exitEvent;
      if (settledExit) {
        queueMicrotask(() => notifyExitListener(subscription, settledExit));
      } else {
        exitListeners.add(subscription);
      }
      return {
        dispose: () => {
          subscription.active = false;
          exitListeners.delete(subscription);
        },
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const group = resolveOwnedProcessGroup();
      const groupAlive = ownedPosixProcessGroupIsAlive(group);
      if (backendHasExited() && !groupAlive) return;
      // Preserve Windows' previous default-kill behavior. A verified native
      // POSIX PTY group gets the bounded TERM→KILL sequence as one owned unit;
      // unsupported/fake backends safely retain leader-only signalling.
      if (process.platform === "win32") {
        pty.kill();
        return;
      }
      if (groupAlive && group !== undefined) {
        signalOwnedPosixProcessGroup(group, "SIGTERM");
      } else {
        try {
          pty.kill("SIGTERM");
        } catch {
          if (backendHasExited()) return;
        }
      }
      if (ownedPosixProcessGroupIsAlive(group) || !backendHasExited()) armEscalation();
    },
  };
}
