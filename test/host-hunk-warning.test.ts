import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost, type HostContext } from "../src/host.js";

interface Notice {
  readonly message: string;
  readonly type?: string;
}

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

function hunkScript(body: string): string {
  return `#!${process.execPath}\n${body}`;
}

function context(
  onInput: (handler: (data: string) => { consume?: boolean } | undefined) => void,
  events: string[],
  notices: Notice[],
  onNotice: () => void,
): HostContext {
  const tui = {
    start: () => events.push("terminal-start"),
    stop: () => events.push("terminal-stop"),
    requestRender: () => {},
  };
  const ui: HostContext["ui"] = {
    select: async () => undefined,
    input: async () => undefined,
    notify: (message, type) => {
      notices.push({ message, type });
      onNotice();
    },
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

async function runChord(hunkSource: string | undefined): Promise<{
  notices: Notice[];
  events: string[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hunk-hunk-warning-"));
  const previousPath = process.env.PATH;
  const events: string[] = [];
  const notices: Notice[] = [];
  let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let noticed!: () => void;
  const wait = new Promise<void>((resolve) => {
    noticed = resolve;
  });
  const bridge = join(directory, "bridge.js");
  await writeFile(bridge, "export default () => {};\n");
  if (hunkSource !== undefined) {
    await writeFile(join(directory, "hunk"), hunkSource, { mode: 0o755 });
  }
  const host = createHost({
    bridge,
    configPath: join(directory, "missing-config.json"),
    matchesKey: (data, key) =>
      (key === "ctrl+space" && data.length === 1 && data.charCodeAt(0) === 0) ||
      (key === "h" && data === "h") ||
      (key === "escape" && data.length === 1 && data.charCodeAt(0) === 27),
    isKeyRelease: () => false,
    sendUserMessage: () => {},
  });
  try {
    process.env.PATH = directory;
    const ctx = context(
      (next) => {
        handler = next;
      },
      events,
      notices,
      () => noticed(),
    );
    await host.start(ctx);
    if (!handler) throw new Error("input handler was not installed");
    handler(String.fromCharCode(0));
    handler("h");
    await wait;
    return { notices, events };
  } finally {
    await host.stop().catch(() => {});
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

const oldHunk = hunkScript(`if (process.argv[2] === "--version") {
  process.stdout.write("0.21.1\\n");
  process.exit(0);
}
process.exit(2);
`);

const brokenHunk = hunkScript(`process.stderr.write("not a hunk executable\\n");
process.exit(1);
`);

const supportedHunk = hunkScript(`if (process.argv[2] === "--version") {
  process.stdout.write("0.22.0\\n");
  process.exit(0);
}
process.exit(0);
`);

describe("Hunk dependency warnings", () => {
  it("warns when hunk is missing without taking the terminal", async () => {
    const { notices, events } = await runChord(undefined);
    expect(events).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.type).toBe("error");
    expect(notices[0]!.message).toContain("0.22.0");
    expect(notices[0]!.message).toContain("https://hunk.dev");
  });

  it("warns when hunk is older than 0.22.0 without taking the terminal", async () => {
    const { notices, events } = await runChord(oldHunk);
    expect(events).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.type).toBe("error");
    expect(notices[0]!.message).toContain("0.22.0");
    expect(notices[0]!.message).toContain("0.21.1");
    expect(notices[0]!.message).toContain("https://hunk.dev");
  });

  it("warns when hunk cannot be run without taking the terminal", async () => {
    const { notices, events } = await runChord(brokenHunk);
    expect(events).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.type).toBe("error");
    expect(notices[0]!.message).toContain("0.22.0");
    expect(notices[0]!.message).toContain("https://hunk.dev");
  });

  it("takes the terminal when hunk reports 0.22.0", async () => {
    const { events } = await runChord(supportedHunk);
    expect(events).toEqual(["terminal-stop", "terminal-start"]);
  });
});
