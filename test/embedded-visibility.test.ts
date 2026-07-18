import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";

const pty = vi.hoisted(() => ({
  write: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("../extensions/overlay/pty.ts", () => ({
  spawnOverlayPty: vi.fn(() => pty),
}));

import { EmbeddedHunk } from "../extensions/overlay/embedded.ts";

const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

beforeEach(() => {
  vi.clearAllMocks();
  pty.resize.mockImplementation(() => undefined);
  pty.onData.mockReturnValue({ dispose: vi.fn() });
  pty.onExit.mockReturnValue({ dispose: vi.fn() });
});

describe("EmbeddedHunk presentation state", () => {
  it("enables mouse only while visible and ignores input while hidden", () => {
    const terminalWrite = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: terminalWrite },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 20,
    });

    expect(terminalWrite).not.toHaveBeenCalled();
    component.focused = true;
    expect(terminalWrite).toHaveBeenLastCalledWith(ENABLE_MOUSE);
    component.setVisible(false);
    expect(terminalWrite).toHaveBeenLastCalledWith(DISABLE_MOUSE);
    component.handleInput("x");
    expect(pty.write).not.toHaveBeenCalled();

    component.setVisible(true);
    expect(terminalWrite).toHaveBeenLastCalledWith(ENABLE_MOUSE);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    // Repeated visibility notifications are idempotent and must not cause an
    // extra immediate repaint on top of the throttled output repaint.
    component.setVisible(true);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    component.handleInput("x");
    expect(pty.write).toHaveBeenCalledWith("x");

    component.focused = false;
    expect(terminalWrite).toHaveBeenLastCalledWith(DISABLE_MOUSE);
    component.focused = true;
    expect(terminalWrite).toHaveBeenLastCalledWith(ENABLE_MOUSE);

    component.dispose();
    expect(terminalWrite).toHaveBeenLastCalledWith(DISABLE_MOUSE);
    expect(pty.dispose).toHaveBeenCalledOnce();
  });

  it("disables mouse while a foreign overlay owns focus and reenables on restore", () => {
    const terminalWrite = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: terminalWrite },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 20,
    });

    component.focused = true;
    expect(terminalWrite).toHaveBeenLastCalledWith(ENABLE_MOUSE);
    component.focused = false;
    expect(terminalWrite).toHaveBeenLastCalledWith(DISABLE_MOUSE);
    terminalWrite.mockClear();

    component.setVisible(false);
    component.focused = true;
    expect(terminalWrite).not.toHaveBeenCalled();
    component.setVisible(true);
    expect(terminalWrite).toHaveBeenLastCalledWith(ENABLE_MOUSE);
    component.dispose();
  });

  it("dispatches prefix+h/s instead of forwarding the chord to the PTY", () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const onToggleRequest = vi.fn();
    const onShowRequest = vi.fn();
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      prefixKey: "ctrl+space",
      toggleKey: "h",
      onToggleRequest,
      showKey: "s",
      onShowRequest,
    });

    component.handleInput("\x00");
    component.handleInput("h");
    expect(onToggleRequest).toHaveBeenCalledOnce();

    component.handleInput("\x1b[32;5u");
    component.handleInput("s");
    expect(onShowRequest).toHaveBeenCalledOnce();
    expect(pty.write).not.toHaveBeenCalled();

    // Unknown suffixes cancel the chord; ordinary keys outside a chord reach Hunk.
    component.handleInput("\x00");
    component.handleInput("x");
    component.handleInput("j");
    expect(pty.write).toHaveBeenCalledOnce();
    expect(pty.write).toHaveBeenCalledWith("j");

    // Hidden components ignore the prefix entirely because the editor owns focus.
    component.setVisible(false);
    component.handleInput("\x00");
    component.handleInput("h");
    expect(onToggleRequest).toHaveBeenCalledOnce();

    component.dispose();
  });

  it("translates real terminal mouse events before they reach a split Hunk PTY", () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 40,
      resolveMouseViewport: (_terminalColumns, _terminalRows, columns, rows) => ({
        column: 50,
        row: 0,
        width: columns,
        height: rows,
      }),
    });

    // Establish the 50-column PTY size before input, matching the first overlay render.
    component.render(50);
    pty.write.mockClear();
    component.handleInput("\x1b[<65;75;20M");
    expect(pty.write).toHaveBeenCalledWith("\x1b[<65;25;20M");

    // Mouse input over Pi's left half must not leak into Hunk.
    pty.write.mockClear();
    component.handleInput("\x1b[<65;25;20M");
    expect(pty.write).not.toHaveBeenCalled();
    component.dispose();
  });

  it("forwards all input to the PTY when no toggle key is configured", () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    component.handleInput("\x1b[104;6u");
    expect(pty.write).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("suppresses Pi renders while hidden but keeps the buffer current", async () => {
    const requestRender = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender,
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 20,
    });

    // Grab the pty.onData handler EmbeddedHunk registered.
    const onDataCalls = pty.onData.mock.calls as unknown as Array<[(data: string) => void]>;
    const onData = onDataCalls[0][0];
    expect(typeof onData).toBe("function");

    // Allow the native parser and Pi render notification to flush even on
    // slower CI runners executing the suite in parallel.
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Visible: the first synchronized Hunk frame opens the startup paint gate.
    onData("\x1b[?2026hhello");
    await flush();
    expect(requestRender).toHaveBeenCalled();

    // Hidden: buffer stays current, but no Pi re-render is requested.
    component.setVisible(false);
    requestRender.mockClear();
    onData("while-hidden");
    await flush();
    expect(requestRender).not.toHaveBeenCalled();

    // Re-show: setVisible(true) requests a render reflecting buffered output.
    component.setVisible(true);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(component.render(100).join("\n")).toContain("while-hidden");

    // Rendering resumes for subsequent PTY output once visible again.
    requestRender.mockClear();
    onData("after-show");
    await flush();
    expect(requestRender).toHaveBeenCalled();

    component.dispose();
  });

  it("keeps the startup placeholder until the first output burst settles", async () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 10,
    });
    const onDataCalls = pty.onData.mock.calls as unknown as Array<[(data: string) => void]>;
    const onData = onDataCalls[0][0];

    // Captured from Hunk 0.17/OpenTUI startup. The status query contains the
    // same number as synchronized updates but must not unlock rendering.
    onData("\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x07\x1b[?2026$p\x1b[6n");
    expect(component.render(100)[0]).toContain("Starting Hunk");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(component.render(100)[0]).toContain("Starting Hunk");

    // Ensure detection survives the synchronized-frame marker being split
    // across native PTY chunks.
    onData("\x1b[?20");
    onData("26hfirst-frame");
    await Promise.resolve();
    expect(component.render(100).join("\n")).toContain("first-frame");
    component.dispose();
  });

  it("uses a bounded startup fallback when synchronized frames are unavailable", async () => {
    vi.useFakeTimers();
    try {
      const tui = {
        terminal: { columns: 100, rows: 40, write: vi.fn() },
        requestRender: vi.fn(),
      } as unknown as TUI;
      const component = new EmbeddedHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        initialRows: 10,
      });
      const onDataCalls = pty.onData.mock.calls as unknown as Array<[(data: string) => void]>;
      onDataCalls[0][0]("future-renderer-without-sync-marker");

      await vi.advanceTimersByTimeAsync(999);
      expect(component.render(100)[0]).toContain("Starting Hunk");
      await vi.advanceTimersByTimeAsync(1);
      expect(component.render(100).join("\n")).toContain("future-renderer-without-sync-marker");
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails startup once when no terminal frame ever becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const tui = {
        terminal: { columns: 100, rows: 40, write: vi.fn() },
        requestRender: vi.fn(),
      } as unknown as TUI;
      const component = new EmbeddedHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done,
        initialRows: 10,
        startupFrameDeadlineMs: 250,
      });
      const onExitCalls = pty.onExit.mock.calls as unknown as Array<
        [(event: { exitCode: number; signal?: number }) => void]
      >;

      await vi.advanceTimersByTimeAsync(249);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledWith(
        expect.objectContaining({
          exitCode: 124,
          detail: expect.stringContaining("no terminal frame"),
        }),
      );
      expect(pty.dispose).toHaveBeenCalledOnce();

      onExitCalls[0][0]({ exitCode: 1, signal: 0 });
      expect(done).toHaveBeenCalledOnce();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes bounded visible terminal detail with child exits", () => {
    const done = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done,
      initialRows: 10,
    });
    const onDataCalls = pty.onData.mock.calls as unknown as Array<[(data: string) => void]>;
    const onExitCalls = pty.onExit.mock.calls as unknown as Array<
      [(event: { exitCode: number; signal?: number }) => void]
    >;

    onDataCalls[0][0]("\x1b[?2026hfatal: boom\r\nretry with --repo\r\n");
    onExitCalls[0][0]({ exitCode: 2, signal: 0 });

    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        exitCode: 2,
        detail: expect.stringContaining("fatal: boom"),
      }),
    );
    expect(done.mock.calls[0]?.[0].detail).toContain("retry with --repo");
    component.dispose();
  });

  it("does not resize a dead PTY from a late Pi render", () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 20,
    });
    const onExitCalls = pty.onExit.mock.calls as unknown as Array<
      [(event: { exitCode: number; signal?: number }) => void]
    >;
    onExitCalls[0][0]({ exitCode: 0, signal: 0 });
    pty.resize.mockClear();
    pty.resize.mockImplementation(() => {
      throw new Error("dead pty");
    });

    expect(() => component.render(80)).not.toThrow();
    expect(pty.resize).not.toHaveBeenCalled();
    component.dispose();
  });

  it("does not deliver a stale exit callback after disposal", () => {
    const done = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done,
    });
    const onExitCalls = pty.onExit.mock.calls as unknown as Array<
      [(event: { exitCode: number; signal?: number }) => void]
    >;

    component.dispose();
    onExitCalls[0][0]({ exitCode: 0 });
    expect(done).not.toHaveBeenCalled();
  });

  it("coalesces a same-turn PTY burst without adding a frame timer", async () => {
    const requestRender = vi.fn();
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender,
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff", "--watch"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    const onDataCalls = pty.onData.mock.calls as unknown as Array<[(data: string) => void]>;
    const onData = onDataCalls[0][0];

    // Open the one-time startup paint gate before measuring normal frame coalescing.
    onData("\x1b[?2026hboot\r\n");
    await Promise.resolve();
    requestRender.mockClear();

    // A watch refresh commonly arrives as many chunks in one JavaScript turn.
    // libghostty receives all of them synchronously; one microtask notifies Pi,
    // whose own 16 ms scheduler performs frame-rate coalescing.
    for (let index = 0; index < 100; index++) onData(`row-${index}\r\n`);
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(component.render(100).join("\n")).toContain("row-99");

    // Hiding before the microtask runs suppresses it; showing paints once.
    requestRender.mockClear();
    onData("pending");
    component.setVisible(false);
    await Promise.resolve();
    expect(requestRender).not.toHaveBeenCalled();
    component.setVisible(true);
    expect(requestRender).toHaveBeenCalledTimes(1);
    component.dispose();
  });

  it("uses the overlay row resolver after terminal resize", () => {
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      initialRows: 20,
      resolveRows: (rows) => Math.floor(rows / 2),
    });

    component.render(80);
    expect(pty.resize).toHaveBeenLastCalledWith(80, 20);

    (tui.terminal as { rows: number }).rows = 30;
    component.render(70);
    expect(pty.resize).toHaveBeenLastCalledWith(70, 15);
    component.dispose();
  });
});
