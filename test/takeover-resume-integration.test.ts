import { describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { hasNative } from "zigpty";
import { TakeoverHunk, type TakeoverRawInputSource } from "../extensions/overlay/takeover.ts";

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";

// This child models OpenTUI's asynchronous SIGWINCH handling. Resize signals
// received in one turn collapse before it reads the final PTY geometry, while a
// changed geometry emits a complete synchronized repaint.
const COALESCING_RENDERER_FIXTURE = String.raw`
const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const emitFrame = (kind, rows) => {
  process.stdout.write(FRAME_START + kind + "-" + rows + FRAME_END);
};
let renderedRows = process.stdout.rows;
let resizeTimer;
setTimeout(() => emitFrame("full", renderedRows), 25);
process.on("SIGWINCH", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const rows = process.stdout.rows;
    const kind = rows === renderedRows ? "delta" : "full";
    renderedRows = rows;
    emitFrame(kind, rows);
  }, 40);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`;

const STARTUP_INPUT_FIXTURE = String.raw`
const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("\x1b[>0q\x1b]1337;Capabilities\x1b\\");
let input = Buffer.alloc(0);
let timer;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  clearTimeout(timer);
  timer = setTimeout(() => {
    process.stdout.write(FRAME_START + "child-input-" + input.toString("hex") + FRAME_END);
  }, 40);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`;

const NON_BMP_INPUT_FIXTURE = String.raw`
const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
process.stdin.setRawMode?.(true);
process.stdin.resume();
setTimeout(() => process.stdout.write(FRAME_START + "ready" + FRAME_END), 25);
process.stdin.on("data", (chunk) => {
  process.stdout.write(FRAME_START + "input-" + Buffer.from(chunk).toString("hex") + FRAME_END);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`;

const EARLY_EXIT_FIXTURE = String.raw`
process.stdout.write("\x1b[>0q");
process.stderr.write("fatal: takeover fixture failed\nretry with --repo /repo\n");
setTimeout(() => process.exit(23), 25);
`;

type InputListener = (data: string) => { consume?: boolean } | undefined;

function makeTui(
  write: (text: string) => void,
  captureInputListener?: (listener: InputListener) => void,
): TUI {
  const runtime = {
    terminal: {
      columns: 80,
      rows: 24,
      write,
      stop: vi.fn(),
      start: vi.fn(),
    },
    requestRender: vi.fn(),
    renderRequested: false,
    stopped: false,
    addInputListener: vi.fn((listener: InputListener) => {
      captureInputListener?.(listener);
      return () => undefined;
    }),
    stop: vi.fn(),
    start: vi.fn(),
  };
  runtime.stop.mockImplementation(() => {
    runtime.stopped = true;
  });
  runtime.start.mockImplementation(() => {
    runtime.stopped = false;
    runtime.requestRender();
  });
  return runtime as unknown as TUI;
}

async function waitForOutput(
  read: () => string,
  expected: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${JSON.stringify(read())}`);
}

function makeRawInputSource(): {
  source: TakeoverRawInputSource;
  dispatch: (data: string | Uint8Array) => void;
} {
  let listener: ((data: string | Uint8Array) => void) | undefined;
  return {
    source: {
      acquire(next) {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    },
    dispatch(data) {
      listener?.(data);
    },
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
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
  throw new Error(`process ${pid} survived takeover disposal`);
}

describe.runIf(hasNative && (process.platform === "darwin" || process.platform === "linux"))(
  "takeover resume with a native PTY",
  () => {
    it("survives the exact on -> off -> on cycle without coalescing away Hunk's repaint", async () => {
      let output = "";
      const component = new TakeoverHunk({
        command: process.execPath,
        args: ["-e", COALESCING_RENDERER_FIXTURE],
        cwd: process.cwd(),
        tui: makeTui((text) => {
          output += text;
        }),
        done: vi.fn(),
        startupFrameDeadlineMs: 5_000,
      });
      const pid = component.pid;

      try {
        await waitForOutput(() => output, `${FRAME_START}\x1b[2J\x1b[Hfull-24${FRAME_END}`);

        component.setVisible(false);
        output = "";
        component.setVisible(true);

        await waitForOutput(() => output, `full-23${FRAME_END}`);
        await waitForOutput(() => output, `full-24${FRAME_END}`);

        expect(output).toContain("Restoring Hunk…");
        expect(output.indexOf("Restoring Hunk…")).toBeLessThan(output.indexOf("full-23"));
        expect(output.indexOf("full-23")).toBeLessThan(output.indexOf("full-24"));
        expect(output).not.toContain("delta-24");
      } finally {
        component.dispose();
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    }, 20_000);

    it("keeps startup prefix chords out of a real child while forwarding current probes", async () => {
      let output = "";
      const raw = makeRawInputSource();
      const onToggleRequest = vi.fn();
      const component = new TakeoverHunk({
        command: process.execPath,
        args: ["-e", STARTUP_INPUT_FIXTURE],
        cwd: process.cwd(),
        tui: makeTui((text) => {
          output += text;
        }),
        done: vi.fn(),
        rawInputSource: raw.source,
        prefixKey: "ctrl+space",
        toggleKey: "h",
        onToggleRequest,
        startupFrameDeadlineMs: 5_000,
      });
      const pid = component.pid;
      const replies =
        "\x1bP>|fixture-terminal 1.0\x1b\\" + "\x1b]1337;Capabilities=unicode-placeholder\x1b\\";

      try {
        await waitForOutput(() => output, "\x1b[>0q");
        await waitForOutput(() => output, "\x1b]1337;Capabilities\x1b\\");
        raw.dispatch(replies + "\x00h");

        await waitForOutput(() => output, `child-input-${Buffer.from(replies).toString("hex")}`);
        expect(onToggleRequest).toHaveBeenCalledOnce();
        expect(output).not.toContain(Buffer.from("\x00h").toString("hex"));
      } finally {
        component.dispose();
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    }, 20_000);

    it("reassembles split non-BMP TUI input before a real child PTY write", async () => {
      let output = "";
      let inputListener: InputListener | undefined;
      const component = new TakeoverHunk({
        command: process.execPath,
        args: ["-e", NON_BMP_INPUT_FIXTURE],
        cwd: process.cwd(),
        tui: makeTui(
          (text) => {
            output += text;
          },
          (listener) => {
            inputListener = listener;
          },
        ),
        done: vi.fn(),
        startupFrameDeadlineMs: 5_000,
      });
      const pid = component.pid;
      const emoji = "😀";

      try {
        await waitForOutput(() => output, `${FRAME_START}\x1b[2J\x1b[Hready${FRAME_END}`);
        expect(inputListener).toBeDefined();
        inputListener!(emoji[0]!);
        inputListener!(emoji[1]!);

        await waitForOutput(() => output, "input-f09f9880");
        expect(output).not.toContain("input-efbfbdefbfbd");
      } finally {
        component.dispose();
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    }, 20_000);

    it("returns real pre-frame stderr as actionable child exit detail", async () => {
      let output = "";
      let resolveExit!: (result: { exitCode: number; signal?: number; detail?: string }) => void;
      const exit = new Promise<{ exitCode: number; signal?: number; detail?: string }>(
        (resolve) => {
          resolveExit = resolve;
        },
      );
      const component = new TakeoverHunk({
        command: process.execPath,
        args: ["-e", EARLY_EXIT_FIXTURE],
        cwd: process.cwd(),
        tui: makeTui((text) => {
          output += text;
        }),
        done: resolveExit,
        startupFrameDeadlineMs: 5_000,
      });
      const pid = component.pid;

      try {
        const result = await Promise.race([
          exit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out waiting for fixture exit")), 5_000),
          ),
        ]);
        expect(output).toContain("\x1b[>0q");
        expect(result).toEqual({
          exitCode: 23,
          signal: 0,
          detail: "fatal: takeover fixture failed\nretry with --repo /repo",
        });
      } finally {
        component.dispose();
        if (pid !== undefined) await waitForProcessExit(pid);
      }
    }, 20_000);
  },
);
