import { describe, expect, it, vi } from "vitest";
import { spawnOverlayPty } from "../extensions/overlay/pty.ts";

function fakeBackend(overrides: Record<string, unknown> = {}) {
  const pty = {
    pid: 1234,
    exitCode: null as number | null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    close: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((_handler: (event: { exitCode: number; signal: number }) => void) => ({
      dispose: vi.fn(),
    })),
  };
  return {
    pty,
    backend: { hasNative: true, spawn: vi.fn(() => pty), ...overrides },
  };
}

const options = {
  command: "/bin/sh",
  args: [] as string[],
  cwd: process.cwd(),
  columns: 80,
  rows: 24,
  env: { ...process.env } as Record<string, string>,
};

describe("zigpty overlay adapter", () => {
  it("fails actionably before spawn when native bindings are unavailable", () => {
    const { backend } = fakeBackend({ hasNative: false });
    expect(() => spawnOverlayPty(options, backend)).toThrow(
      /requires zigpty native PTY bindings.*supported macOS\/Linux/i,
    );
    expect(backend.spawn).not.toHaveBeenCalled();
  });

  it("force-cleans a spawned PTY when exit-listener setup fails", () => {
    const { backend, pty } = fakeBackend();
    pty.onExit.mockImplementation(() => {
      throw new Error("exit subscription failed");
    });

    expect(() => spawnOverlayPty(options, backend)).toThrow("exit subscription failed");
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    expect(pty.close).toHaveBeenCalledOnce();
  });

  it("requests raw PTY output so Ghostty receives the original byte stream", () => {
    const { backend } = fakeBackend();
    const adapter = spawnOverlayPty(options, backend);

    expect(backend.spawn).toHaveBeenCalledWith(
      options.command,
      options.args,
      expect.objectContaining({ encoding: null }),
    );
    adapter.dispose();
  });

  it("preserves exact byte views and delegates lifecycle operations", () => {
    const { backend, pty } = fakeBackend();
    let dataHandler: ((data: string | Uint8Array) => void) | undefined;
    pty.onData.mockImplementation((handler) => {
      dataHandler = handler;
      return { dispose: vi.fn() };
    });
    const adapter = spawnOverlayPty(options, backend);
    expect(adapter.pid).toBe(1234);
    const received: Array<string | Uint8Array> = [];
    adapter.onData((chunk) => received.push(chunk));
    const backing = Buffer.from([0, 0xe2, 0x82, 0xac, 0]);
    dataHandler?.(backing.subarray(1, 4));
    dataHandler?.("text");
    expect([...(received[0] as Uint8Array)]).toEqual([0xe2, 0x82, 0xac]);
    expect(received[1]).toBe("text");
    adapter.write("x");
    adapter.resize(100, 30);
    adapter.dispose();
    expect(pty.write).toHaveBeenCalledWith("x");
    expect(pty.resize).toHaveBeenCalledWith(100, 30);
    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("replays backend exitCode races after backend exit subscription", async () => {
    const { backend, pty } = fakeBackend();
    pty.onExit.mockImplementation((_handler) => {
      pty.exitCode = 7;
      return { dispose: vi.fn() };
    });

    const adapter = spawnOverlayPty(options, backend);
    const listener = vi.fn();
    adapter.onExit(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ exitCode: 7, signal: 0 });
  });

  it("preserves the backend exit signal when reconciling an immediate exit", async () => {
    const { backend, pty } = fakeBackend();
    pty.onExit.mockImplementation((handler) => {
      pty.exitCode = 130;
      handler({ exitCode: 130, signal: 2 });
      return { dispose: vi.fn() };
    });

    const adapter = spawnOverlayPty(options, backend);
    const listener = vi.fn();
    adapter.onExit(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ exitCode: 130, signal: 2 });
  });

  it("skips queued exit replay after listener disposal", async () => {
    const { backend, pty } = fakeBackend();
    pty.exitCode = 0;
    const adapter = spawnOverlayPty(options, backend);
    const listener = vi.fn();

    const subscription = adapter.onExit(listener);
    subscription.dispose();
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });

  it("escalates POSIX shutdown after a bounded grace period", async () => {
    vi.useFakeTimers();
    try {
      const { backend, pty } = fakeBackend();
      const adapter = spawnOverlayPty({ ...options, shutdownGraceMs: 50 }, backend);

      adapter.dispose();
      adapter.dispose();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(49);
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(pty.kill).toHaveBeenCalledTimes(2);
      expect(pty.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(pty.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-kill when exit arrives during the graceful shutdown window", async () => {
    vi.useFakeTimers();
    try {
      const { backend, pty } = fakeBackend();
      let exitHandler: ((event: { exitCode: number; signal: number }) => void) | undefined;
      pty.onExit.mockImplementation((handler) => {
        exitHandler = handler;
        return { dispose: vi.fn() };
      });
      const adapter = spawnOverlayPty({ ...options, shutdownGraceMs: 50 }, backend);
      adapter.onExit(() => {
        throw new Error("listener failed");
      });
      const exitListener = vi.fn();
      adapter.onExit(exitListener);

      adapter.dispose();
      expect(() => exitHandler?.({ exitCode: 0, signal: 0 })).not.toThrow();
      await vi.advanceTimersByTimeAsync(50);

      expect(exitListener).toHaveBeenCalledWith({ exitCode: 0, signal: 0 });
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pty.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks backend exit state before force-killing at the end of grace", async () => {
    vi.useFakeTimers();
    try {
      const { backend, pty } = fakeBackend();
      const adapter = spawnOverlayPty({ ...options, shutdownGraceMs: 50 }, backend);

      adapter.dispose();
      pty.exitCode = 0;
      await vi.advanceTimersByTimeAsync(50);

      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pty.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")(
  "zigpty native PTY",
  () => {
    it("provides a TTY and propagates resize dimensions", async () => {
      const pty = spawnOverlayPty({
        ...options,
        args: [
          "-c",
          "test -t 0 && printf 'isatty=yes\\n'; stty size; trap 'stty size; exit 0' WINCH; while :; do sleep 1; done",
        ],
      });
      let output = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dataSubscription: { dispose(): void } | undefined;
      try {
        const resized = new Promise<void>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`native PTY output timed out: ${JSON.stringify(output)}`)),
            5000,
          );
          dataSubscription = pty.onData((chunk) => {
            output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            if (/37 101/.test(output)) {
              clearTimeout(timer);
              timer = undefined;
              resolve();
            }
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        pty.resize(101, 37);
        await resized;
        expect(output).toContain("isatty=yes");
        expect(output).toMatch(/24 80/);
        expect(output).toMatch(/37 101/);
      } finally {
        if (timer) clearTimeout(timer);
        dataSubscription?.dispose();
        pty.dispose();
      }
    });

    it("force-cleans a real PTY that ignores graceful termination", async () => {
      const pty = spawnOverlayPty({
        ...options,
        args: ["-c", "trap '' TERM; printf ready; while :; do sleep 1; done"],
        shutdownGraceMs: 100,
      });
      let output = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dataSubscription: { dispose(): void } | undefined;
      let exitSubscription: { dispose(): void } | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`native PTY ready timed out: ${JSON.stringify(output)}`)),
            5000,
          );
          dataSubscription = pty.onData((chunk) => {
            output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            if (output.includes("ready")) {
              clearTimeout(timer);
              timer = undefined;
              resolve();
            }
          });
        });

        const exited = new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("native PTY did not exit after dispose")),
            5000,
          );
          exitSubscription = pty.onExit(resolve);
        });
        pty.dispose();
        const event = await exited;
        if (timer) clearTimeout(timer);
        timer = undefined;
        expect(event.exitCode !== 0 || (event.signal ?? 0) !== 0).toBe(true);
      } finally {
        if (timer) clearTimeout(timer);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        pty.dispose();
      }
    });
  },
);
