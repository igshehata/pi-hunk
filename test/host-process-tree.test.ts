import { mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

async function readNative(path: string): Promise<NativeRecord | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as NativeRecord;
  } catch {
    return undefined;
  }
}

async function waitForNative(path: string): Promise<NativeRecord> {
  const existing = await readNative(path);
  if (existing) return existing;
  const watcher = watch(dirname(path));
  try {
    for (;;) {
      await watcher.next();
      const record = await readNative(path);
      if (record) return record;
    }
  } finally {
    await watcher.return?.();
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
    `#!/usr/bin/env node
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
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

describe("native Hunk process ownership", () => {
  it.skipIf(process.platform === "win32")(
    "tears down an npm launcher descendant before terminal handoff without touching a sibling",
    async () => {
      const paths = await fixture();
      const previousPath = process.env.PATH;
      const previousNative = process.env.PI_HUNK_TEST_NATIVE;
      const previousNativePid = process.env.PI_HUNK_TEST_NATIVE_PID;
      const previousLauncherPid = process.env.PI_HUNK_TEST_LAUNCHER_PID;
      const previousLatePid = process.env.PI_HUNK_TEST_LATE_PID;
      const sibling = spawn("sleep", ["30"], { stdio: "ignore" });
      const events: string[] = [];
      let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
      try {
        process.env.PATH = `${paths.directory}:${previousPath ?? ""}`;
        process.env.PI_HUNK_TEST_NATIVE = paths.native;
        process.env.PI_HUNK_TEST_NATIVE_PID = paths.nativePid;
        process.env.PI_HUNK_TEST_LAUNCHER_PID = paths.launcherPid;
        process.env.PI_HUNK_TEST_LATE_PID = paths.latePid;
        const host = createHost({
          bridge: paths.native,
          configPath: join(paths.directory, "missing-config.json"),
          matchesKey: (data, key) =>
            (key === "ctrl+space" && data.length === 1 && data.charCodeAt(0) === 0) ||
            (key === "h" && data === "h") ||
            (key === "escape" && data.length === 1 && data.charCodeAt(0) === 27),
          isKeyRelease: () => false,
          sendUserMessage: () => {},
        });
        const ctx = context((next) => {
          handler = next;
        }, events);
        await host.start(ctx);
        expect(handler).toBeDefined();
        handler!(String.fromCharCode(0));
        handler!("h");
        const nativeRecord = await waitForNative(paths.nativePid);
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
      } finally {
        const latePidText = await readFile(paths.latePid, "utf8").catch(() => "");
        const latePid = Number(latePidText);
        if (latePid > 1 && isAlive(latePid)) process.kill(latePid, "SIGKILL");
        if (sibling.pid !== undefined && isAlive(sibling.pid)) sibling.kill("SIGKILL");
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousNative === undefined) delete process.env.PI_HUNK_TEST_NATIVE;
        else process.env.PI_HUNK_TEST_NATIVE = previousNative;
        if (previousNativePid === undefined) delete process.env.PI_HUNK_TEST_NATIVE_PID;
        else process.env.PI_HUNK_TEST_NATIVE_PID = previousNativePid;
        if (previousLauncherPid === undefined) delete process.env.PI_HUNK_TEST_LAUNCHER_PID;
        else process.env.PI_HUNK_TEST_LAUNCHER_PID = previousLauncherPid;
        if (previousLatePid === undefined) delete process.env.PI_HUNK_TEST_LATE_PID;
        else process.env.PI_HUNK_TEST_LATE_PID = previousLatePid;
        await rm(paths.directory, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "rejects host.stop when OS termination cannot be verified",
    async () => {
      const paths = await fixture();
      const previousPath = process.env.PATH;
      const previousNative = process.env.PI_HUNK_TEST_NATIVE;
      const previousNativePid = process.env.PI_HUNK_TEST_NATIVE_PID;
      const previousLauncherPid = process.env.PI_HUNK_TEST_LAUNCHER_PID;
      const previousLatePid = process.env.PI_HUNK_TEST_LATE_PID;
      const sibling = spawn("sleep", ["30"], { stdio: "ignore" });
      const events: string[] = [];
      let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const originalKill = process.kill.bind(process);
      const killMock = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGKILL") {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return originalKill(pid, signal);
      });
      try {
        process.env.PATH = paths.directory + ":" + (previousPath ?? "");
        process.env.PI_HUNK_TEST_NATIVE = paths.native;
        process.env.PI_HUNK_TEST_NATIVE_PID = paths.nativePid;
        process.env.PI_HUNK_TEST_LAUNCHER_PID = paths.launcherPid;
        process.env.PI_HUNK_TEST_LATE_PID = paths.latePid;
        const host = createHost({
          bridge: paths.native,
          configPath: join(paths.directory, "missing-config.json"),
          matchesKey: (data, key) =>
            (key === "ctrl+space" && data.length === 1 && data.charCodeAt(0) === 0) ||
            (key === "h" && data === "h") ||
            (key === "escape" && data.length === 1 && data.charCodeAt(0) === 27),
          isKeyRelease: () => false,
          sendUserMessage: () => {},
        });
        const ctx = context((next) => {
          handler = next;
        }, events);
        await host.start(ctx);
        expect(handler).toBeDefined();
        handler!(String.fromCharCode(0));
        handler!("h");
        await waitForNative(paths.nativePid);

        await expect(host.stop()).rejects.toThrow(
          /Owned Hunk processes did not exit|Hunk process teardown/,
        );
        expect(events).toEqual(["terminal-stop", "terminal-start"]);
      } finally {
        killMock.mockRestore();
        const nativeRecord = await readNative(paths.nativePid);
        if (nativeRecord && isAlive(nativeRecord.pid)) originalKill(nativeRecord.pid, "SIGKILL");
        const launcherPid = Number(await readFile(paths.launcherPid, "utf8").catch(() => "0"));
        if (launcherPid > 1 && isAlive(launcherPid)) originalKill(launcherPid, "SIGKILL");
        const latePid = Number(await readFile(paths.latePid, "utf8").catch(() => "0"));
        if (latePid > 1 && isAlive(latePid)) originalKill(latePid, "SIGKILL");
        if (sibling.pid !== undefined && isAlive(sibling.pid)) sibling.kill("SIGKILL");
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousNative === undefined) delete process.env.PI_HUNK_TEST_NATIVE;
        else process.env.PI_HUNK_TEST_NATIVE = previousNative;
        if (previousNativePid === undefined) delete process.env.PI_HUNK_TEST_NATIVE_PID;
        else process.env.PI_HUNK_TEST_NATIVE_PID = previousNativePid;
        if (previousLauncherPid === undefined) delete process.env.PI_HUNK_TEST_LAUNCHER_PID;
        else process.env.PI_HUNK_TEST_LAUNCHER_PID = previousLauncherPid;
        if (previousLatePid === undefined) delete process.env.PI_HUNK_TEST_LATE_PID;
        else process.env.PI_HUNK_TEST_LATE_PID = previousLatePid;
        await rm(paths.directory, { recursive: true, force: true });
      }
    },
  );
});
