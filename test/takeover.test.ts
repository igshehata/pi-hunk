import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";

const pty = vi.hoisted(() => ({
  write: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn((_listener: (data: string | Uint8Array) => void) => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  pid: 4242,
}));

vi.mock("../extensions/overlay/pty.ts", () => ({
  spawnOverlayPty: vi.fn(() => pty),
}));

import { TakeoverHunk, type TakeoverRawInputSource } from "../extensions/overlay/takeover.ts";
import { resolveOverlayHostMode } from "../extensions/config.ts";

beforeEach(() => {
  vi.clearAllMocks();
  pty.write.mockReset();
  pty.resize.mockReset();
  pty.dispose.mockReset();
  pty.onData.mockReset().mockReturnValue({ dispose: vi.fn() });
  pty.onExit.mockReset().mockReturnValue({ dispose: vi.fn() });
});

const HOST_STOP_MODES = "\x1b[?2004l\x1b[<u";
const HOST_START_MODES = "\x1b[?2004h\x1b[>7u\x1b[?u\x1b[c";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const syncFrame = (content: string): string => `\x1b[?2026h${content}\x1b[?2026l`;

function makeRawInputSource() {
  let listener: ((data: string | Uint8Array) => void) | undefined;
  const release = vi.fn((next: (data: string | Uint8Array) => void) => {
    if (listener === next) listener = undefined;
  });
  const source: TakeoverRawInputSource = {
    acquire: vi.fn((next) => {
      listener = next;
      return () => release(next);
    }),
  };
  return {
    source,
    release,
    dispatch(data: string | Uint8Array): void {
      listener?.(data);
    },
    active: () => Boolean(listener),
  };
}

function makeTui() {
  const terminalWrite = vi.fn();
  const requestRender = vi.fn();
  const terminalStop = vi.fn(() => terminalWrite(HOST_STOP_MODES));
  const terminalStart = vi.fn(() => terminalWrite(HOST_START_MODES));
  const terminal = {
    columns: 80,
    rows: 24,
    write: terminalWrite,
    stop: terminalStop,
    start: terminalStart,
  };
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const tuiStop = vi.fn();
  const tuiStart = vi.fn();
  const addInputListener = vi.fn(
    (listener: (data: string) => { consume?: boolean } | undefined) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  const tuiRuntime = {
    terminal,
    requestRender,
    stopped: false,
    addInputListener,
    stop: tuiStop,
    start: tuiStart,
  };
  const tui = tuiRuntime as unknown as TUI;
  tuiStop.mockImplementation(() => {
    tuiRuntime.stopped = true;
    terminalStop();
  });
  tuiStart.mockImplementation(() => {
    tuiRuntime.stopped = false;
    terminalStart();
    // Real TUI.start() requests a frame. It must still hit the takeover shim,
    // leaving resumePiPaint() as the sole authoritative forced redraw.
    tuiRuntime.requestRender();
  });
  return {
    tui,
    terminal,
    terminalWrite,
    terminalStop,
    terminalStart,
    tuiStop,
    tuiStart,
    requestRender,
    addInputListener,
    listeners,
  };
}

function exitListener(): (result: { exitCode: number; signal?: number }) => void {
  return (
    pty.onExit.mock.calls as unknown as Array<[(result: object) => void]>
  )[0]![0] as (result: { exitCode: number; signal?: number }) => void;
}

function countOutput(terminalWrite: ReturnType<typeof vi.fn>, sequence: string): number {
  return terminalWrite.mock.calls.flat().join("").split(sequence).length - 1;
}

function makeTerminalModeModel() {
  const state = {
    focus: false,
    unicode: false,
    colorNotifications: false,
    modifyOtherKeys: 0,
    keyboardStack: [] as number[],
  };
  return {
    state,
    observe(output: string): void {
      const escape = String.fromCharCode(27);
      const tokens = new RegExp(
        `${escape}\\[\\?(1004|2027|2031)([hl])|${escape}\\[>4;(\\d+)m|${escape}\\[>(\\d+)u|${escape}\\[<u`,
        "g",
      );
      for (const match of output.matchAll(tokens)) {
        if (match[1]) {
          const enabled = match[2] === "h";
          if (match[1] === "1004") state.focus = enabled;
          else if (match[1] === "2027") state.unicode = enabled;
          else state.colorNotifications = enabled;
        } else if (match[3]) {
          state.modifyOtherKeys = Number.parseInt(match[3], 10);
        } else if (match[4]) {
          state.keyboardStack.push(Number.parseInt(match[4], 10));
        } else {
          state.keyboardStack.pop();
        }
      }
    },
  };
}

describe("TakeoverHunk", () => {
  it("publishes the first complete synchronized PTY frame and does not request Pi paints", () => {
    const { tui, terminalWrite, requestRender } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    terminalWrite.mockClear();
    const frame = syncFrame("hello-from-hunk");
    onData(frame);
    expect(terminalWrite).toHaveBeenCalledWith(syncFrame("\x1b[2J\x1b[Hhello-from-hunk"));
    expect(requestRender).not.toHaveBeenCalled();

    // Pi paint path is suspended. Unchanged render requests neither paint Pi nor resize Hunk.
    tui.requestRender();
    expect(requestRender).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();

    component.dispose();
  });

  it("decodes multibyte PTY output across Uint8Array chunk boundaries", () => {
    const { tui, terminalWrite } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    onData(syncFrame("ready"));
    terminalWrite.mockClear();
    const encoded = new TextEncoder().encode("€");
    const backing = new Uint8Array(encoded.length + 2);
    backing.set(encoded, 1);

    terminalWrite.mockClear();
    onData(backing.subarray(1, 2));
    onData(backing.subarray(2, 3));
    expect(terminalWrite).not.toHaveBeenCalled();
    onData(backing.subarray(3, 4));

    expect(terminalWrite).toHaveBeenCalledTimes(1);
    expect(terminalWrite).toHaveBeenCalledWith("€");
    expect(terminalWrite.mock.calls.flat().join("")).not.toContain("�");
    component.dispose();
  });

  it("holds the resize bounce until a complete Hunk frame redraws an unchanged resume", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminalWrite } = makeTui();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];

      onData(syncFrame("initial-frame"));
      component.setVisible(false);
      onData("discarded-while-hidden");
      terminalWrite.mockClear();
      pty.resize.mockClear();

      // Exact user regression: on -> off -> on. The old implementation issued
      // both calls synchronously, allowing SIGWINCH to collapse at 80x24.
      component.setVisible(true);
      expect(pty.resize.mock.calls).toEqual([[80, 23]]);
      expect(terminalWrite.mock.calls.flat().join("")).toContain("Restoring Hunk…");

      // A complete frame queued while hidden must not immediately acknowledge
      // the resize. The causal temporary-size frame supersedes it during the
      // settle interval, including when DEC markers cross PTY chunks.
      onData(syncFrame("stale-differential"));
      vi.advanceTimersByTime(50);
      expect(pty.resize.mock.calls).toEqual([[80, 23]]);
      onData("\x1b[?2026hfresh-");
      onData("frame\x1b[?2026l");
      vi.advanceTimersByTime(99);
      expect(pty.resize.mock.calls).toEqual([[80, 23]]);
      vi.advanceTimersByTime(1);

      expect(pty.resize.mock.calls).toEqual([
        [80, 23],
        [80, 24],
      ]);
      const resumedOutput = terminalWrite.mock.calls.flat().join("");
      expect(resumedOutput).toContain("fresh-frame");
      expect(resumedOutput).not.toContain("discarded-while-hidden");
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores final geometry after a bounded fallback when no synchronized frame arrives", () => {
    vi.useFakeTimers();
    try {
      const { tui } = makeTui();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      onData(syncFrame("initial-frame"));
      component.setVisible(false);
      pty.resize.mockClear();

      component.setVisible(true);
      expect(pty.resize.mock.calls).toEqual([[80, 23]]);
      vi.advanceTimersByTime(999);
      expect(pty.resize.mock.calls).toEqual([[80, 23]]);
      vi.advanceTimersByTime(1);
      expect(pty.resize.mock.calls).toEqual([
        [80, 23],
        [80, 24],
      ]);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores temporary geometry when resume is hidden again before its redraw", () => {
    vi.useFakeTimers();
    try {
      const { tui } = makeTui();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      onData(syncFrame("initial-frame"));
      component.setVisible(false);
      pty.resize.mockClear();

      component.setVisible(true);
      component.setVisible(false);
      expect(pty.resize.mock.calls).toEqual([
        [80, 23],
        [80, 24],
      ]);
      vi.advanceTimersByTime(1_000);
      expect(pty.resize).toHaveBeenCalledTimes(2);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a real terminal resize supersede a pending resume bounce", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminal } = makeTui();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      onData(syncFrame("initial-frame"));
      component.setVisible(false);
      pty.resize.mockClear();
      component.setVisible(true);

      terminal.columns = 100;
      terminal.rows = 30;
      tui.requestRender();
      expect(pty.resize.mock.calls).toEqual([
        [80, 23],
        [100, 30],
      ]);
      vi.advanceTimersByTime(1_000);
      expect(pty.resize).toHaveBeenCalledTimes(2);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores final PTY geometry even if the temporary refresh resize fails", () => {
    const { tui } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    component.setVisible(false);
    pty.resize.mockClear();
    pty.resize.mockImplementationOnce(() => {
      throw new Error("temporary resize failed");
    });
    component.setVisible(true);

    expect(pty.resize.mock.calls).toEqual([
      [80, 23],
      [80, 24],
    ]);
    component.dispose();
  });

  it("drops decoder state when hidden output splits a UTF-8 character", () => {
    const { tui, terminalWrite } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    const encoded = new TextEncoder().encode("€");

    onData(syncFrame("ready"));
    terminalWrite.mockClear();
    onData(encoded.subarray(0, 1));
    component.setVisible(false);
    onData(encoded.subarray(1));
    component.setVisible(true);
    terminalWrite.mockClear();
    onData(encoded);

    expect(terminalWrite.mock.calls.flat().join("")).toBe("€");
    component.dispose();
  });

  it("propagates terminal resizes while keeping Pi paints suppressed", () => {
    const { tui, terminal, requestRender } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    pty.resize.mockClear();
    terminal.columns = 120;
    terminal.rows = 40;
    tui.requestRender();
    tui.requestRender(true);

    expect(pty.resize).toHaveBeenCalledTimes(1);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(requestRender).not.toHaveBeenCalled();
    component.dispose();
  });

  it("forwards input to the child PTY and consumes TUI input listeners", () => {
    const { tui, listeners } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    expect(listeners.size).toBe(1);
    const [listener] = [...listeners];
    const result = listener!("j");
    expect(result).toEqual({ consume: true });
    listener!("\x1b[57414;1:2u");
    listener!("\x1b[57414;1:3u");
    expect(pty.write.mock.calls.map(([data]) => data)).toEqual(["j", "\r"]);

    component.dispose();
  });

  it("bridges Hunk 0.17.6 startup queries/replies raw and publishes only the first complete frame", () => {
    const { tui, terminalWrite, listeners } = makeTui();
    const raw = makeRawInputSource();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      rawInputSource: raw.source,
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    const prelude =
      "probe-echo-must-not-paint" +
      "\x1b]10;?\x07\x1b]11;?\x07" +
      "\x1b[6n" +
      "\x1bP+q544e;524742\x1b\\" +
      "\x1b[?2026$p\x1b[?1004$p\x1b[?u\x1b[16t";
    const replies =
      "\x1b]10;rgb:ffff/ffff/ffff\x07" +
      "\x1b]11;rgb:0000/0000/0000\x07" +
      "\x1b[12;40R" +
      "\x1bP1+r544e=787465726d2d323536636f6c6f72\x1b\\" +
      "\x1b[?2;1$y\x1b[?7u\x1b[6;20;10t";
    const frame = syncFrame("\x1b[Hfirst Hunk UI");

    expect(raw.active()).toBe(true);
    expect(terminalWrite.mock.calls.flat().join("")).toContain("Starting Hunk…");
    onData(prelude.slice(0, 29));
    onData(prelude.slice(29));
    const queriesForwarded = terminalWrite.mock.calls.flat().join("");
    expect(queriesForwarded).toContain("\x1b]10;?\x07");
    expect(queriesForwarded).toContain("\x1b[6n");
    expect(queriesForwarded).toContain("\x1bP+q544e;524742\x1b\\");

    // Replies can only be generated after the physical terminal receives the
    // corresponding requests, and must bypass Pi's parsed input path.
    raw.dispatch(replies);
    // Raw stdin is split into complete terminal events, but its byte stream is
    // preserved exactly for Hunk.
    expect(pty.write.mock.calls.map(([data]) => data).join("")).toBe(replies);

    onData(frame.slice(0, 6));
    expect(terminalWrite.mock.calls.flat().join("")).not.toContain("probe-echo-must-not-paint");
    expect(terminalWrite.mock.calls.flat().join("")).not.toContain("first Hunk UI");
    onData(frame.slice(6));

    const physical = terminalWrite.mock.calls.flat().join("");
    const publishedFrame = syncFrame("\x1b[2J\x1b[H\x1b[Hfirst Hunk UI");
    expect(physical).toContain("\x1b]10;?\x07");
    expect(physical).toContain(publishedFrame);
    expect(physical.indexOf("Starting Hunk…")).toBeLessThan(physical.indexOf(publishedFrame));
    expect(physical).not.toContain("probe-echo-must-not-paint");
    expect(physical).not.toContain("rgb:ffff");
    expect(physical).not.toContain("1+r544e");
    expect(raw.active()).toBe(false);

    // Readiness restores Pi's normal parsed/key-translation path exactly once.
    const [listener] = [...listeners];
    listener!("j");
    expect(pty.write).toHaveBeenLastCalledWith("j");
    expect(raw.source.acquire).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("disambiguates a standalone startup Escape after the host input delay", () => {
    vi.useFakeTimers();
    try {
      const { tui } = makeTui();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        rawInputSource: raw.source,
      });
      pty.write.mockClear();

      raw.dispatch("\x1b");
      vi.advanceTimersByTime(9);
      expect(pty.write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(pty.write.mock.calls.map(([data]) => data)).toEqual(["\x1b"]);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending startup Escape exactly once when readiness releases raw input", () => {
    vi.useFakeTimers();
    try {
      const { tui } = makeTui();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        rawInputSource: raw.source,
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      pty.write.mockClear();

      raw.dispatch("\x1b");
      onData(syncFrame("ready"));

      expect(raw.active()).toBe(false);
      expect(pty.write.mock.calls.map(([data]) => data)).toEqual(["\x1b"]);
      vi.advanceTimersByTime(10);
      expect(pty.write).toHaveBeenCalledOnce();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps raw input leased through split query-only negotiation beyond fallback", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminalWrite } = makeTui();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        rawInputSource: raw.source,
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      terminalWrite.mockClear();

      const queries =
        "\x1b]10;?\x07\x1b]11;?\x07\x1b[6n\x1bP+q544e;524742\x1b\\\x1b[?2026$p\x1b[?u\x1b[16t";
      for (const chunk of [
        queries.slice(0, 2),
        queries.slice(2, 13),
        queries.slice(13, 31),
        queries.slice(31),
      ]) {
        onData(chunk);
      }
      expect(terminalWrite.mock.calls.flat().join("")).toBe(queries);

      vi.advanceTimersByTime(1_001);

      // Query-only traffic never makes the renderer-without-sync fallback
      // eligible, so Pi still cannot parse a terminal reply or paint a fallback.
      expect(raw.active()).toBe(true);
      expect(terminalWrite.mock.calls.flat().join("")).toBe(queries);

      const frame = syncFrame("\x1b[Hfirst differential UI");
      onData(frame.slice(0, 7));
      onData(frame.slice(7));
      expect(terminalWrite.mock.calls.flat().join("")).toContain(
        syncFrame("\x1b[2J\x1b[H\x1b[Hfirst differential UI"),
      );
      expect(raw.active()).toBe(false);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a quiet prelude interval before using the no-sync fallback", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminalWrite } = makeTui();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        rawInputSource: raw.source,
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      terminalWrite.mockClear();

      onData("printable-probe-echo");
      vi.advanceTimersByTime(999);
      onData("\x1b]10;?");
      vi.advanceTimersByTime(999);
      onData("\x07\x1b[6");
      vi.advanceTimersByTime(999);
      onData("n");
      vi.advanceTimersByTime(999);

      // Every waiting chunk rearms fallback after printable output made it
      // eligible. Complete queries are forwarded, but nothing is painted and
      // raw terminal replies remain leased until the whole prelude goes quiet.
      expect(terminalWrite.mock.calls.flat().join("")).toBe("\x1b]10;?\x07\x1b[6n");
      expect(raw.active()).toBe(true);

      vi.advanceTimersByTime(1);

      const physical = terminalWrite.mock.calls.flat().join("");
      expect(physical).toContain("\x1b[2J\x1b[Hprintable-probe-echo");
      expect(countOutput(terminalWrite, "\x1b]10;?\x07")).toBe(1);
      expect(countOutput(terminalWrite, "\x1b[6n")).toBe(1);
      expect(raw.active()).toBe(false);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquires raw input before a synchronous first PTY data callback", () => {
    const { tui, terminalWrite } = makeTui();
    const raw = makeRawInputSource();
    let rawWasActive = false;
    pty.onData.mockImplementationOnce((listener) => {
      rawWasActive = raw.active();
      listener("\x1b[6n");
      return { dispose: vi.fn() };
    });

    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      rawInputSource: raw.source,
    });

    expect(rawWasActive).toBe(true);
    expect(terminalWrite.mock.calls.flat().join("")).toContain("\x1b[6n");
    expect(raw.active()).toBe(true);
    component.dispose();
  });

  it("uses a bounded no-sync fallback without replaying capability queries", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminalWrite } = makeTui();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done: vi.fn(),
        rawInputSource: raw.source,
      });
      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      terminalWrite.mockClear();
      onData("\x1b]10;?\x07\x1b[2J\x1b[Hfallback UI");
      expect(terminalWrite.mock.calls.flat().join("")).toBe("\x1b]10;?\x07");

      vi.advanceTimersByTime(1_000);

      const physical = terminalWrite.mock.calls.flat().join("");
      expect(physical).toContain("\x1b[2J\x1b[H\x1b[2J\x1b[Hfallback UI");
      expect(countOutput(terminalWrite, "\x1b]10;?\x07")).toBe(1);
      expect(raw.active()).toBe(false);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches startup prefix+h/s through its real TUI listener without PTY leakage", () => {
    const { tui, terminalWrite, listeners } = makeTui();
    const raw = makeRawInputSource();
    const onToggleRequest = vi.fn();
    const onShowRequest = vi.fn();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
      rawInputSource: raw.source,
      prefixKey: "ctrl+space",
      toggleKey: "h",
      onToggleRequest,
      showKey: "s",
      onShowRequest,
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    terminalWrite.mockClear();

    const probes = "\x1b[>0q\x1b]1337;Capabilities\x1b\\";
    onData(probes.slice(0, 5));
    onData(probes.slice(5));
    expect(terminalWrite.mock.calls.flat().join("")).toBe(probes);

    // `:3F` resembles Pi TUI's Kitty-release heuristic; a structured reply
    // must bypass key translation and remain intact.
    const versionReply = "\x1bP>|Hunk-test:3F-terminal\x1b\\";
    const capabilitiesReply = "\x1b]1337;Capabilities=unicode-placeholder\x1b\\";
    raw.dispatch(versionReply + "\x00h");
    raw.dispatch(capabilitiesReply + "\x1b[32;5us");

    expect(listeners.size).toBe(1);
    expect(onToggleRequest).toHaveBeenCalledOnce();
    expect(onShowRequest).toHaveBeenCalledOnce();

    // The post-negotiation TUI path uses the same listener and semantics.
    onData(syncFrame("ready"));
    const [listener] = [...listeners];
    listener!("\x00");
    listener!("h");
    listener!("\x1b[32;5u");
    listener!("s");
    expect(onToggleRequest).toHaveBeenCalledTimes(2);
    expect(onShowRequest).toHaveBeenCalledTimes(2);

    const childInput = pty.write.mock.calls.map(([data]) => data).join("");
    expect(childInput).toBe(versionReply + capabilitiesReply);
    expect(childInput).not.toContain("\x00");
    expect(childInput).not.toContain("\x1b[32;5u");
    component.dispose();
  });

  it("reassembles non-BMP text split by Pi's real input-listener path", () => {
    const { tui, listeners } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    const [listener] = [...listeners];
    const emoji = "😀";

    listener!(emoji[0]!);
    expect(pty.write).not.toHaveBeenCalled();
    listener!(emoji[1]!);

    expect(pty.write).toHaveBeenCalledOnce();
    expect(pty.write).toHaveBeenCalledWith(emoji);
    component.dispose();
  });

  it("passes bounded pre-frame child stderr/output as exit detail", () => {
    const { tui } = makeTui();
    const done = vi.fn();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done,
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];

    onData("\x1b]10;?\x07fatal: repository unavailable\r\nretry with --repo /repo\r\n");
    exitListener()({ exitCode: 2, signal: 0 });

    expect(done).toHaveBeenCalledWith({
      exitCode: 2,
      signal: 0,
      detail: "fatal: repository unavailable\nretry with --repo /repo",
    });
    component.dispose();
  });

  it("restores child keyboard/focus modes after hide, show, and close", () => {
    const { tui, terminalWrite } = makeTui();
    const modes = makeTerminalModeModel();
    modes.observe(HOST_START_MODES);
    let observedLength = 0;
    const observeWrites = (): void => {
      const output = terminalWrite.mock.calls.flat().join("");
      modes.observe(output.slice(observedLength));
      observedLength = output.length;
    };
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    const onData = (
      pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
    )[0]![0];
    const childModes = "\x1b[?1004h\x1b[?2027h\x1b[?2031h\x1b[>4;1m\x1b[>5u";

    onData(syncFrame(childModes + "ready"));
    observeWrites();
    expect(modes.state).toMatchObject({
      focus: true,
      unicode: true,
      colorNotifications: true,
      modifyOtherKeys: 1,
      keyboardStack: [7, 5],
    });

    component.setVisible(false);
    observeWrites();
    expect(modes.state).toEqual({
      focus: false,
      unicode: false,
      colorNotifications: false,
      modifyOtherKeys: 0,
      keyboardStack: [7],
    });

    component.setVisible(true);
    onData(syncFrame(childModes + "resumed"));
    observeWrites();
    expect(modes.state.focus).toBe(true);
    expect(modes.state.modifyOtherKeys).toBe(1);

    component.dispose();
    observeWrites();
    expect(modes.state).toEqual({
      focus: false,
      unicode: false,
      colorNotifications: false,
      modifyOtherKeys: 0,
      keyboardStack: [7],
    });
  });

  it("captures outside mouse release per takeover lease and resets it when suspended", () => {
    const { tui } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    pty.write.mockClear();
    component.handleInput("\x1b[<0;10;10M");
    component.handleInput("\x1b[<32;100;30M");
    component.handleInput("\x1b[<0;100;30m");
    expect(pty.write.mock.calls.map(([data]) => data)).toEqual([
      "\x1b[<0;10;10M",
      "\x1b[<32;80;24M",
      "\x1b[<0;80;24m",
    ]);

    component.handleInput("\x1b[<0;10;10M");
    component.setVisible(false);
    component.setVisible(true);
    pty.write.mockClear();
    component.handleInput("\x1b[<0;100;30m");
    expect(pty.write).not.toHaveBeenCalled();
    component.dispose();
  });

  it("rolls back takeover when synchronous listener setup throws", () => {
    const { tui, terminalWrite, requestRender, addInputListener, listeners, tuiStop, tuiStart } =
      makeTui();
    const raw = makeRawInputSource();
    const dataSubscription = { dispose: vi.fn() };
    const exitSubscription = { dispose: vi.fn() };
    const setupError = new Error("input listener setup failed");
    pty.onData.mockReturnValueOnce(dataSubscription);
    pty.onExit.mockReturnValueOnce(exitSubscription);
    addInputListener.mockImplementationOnce(() => {
      throw setupError;
    });

    expect(
      () =>
        new TakeoverHunk({
          command: "hunk",
          args: ["diff"],
          cwd: "/repo",
          tui,
          done: vi.fn(),
          rawInputSource: raw.source,
        }),
    ).toThrow(setupError);

    expect(dataSubscription.dispose).toHaveBeenCalledOnce();
    expect(exitSubscription.dispose).toHaveBeenCalledOnce();
    expect(pty.dispose).toHaveBeenCalledOnce();
    expect(raw.release).toHaveBeenCalledOnce();
    expect(raw.active()).toBe(false);
    expect(listeners.size).toBe(0);
    expect(countOutput(terminalWrite, LEAVE_ALT_SCREEN)).toBe(1);
    expect(requestRender.mock.calls).toEqual([[true]]);
    expect(tui.requestRender).toBe(requestRender);
    expect(tuiStop).toHaveBeenCalledOnce();
    expect(tuiStart).toHaveBeenCalledOnce();
  });

  it("restores Pi paint on dispose", () => {
    const { tui, requestRender } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });

    component.dispose();
    // After dispose, original requestRender is restored (may be called with force).
    tui.requestRender(true);
    expect(requestRender).toHaveBeenCalled();
  });

  it("leaves and redraws exactly once when natural exit synchronously disposes the surface", () => {
    const { tui, terminalWrite, requestRender, tuiStop, tuiStart } = makeTui();
    let component!: TakeoverHunk;
    const done = vi.fn(() => component.dispose());
    component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done,
    });
    terminalWrite.mockClear();

    exitListener()({ exitCode: 0, signal: 0 });
    exitListener()({ exitCode: 0, signal: 0 });
    component.dispose();

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ exitCode: 0, signal: 0 });
    expect(countOutput(terminalWrite, LEAVE_ALT_SCREEN)).toBe(1);
    expect(requestRender.mock.calls).toEqual([[true]]);
    expect(tuiStop).toHaveBeenCalledOnce();
    expect(tuiStart).toHaveBeenCalledOnce();
  });

  it("makes the surface close sequence setVisible(false) plus dispose idempotent", () => {
    const { tui, terminalWrite, requestRender, tuiStop, tuiStart } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    terminalWrite.mockClear();

    component.setVisible(false);
    component.dispose();
    component.dispose();

    expect(countOutput(terminalWrite, LEAVE_ALT_SCREEN)).toBe(1);
    expect(requestRender.mock.calls).toEqual([[true]]);
    expect(tuiStop).toHaveBeenCalledOnce();
    expect(tuiStart).toHaveBeenCalledOnce();
  });

  it("does not leave or redraw again when a hidden child exits", () => {
    const { tui, terminalWrite, requestRender, tuiStop, tuiStart } = makeTui();
    let component!: TakeoverHunk;
    const done = vi.fn(() => component.dispose());
    component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done,
    });
    terminalWrite.mockClear();

    component.setVisible(false);
    exitListener()({ exitCode: 17, signal: 0 });

    expect(done).toHaveBeenCalledOnce();
    expect(countOutput(terminalWrite, LEAVE_ALT_SCREEN)).toBe(1);
    expect(requestRender.mock.calls).toEqual([[true]]);
    expect(tuiStop).toHaveBeenCalledOnce();
    expect(tuiStart).toHaveBeenCalledOnce();
  });

  it("suspends startup timeouts while hidden and grants a fresh deadline on resume", () => {
    vi.useFakeTimers();
    try {
      const { tui } = makeTui();
      const done = vi.fn();
      const raw = makeRawInputSource();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done,
        rawInputSource: raw.source,
        startupFrameDeadlineMs: 25,
      });

      const onData = (
        pty.onData.mock.calls as unknown as Array<[(data: string | Uint8Array) => void]>
      )[0]![0];
      expect(raw.active()).toBe(true);
      onData("pre-hide-partial-output");
      vi.advanceTimersByTime(10);
      component.setVisible(false);
      expect(raw.active()).toBe(false);

      vi.advanceTimersByTime(1_000);
      expect(done).not.toHaveBeenCalled();
      expect(pty.dispose).not.toHaveBeenCalled();

      component.setVisible(true);
      expect(raw.source.acquire).toHaveBeenCalledTimes(2);
      expect(raw.active()).toBe(true);
      vi.advanceTimersByTime(24);
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(done).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 124 }));
      expect(raw.active()).toBe(false);
      expect(pty.dispose).toHaveBeenCalledOnce();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves, redraws, completes, and disposes exactly once on startup timeout", () => {
    vi.useFakeTimers();
    try {
      const { tui, terminalWrite, requestRender, tuiStop, tuiStart } = makeTui();
      const done = vi.fn();
      const component = new TakeoverHunk({
        command: "hunk",
        args: ["diff"],
        cwd: "/repo",
        tui,
        done,
        startupFrameDeadlineMs: 25,
      });
      terminalWrite.mockClear();

      vi.advanceTimersByTime(25);

      expect(done).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledWith({
        exitCode: 124,
        signal: 0,
        detail: "Hunk takeover failed: no complete startup frame within 25ms.",
      });
      expect(pty.dispose).toHaveBeenCalledOnce();
      expect(countOutput(terminalWrite, LEAVE_ALT_SCREEN)).toBe(1);
      expect(requestRender.mock.calls).toEqual([[true]]);
      expect(tuiStop).toHaveBeenCalledOnce();
      expect(tuiStart).toHaveBeenCalledOnce();
      component.dispose();
      expect(pty.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the host terminal so paste and keyboard modes precede the forced redraw", () => {
    const { tui, terminalWrite, terminalStop, terminalStart, requestRender } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    terminalWrite.mockClear();

    component.dispose();

    const output = terminalWrite.mock.calls.flat().join("");
    expect(terminalStop).toHaveBeenCalledOnce();
    expect(terminalStart).toHaveBeenCalledOnce();
    expect(output).toContain(HOST_STOP_MODES);
    expect(output).toContain(HOST_START_MODES);
    expect(output).toContain("\x1b[?25h");
    expect(output).toContain("\x1b[?7h");
    expect(countOutput(terminalWrite, "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l")).toBe(1);
    expect(output.indexOf(HOST_STOP_MODES)).toBeLessThan(output.indexOf(LEAVE_ALT_SCREEN));
    expect(output.indexOf(LEAVE_ALT_SCREEN)).toBeLessThan(output.indexOf(HOST_START_MODES));
    expect(requestRender.mock.calls).toEqual([[true]]);
  });

  it("contains a throwing late PTY write inside the input listener", () => {
    const { tui, listeners } = makeTui();
    const component = new TakeoverHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      done: vi.fn(),
    });
    pty.write.mockImplementationOnce(() => {
      throw new Error("PTY already exited");
    });
    const [listener] = [...listeners];

    expect(() => listener!("late input")).not.toThrow();
    expect(listener!("next input")).toEqual({ consume: true });
    expect(pty.write).toHaveBeenNthCalledWith(1, "late input");
    expect(pty.write).toHaveBeenNthCalledWith(2, "next input");
    component.dispose();
  });
});

describe("resolveOverlayHostMode", () => {
  it("maps layout to takeover, exclusive, or embed", () => {
    expect(resolveOverlayHostMode({ layout: "full" })).toBe("takeover");
    expect(resolveOverlayHostMode({ layout: "right" })).toBe("exclusive");
    expect(resolveOverlayHostMode({ layout: "left" })).toBe("exclusive");
    expect(resolveOverlayHostMode({ layout: "float" })).toBe("embed");
  });
});
