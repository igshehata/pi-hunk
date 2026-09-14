import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { createHost, type HostContext } from "../src/host.js";

interface TestTui {
  start(): void;
  stop(): void;
  requestRender(force?: boolean): void;
}
interface TestComponent {
  render(width: number): string[];
  invalidate(): void;
}
type CustomFactory<T> = (
  tui: TestTui,
  theme: unknown,
  keys: unknown,
  done: (value: T) => void,
) => TestComponent | Promise<TestComponent>;
interface NativeRecord {
  readonly pid: number;
  readonly ppid: number;
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 1) return;
  const deadline = Date.now() + 4_000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error("Fixture process did not exit: " + pid);
    await delay(20);
  }
}

async function readNative(path: string): Promise<NativeRecord | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as NativeRecord;
  } catch {
    return undefined;
  }
}

async function waitForNative(path: string, signal: AbortSignal): Promise<NativeRecord> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  for (;;) {
    bounded.throwIfAborted();
    const record = await readNative(path);
    if (record) return record;
    await delay(20, undefined, { signal: bounded });
  }
}

async function fixture(): Promise<{
  directory: string;
  native: string;
  launcher: string;
  nativePid: string;
  launcherPid: string;
  latePid: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hunk-tree-test-"));
  const native = join(directory, "native.mjs");
  const launcher = join(directory, "hunk");
  const nativePid = join(directory, "native.pid");
  const launcherPid = join(directory, "launcher.pid");
  const latePid = join(directory, "late.pid");
  await writeFile(
    native,
    `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_HUNK_TEST_NATIVE_PID, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
process.on("SIGTERM", () => {
  // The launcher exits before this child appears; ownership must survive that gap.
  setTimeout(() => {
    const late = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "inherit" });
    writeFileSync(process.env.PI_HUNK_TEST_LATE_PID, String(late.pid));
  }, 120);
});
process.stdin.resume();
`,
    { mode: 0o755 },
  );
  await writeFile(
    launcher,
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") {
  process.stdout.write("0.22.0\\n");
  process.exit(0);
}
writeFileSync(process.env.PI_HUNK_TEST_LAUNCHER_PID, String(process.pid));
const result = spawnSync(process.env.PI_HUNK_TEST_NATIVE, process.argv.slice(2), { stdio: "inherit", env: process.env });
process.exit(typeof result.status === "number" ? result.status : 1);
`,
    { mode: 0o755 },
  );
  return { directory, native, launcher, nativePid, launcherPid, latePid };
}

function context(
  onInput: (handler: (data: string) => { consume?: boolean } | undefined) => void,
  events: string[],
  beforeFactory: () => Promise<void> = async () => {},
): HostContext {
  const tui = {
    start: () => events.push("terminal-start"),
    stop: () => events.push("terminal-stop"),
    requestRender: () => {},
  };
  const ui: HostContext["ui"] = {
    select: async () => undefined,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: (handler) => {
      onInput(handler);
      return () => {};
    },
    custom: async <T>(factory: CustomFactory<T>) => {
      await beforeFactory();
      let result: T | undefined;
      await factory(tui, {}, {}, (value) => {
        result = value;
      });
      if (result === undefined) throw new Error("test custom view did not settle");
      return result;
    },
  };
  return {
    mode: "tui",
    cwd: process.cwd(),
    isIdle: () => true,
    abort: () => {},
    ui,
  };
}

type Paths = Awaited<ReturnType<typeof fixture>>;

async function withHost(
  test: TestContext,
  run: (fixture: {
    paths: Paths;
    host: ReturnType<typeof createHost>;
    events: string[];
    open(beforeFactory?: () => Promise<void>): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const paths = await fixture();
  const env = {
    PATH: paths.directory,
    HOME: paths.directory,
    XDG_CONFIG_HOME: paths.directory,
    XDG_DATA_HOME: paths.directory,
    XDG_CACHE_HOME: paths.directory,
    PI_HUNK_TEST_NATIVE: paths.native,
    PI_HUNK_TEST_NATIVE_PID: paths.nativePid,
    PI_HUNK_TEST_LAUNCHER_PID: paths.launcherPid,
    PI_HUNK_TEST_LATE_PID: paths.latePid,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const events: string[] = [];
  let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const host = createHost({
    bridge: paths.native,
    configPath: join(paths.directory, "missing-config.json"),
    matchesKey: (data, key) =>
      (key === "ctrl+space" && data === "\0") ||
      (key === "h" && data === "h") ||
      (key === "escape" && data === "\x1b"),
    isKeyRelease: () => false,
    sendUserMessage: () => {},
  });
  let cleanup: Promise<void> | undefined;
  const close = () =>
    (cleanup ??= (async () => {
      // Restore termination before stopping, including assertion failures in the EPERM test.
      vi.restoreAllMocks();
      try {
        await host.stop();
      } finally {
        // A deliberately failed teardown may have left the fixture's recorded children alive.
        const native = await readNative(paths.nativePid);
        const pids = [
          native?.pid,
          Number(await readFile(paths.launcherPid, "utf8").catch(() => "0")),
        ];
        for (const pid of pids) {
          if (pid && pid > 1 && isAlive(pid)) process.kill(pid, "SIGKILL");
        }
        for (const pid of pids) await waitForExit(pid);
        // Kill the spawning parent first, then read its last child record.
        const late = Number(await readFile(paths.latePid, "utf8").catch(() => "0"));
        if (late > 1 && isAlive(late)) process.kill(late, "SIGKILL");
        await waitForExit(late);
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(paths.directory, { recursive: true, force: true });
      }
    })());
  test.onTestFinished(close, 15_000);
  Object.assign(process.env, env);
  try {
    test.signal.throwIfAborted();
    await run({
      paths,
      host,
      events,
      open: async (beforeFactory) => {
        await host.start(
          context(
            (next) => {
              handler = next;
            },
            events,
            beforeFactory,
          ),
        );
        test.signal.throwIfAborted();
        expect(handler).toBeDefined();
        handler!("\0");
        handler!("h");
      },
    });
  } finally {
    await close();
  }
}

describe("native Hunk process ownership", () => {
  it.skipIf(process.platform === "win32")(
    "tears down an npm launcher descendant before terminal handoff without touching a sibling",
    async (test) => {
      const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const siblingClosed = new Promise<void>((resolve) => sibling.once("close", () => resolve()));
      try {
        await withHost(test, async ({ paths, host, events, open }) => {
          await open();
          const nativeRecord = await waitForNative(paths.nativePid, test.signal);
          const launcherPid = Number(await readFile(paths.launcherPid, "utf8"));
          expect(nativeRecord.ppid).toBe(launcherPid);
          expect(isAlive(nativeRecord.pid)).toBe(true);
          expect(isAlive(sibling.pid!)).toBe(true);
          await host.stop();
          const latePid = Number(await readFile(paths.latePid, "utf8"));
          expect(isAlive(nativeRecord.pid)).toBe(false);
          expect(isAlive(launcherPid)).toBe(false);
          expect(isAlive(latePid)).toBe(false);
          expect(isAlive(sibling.pid!)).toBe(true);
          expect(events).toEqual(["terminal-stop", "terminal-start"]);
        });
      } finally {
        sibling.kill("SIGKILL");
        await siblingClosed;
      }
    },
    15_000,
  );
  it.skipIf(process.platform === "win32")(
    "rejects host.stop when OS termination cannot be verified",
    async (test) => {
      await withHost(test, async ({ paths, host, events, open }) => {
        await open();
        await waitForNative(paths.nativePid, test.signal);
        const originalKill = process.kill.bind(process);
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (signal === "SIGKILL")
            throw Object.assign(new Error("permission denied"), { code: "EPERM" });
          return originalKill(pid, signal);
        });
        await expect(host.stop()).rejects.toThrow(
          /Owned Hunk processes did not exit|Hunk process teardown/,
        );
        expect(events).toEqual(["terminal-stop", "terminal-start"]);
      });
    },
    15_000,
  );
  it.skipIf(process.platform === "win32")(
    "cancels an early failed review before restoring PATH",
    async (test) => {
      const sentinel = await mkdtemp(join(tmpdir(), "pi-hunk-tree-sentinel-"));
      const invoked = join(sentinel, "invoked");
      const previousPath = process.env.PATH;
      await writeFile(
        join(sentinel, "hunk"),
        "#!" +
          process.execPath +
          "\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(" +
          JSON.stringify(invoked) +
          ", 'called');\n",
        { mode: 0o755 },
      );
      process.env.PATH = sentinel;
      try {
        await expect(
          withHost(test, async ({ open }) => {
            let entered = false;
            await open(async () => {
              entered = true;
              await delay(200);
            });
            const bounded = AbortSignal.any([test.signal, AbortSignal.timeout(4_000)]);
            while (!entered) await delay(20, undefined, { signal: bounded });
            throw new Error("forced early failure");
          }),
        ).rejects.toThrow("forced early failure");
        expect(process.env.PATH).toBe(sentinel);
        await delay(250);
        await expect(readFile(invoked, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(sentinel, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
