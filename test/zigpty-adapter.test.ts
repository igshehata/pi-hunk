import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedHunk, type HunkExit } from "../extensions/overlay/embedded.ts";
import {
  __captureOwnedPosixProcessGroupFromProbe,
  spawnOverlayPty,
} from "../extensions/overlay/pty.ts";

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

async function waitForFileContent(path: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`file ${path} was not created by PTY child`);
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} survived PTY disposal`);
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
  describe("native process-group ownership capture", () => {
    const pid = 4321;
    const parentProcessId = 1234;
    const inheritedGroup = 999;

    it("retries an owned child from its inherited group to its leader group", () => {
      const observations = [
        { parentProcessId, processGroupId: inheritedGroup },
        { parentProcessId, processGroupId: pid },
      ];
      const probe = vi.fn(() => observations.shift());
      const pause = vi.fn();

      expect(__captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause)).toBe(
        pid,
      );
      expect(probe).toHaveBeenCalledTimes(2);
      expect(pause).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledWith(5);
    });

    it("bounds retries while the owned child remains in its inherited group", () => {
      const probe = vi.fn(() => ({ parentProcessId, processGroupId: inheritedGroup }));
      const pause = vi.fn();

      expect(
        __captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause),
      ).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(8);
      expect(pause).toHaveBeenCalledTimes(7);
      expect(pause).toHaveBeenNthCalledWith(1, 5);
      expect(pause).toHaveBeenNthCalledWith(7, 5);
    });

    it("retries transient probe failures while the owned child is still alive", () => {
      const observations = [undefined, { parentProcessId, processGroupId: pid }];
      const probe = vi.fn(() => observations.shift());
      const pause = vi.fn();
      const isAlive = vi.fn(() => true);

      expect(
        __captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause, isAlive),
      ).toBe(pid);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(isAlive).toHaveBeenCalledWith(pid);
      expect(pause).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledWith(5);
    });

    it("refuses blind group authorization when a fast leader exits before the first probe", () => {
      const probe = vi.fn(() => undefined);
      const pause = vi.fn();
      const isAlive = vi.fn(() => false);

      expect(
        __captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause, isAlive),
      ).toBeUndefined();
      expect(probe).toHaveBeenCalledOnce();
      expect(isAlive).toHaveBeenCalledWith(pid);
      expect(pause).not.toHaveBeenCalled();
    });

    it("stops without authorization when the owned child disappears during retry", () => {
      const observations = [{ parentProcessId, processGroupId: inheritedGroup }, undefined];
      const probe = vi.fn(() => observations.shift());
      const pause = vi.fn();
      const isAlive = vi.fn(() => false);

      expect(
        __captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause, isAlive),
      ).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(2);
      expect(isAlive).toHaveBeenCalledWith(pid);
      expect(pause).toHaveBeenCalledOnce();
    });

    it("stops without authorization when the observed pid is no longer owned", () => {
      const observations = [
        { parentProcessId, processGroupId: inheritedGroup },
        { parentProcessId: parentProcessId + 1, processGroupId: pid },
        { parentProcessId, processGroupId: pid },
      ];
      const probe = vi.fn(() => observations.shift());
      const pause = vi.fn();

      expect(
        __captureOwnedPosixProcessGroupFromProbe(pid, parentProcessId, probe, pause),
      ).toBeUndefined();
      expect(probe).toHaveBeenCalledTimes(2);
      expect(pause).toHaveBeenCalledOnce();
    });
  });

  it("fails actionably before spawn when native bindings are unavailable", () => {
    const { backend } = fakeBackend({ hasNative: false });
    expect(() => spawnOverlayPty(options, backend)).toThrow(
      /requires zigpty native PTY bindings.*supported macOS\/Linux/i,
    );
    expect(backend.spawn).not.toHaveBeenCalled();
  });

  it("diagnoses a missing PATH command before a PID/code-1 backend can obscure it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-missing-command-"));
    const { backend } = fakeBackend();
    try {
      expect(() =>
        spawnOverlayPty(
          { ...options, command: "definitely-missing-hunk", env: { PATH: root } },
          backend,
        ),
      ).toThrow(
        /Hunk startup failed: command "definitely-missing-hunk" was not found on child PATH/i,
      );
      expect(backend.spawn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "diagnoses a non-executable relative command before backend spawn",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-non-executable-"));
      const command = join(root, "hunk-no-exec");
      const { backend } = fakeBackend();
      try {
        await writeFile(command, "not executable\n");
        await chmod(command, 0o644);
        expect(() =>
          spawnOverlayPty({ ...options, command: "./hunk-no-exec", cwd: root }, backend),
        ).toThrow(new RegExp(`Hunk startup failed: command is not executable:.*hunk-no-exec`, "i"));
        expect(backend.spawn).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("diagnoses a deleted launch directory before backend spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-deleted-cwd-"));
    await rm(root, { recursive: true, force: true });
    const { backend } = fakeBackend();

    expect(() => spawnOverlayPty({ ...options, cwd: root }, backend)).toThrow(
      /Hunk startup failed: launch directory does not exist:/i,
    );
    expect(backend.spawn).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "resolves relative child PATH entries without rewriting command or argv",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-relative-path-"));
      const command = join(root, "hunk-test");
      const { backend } = fakeBackend();
      try {
        await writeFile(command, "#!/bin/sh\nexit 0\n");
        await chmod(command, 0o755);
        const adapter = spawnOverlayPty(
          {
            ...options,
            command: "hunk-test",
            args: ["--literal", "a b"],
            cwd: root,
            env: { PATH: "." },
          },
          backend,
        );
        expect(backend.spawn).toHaveBeenCalledWith(
          "hunk-test",
          ["--literal", "a b"],
          expect.objectContaining({ cwd: root, env: { PATH: "." } }),
        );
        adapter.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
      expect(pty.close).not.toHaveBeenCalled();
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
      const barrierDirectory = await mkdtemp(join(tmpdir(), "pi-hunk-zigpty-ready-"));
      const barrier = join(barrierDirectory, "start");
      try {
        const pty = spawnOverlayPty({
          ...options,
          args: [
            "-c",
            "while [ ! -f \"$1\" ]; do sleep 0.01; done; test -t 0 && printf 'isatty=yes\\n'; stty size; trap 'stty size; exit 0' WINCH; printf 'trap-ready\\n'; while :; do sleep 0.1; done",
            "pi-hunk-zigpty-test",
            barrier,
          ],
        });
        let output = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let dataSubscription: { dispose(): void } | undefined;
        try {
          const resized = new Promise<void>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`native PTY output timed out: ${JSON.stringify(output)}`)),
              8000,
            );
            let resizeSent = false;
            dataSubscription = pty.onData((chunk) => {
              output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
              if (!resizeSent && /24 80[\s\S]*trap-ready/.test(output)) {
                resizeSent = true;
                queueMicrotask(() => pty.resize(101, 37));
              }
              if (resizeSent && /37 101/.test(output)) {
                clearTimeout(timer);
                timer = undefined;
                resolve();
              }
            });
          });
          // Release the child only after the data listener is attached, so
          // the initial dimensions cannot be emitted into a subscription gap.
          await writeFile(barrier, "");
          await resized;
          expect(output).toContain("isatty=yes");
          expect(output).toMatch(/24 80/);
          expect(output).toMatch(/37 101/);
        } finally {
          if (timer) clearTimeout(timer);
          dataSubscription?.dispose();
          pty.dispose();
        }
      } finally {
        await rm(barrierDirectory, { recursive: true, force: true });
      }
    }, 10_000);

    it("cleans a TERM/HUP-immune descendant after EmbeddedHunk's leader exits naturally", async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-natural-leader-exit-"));
      const childPidFile = join(root, "child-pid");
      const childReadyFile = join(root, "child-ready");
      const leaderExitBarrier = join(root, "leader-exit");
      const originalPath = process.env.PATH;
      let component: EmbeddedHunk | undefined;
      let leaderPid: number | undefined;
      let childPid: number | undefined;
      try {
        // Ownership capture must not depend on PATH lookup for ps. Linux uses
        // /proc directly; supported non-Linux POSIX targets use /bin/ps.
        process.env.PATH = "";
        const completed = new Promise<HunkExit>((resolve) => {
          const tui = {
            terminal: { columns: 80, rows: 24, write: vi.fn() },
            requestRender: vi.fn(),
          } as unknown as TUI;
          component = new EmbeddedHunk({
            command: "/bin/sh",
            args: [
              "-c",
              'trap "" TERM HUP; ' +
                '/bin/sh -c \'trap "" TERM HUP; printf "%s\\n" "$$" > "$1"; : > "$2"; while :; do /bin/sleep 1; done\' descendant "$1" "$2" & ' +
                'while [ ! -f "$2" ]; do /bin/sleep 0.01; done; ' +
                'while [ ! -f "$3" ]; do /bin/sleep 0.01; done; exit 0',
              "pi-hunk-natural-exit",
              childPidFile,
              childReadyFile,
              leaderExitBarrier,
            ],
            cwd: root,
            tui,
            done: resolve,
            startupFrameDeadlineMs: 10_000,
          });
        });
        leaderPid = component!.pid;
        childPid = Number((await waitForFileContent(childPidFile)).trim());
        expect(leaderPid).toBeGreaterThan(0);
        expect(childPid).toBeGreaterThan(0);

        await writeFile(leaderExitBarrier, "");
        const event = await withTimeout(completed, "natural PTY leader exit timed out");
        expect(event.exitCode).toBe(0);
        await Promise.all([waitForProcessExit(leaderPid!), waitForProcessExit(childPid!)]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        component?.dispose();
        // Keep failure cleanup bounded without ever group-signalling an
        // unverified pid: these are exact pids created and observed by the test.
        for (const pid of [childPid, leaderPid]) {
          if (!pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 10_000);

    it("force-cleans a TERM/HUP-immune PTY leader and descendant", async () => {
      const pty = spawnOverlayPty({
        ...options,
        args: [
          "-c",
          "trap '' TERM HUP; /bin/sh -c \"trap '' TERM HUP; while :; do sleep 1; done\" & child=$!; printf 'leader=%s child=%s ready\\n' \"$$\" \"$child\"; while :; do sleep 1; done",
        ],
        shutdownGraceMs: 100,
      });
      let output = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dataSubscription: { dispose(): void } | undefined;
      let exitSubscription: { dispose(): void } | undefined;
      let leaderPid: number | undefined;
      let childPid: number | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`native PTY ready timed out: ${JSON.stringify(output)}`)),
            5000,
          );
          dataSubscription = pty.onData((chunk) => {
            output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            const ready = /leader=(\d+) child=(\d+) ready/.exec(output);
            if (ready) {
              leaderPid = Number(ready[1]);
              childPid = Number(ready[2]);
              clearTimeout(timer);
              timer = undefined;
              resolve();
            }
          });
        });
        expect(leaderPid).toBe(pty.pid);
        expect(childPid).toBeGreaterThan(0);

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
        await Promise.all([waitForProcessExit(leaderPid!), waitForProcessExit(childPid!)]);
      } finally {
        if (timer) clearTimeout(timer);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        pty.dispose();
        // Keep failure cleanup bounded even if the regression is reintroduced.
        for (const pid of [childPid, leaderPid]) {
          if (!pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }, 10_000);
  },
);
