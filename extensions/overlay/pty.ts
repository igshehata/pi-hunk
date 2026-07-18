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
    clearEscalation();
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
    try {
      pty.kill("SIGKILL");
    } catch {
      // Best effort: the process may already have exited.
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
    if (backendHasExited()) return;
    try {
      pty.kill("SIGKILL");
    } catch {
      // Process may have exited between the liveness check and the signal.
    }
    try {
      pty.close?.();
    } catch {
      // Backend may already be closed.
    }
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
      if (backendHasExited()) return;
      // Preserve Windows' previous default-kill behavior; POSIX gets a bounded
      // graceful SIGTERM window before a backend close/SIGKILL escalation.
      if (process.platform === "win32") {
        pty.kill();
        return;
      }
      try {
        pty.kill("SIGTERM");
      } catch {
        if (backendHasExited()) return;
      }
      if (!backendHasExited()) armEscalation();
    },
  };
}
