import { createTerminal } from "@coder/libghostty-vt-node";
import { TUI, type Component, type Focusable, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  installExclusiveFrame,
  type ExclusiveFrameController,
  type HunkDirectFrame,
} from "../extensions/overlay/exclusive-frame.ts";

class RecordingTerminal implements Terminal {
  columns = 10;
  rows = 3;
  kittyProtocolActive = true;
  writes: string[] = [];
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class EmulatingTerminal extends RecordingTerminal {
  readonly virtualTerminal = createTerminal({
    cols: this.columns,
    rows: this.rows,
    scrollbackLimit: 20,
  });

  override write(data: string): void {
    super.write(data);
    this.virtualTerminal.feed(data);
  }
  override moveBy(lines: number): void {
    if (lines > 0) this.virtualTerminal.feed(`\x1b[${lines}B`);
    else if (lines < 0) this.virtualTerminal.feed(`\x1b[${-lines}A`);
  }
  override hideCursor(): void {
    this.virtualTerminal.feed("\x1b[?25l");
  }
  override showCursor(): void {
    this.virtualTerminal.feed("\x1b[?25h");
  }
  override clearLine(): void {
    this.virtualTerminal.feed("\x1b[2K");
  }
  override clearFromCursor(): void {
    this.virtualTerminal.feed("\x1b[J");
  }
  override clearScreen(): void {
    this.virtualTerminal.feed("\x1b[2J\x1b[H");
  }
  visibleLines(): string[] {
    const snapshot = this.virtualTerminal.snapshot();
    return Array.from({ length: snapshot.rows }, (_, row) => {
      return snapshot.visibleLines.find((line) => line.row === row)?.text ?? "";
    });
  }
  dispose(): void {
    this.virtualTerminal.dispose();
  }
}

class BaseProbe implements Component {
  renders = 0;

  constructor(private readonly terminal: RecordingTerminal) {}

  render(width: number): string[] {
    this.renders += 1;
    return Array.from({ length: this.terminal.rows }, () => "L".repeat(width));
  }

  invalidate(): void {}
}

class HunkProbe implements Component, Focusable {
  renders = 0;
  rows = ["AAAAA", "BBBBB", "CCCCC"];
  private focusState = false;

  constructor(
    private readonly terminal: RecordingTerminal,
    private readonly controller: ExclusiveFrameController,
  ) {}

  get focused(): boolean {
    return this.focusState;
  }

  set focused(focused: boolean) {
    if (focused === this.focusState) return;
    this.focusState = focused;
    this.controller.setFocused(focused);
  }

  frame(width: number): HunkDirectFrame {
    const lines = Array.from({ length: this.terminal.rows }, (_, index) => {
      const source = this.rows[index] ?? "";
      return source.slice(0, width).padEnd(width);
    });
    return {
      ready: true,
      columns: width,
      rows: this.terminal.rows,
      lines,
    };
  }

  render(width: number): string[] {
    this.renders += 1;
    const frame = this.frame(width);
    this.controller.observeCompositedFrame(frame);
    return [...frame.lines];
  }

  invalidate(): void {}
}

class DialogProbe implements Component, Focusable {
  focused = false;
  render(width: number): string[] {
    return ["dialog".slice(0, width)];
  }
  invalidate(): void {}
}

async function waitForRender(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await Promise.resolve();
}

function realHarness(
  layout: "left" | "right" = "right",
  terminal: RecordingTerminal = new RecordingTerminal(),
) {
  const tui = new TUI(terminal);
  const originalMethods = {
    requestRender: tui.requestRender,
    invalidate: tui.invalidate,
    stop: tui.stop,
    write: terminal.write,
    hideCursor: terminal.hideCursor,
  };
  const base = new BaseProbe(terminal);
  tui.addChild(base);
  const controller = installExclusiveFrame(tui, layout, true)!;
  const hunk = new HunkProbe(terminal, controller);
  controller.setComponent(hunk);
  const handle = tui.showOverlay(hunk, {
    width: "50%",
    maxHeight: "100%",
    anchor: layout === "right" ? "right-center" : "left-center",
    margin: 0,
  });
  controller.setFocusProbe(() => !handle.isHidden() && handle.isFocused());
  tui.start();
  return { terminal, tui, base, controller, hunk, handle, originalMethods };
}

describe("exclusive frozen-frame controller", () => {
  it("acquires after a composed frame and paints PTY-only changes without Pi", async () => {
    const harness = realHarness();
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");

    const baseRenders = harness.base.renders;
    const hunkRenders = harness.hunk.renders;
    harness.hunk.rows[1] = "22222";
    expect(harness.controller.requestDirectPaint(() => harness.hunk.frame(5))).toBe(true);
    await Promise.resolve();

    expect(harness.base.renders).toBe(baseRenders);
    expect(harness.hunk.renders).toBe(hunkRenders);
    expect(harness.controller.getStats()).toMatchObject({
      state: "exclusive",
      directFrames: 1,
      directRows: 1,
    });
    expect(harness.terminal.writes.at(-1)).toContain("\x1b[2;6H");

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    harness.tui.stop();
  });

  it("matches the final virtual screen before and after authoritative restoration", async () => {
    const terminal = new EmulatingTerminal();
    const harness = realHarness("right", terminal);
    try {
      await waitForRender();
      expect(terminal.visibleLines()).toEqual(["LLLLLAAAAA", "LLLLLBBBBB", "LLLLLCCCCC"]);

      harness.hunk.rows[1] = "22222";
      expect(harness.controller.requestDirectPaint(() => harness.hunk.frame(5))).toBe(true);
      await Promise.resolve();
      expect(terminal.visibleLines()).toEqual(["LLLLLAAAAA", "LLLLL22222", "LLLLLCCCCC"]);

      harness.controller.setVisible(false);
      harness.handle.setHidden(true);
      await waitForRender();
      expect(terminal.visibleLines()).toEqual(["LLLLLLLLLL", "LLLLLLLLLL", "LLLLLLLLLL"]);

      harness.handle.hide();
      harness.controller.dispose();
      await waitForRender();
      harness.tui.stop();
    } finally {
      terminal.dispose();
    }
  });

  it("suppresses exactly one synchronous post-input render", async () => {
    const harness = realHarness();
    await waitForRender();
    const renders = harness.base.renders;

    harness.controller.armPostInputRenderSuppression();
    harness.tui.requestRender();
    await waitForRender();
    expect(harness.base.renders).toBe(renders);
    expect(harness.controller.getStats()).toMatchObject({
      state: "exclusive",
      suppressedInputRenders: 1,
    });

    harness.controller.armPostInputRenderSuppression();
    await Promise.resolve();
    harness.tui.requestRender();
    await waitForRender();
    expect(harness.base.renders).toBeGreaterThan(renders);
    expect(harness.controller.getStats().revocations).toBeGreaterThanOrEqual(1);

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    harness.tui.stop();
  });

  it("revokes for foreign overlays and resumes only after authoritative restoration", async () => {
    const harness = realHarness();
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");

    const dialog = new DialogProbe();
    const dialogHandle = harness.tui.showOverlay(dialog, { width: 6, anchor: "center" });
    await waitForRender();
    expect(harness.hunk.focused).toBe(false);
    expect(harness.controller.getStats().state).toBe("inactive");
    expect(harness.controller.requestDirectPaint(() => harness.hunk.frame(5))).toBe(false);

    dialogHandle.hide();
    await waitForRender();
    expect(harness.hunk.focused).toBe(true);
    expect(harness.controller.getStats().state).toBe("exclusive");

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    harness.tui.stop();
  });

  it("revokes on resize and foreign terminal writes, then can reacquire", async () => {
    const harness = realHarness();
    await waitForRender();
    const initialRevocations = harness.controller.getStats().revocations;

    harness.terminal.columns = 11;
    harness.terminal.rows = 4;
    harness.tui.requestRender();
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");
    expect(harness.controller.getStats().revocations).toBeGreaterThan(initialRevocations);

    harness.terminal.write("foreign-output");
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");
    expect(harness.controller.getStats().lastRevocation).toBe("terminal-write");

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    harness.tui.stop();
  });

  it("falls back after a direct-paint failure and restores through Pi", async () => {
    const harness = realHarness();
    await waitForRender();
    const baseRenders = harness.base.renders;

    expect(
      harness.controller.requestDirectPaint(() => ({
        ready: true,
        columns: 5,
        rows: 3,
        lines: ["AAAAA", "\x1b[2J", "CCCCC"],
      })),
    ).toBe(true);
    await waitForRender();

    expect(harness.base.renders).toBeGreaterThan(baseRenders);
    expect(harness.controller.getStats()).toMatchObject({
      state: "exclusive",
      lastRevocation: "direct-paint-failed",
    });
    expect(harness.terminal.writes.join("")).not.toContain("\x1b[?1006l");

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    harness.tui.stop();
  });

  it("fails closed when a later extension replaces an owned method", async () => {
    const harness = realHarness();
    await waitForRender();
    const laterWrite = (data: string): void => {
      harness.terminal.writes.push(`later:${data}`);
    };
    harness.terminal.write = laterWrite;

    expect(harness.controller.requestDirectPaint(() => harness.hunk.frame(5))).toBe(false);
    await waitForRender();
    expect(harness.controller.getStats().state).not.toBe("exclusive");

    harness.controller.dispose();
    expect(harness.terminal.write).toBe(laterWrite);
    harness.handle.hide();
    harness.tui.stop();
  });

  it("restores terminal modes, including mouse reporting, on active TUI stop", async () => {
    const harness = realHarness();
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");
    harness.terminal.writes = [];

    harness.tui.stop();

    const output = harness.terminal.writes.join("");
    expect(output).toContain("\x1b[?2026l");
    expect(output).toContain("\x1b[?7h");
    expect(output).toContain("\x1b[?25h");
    expect(output).toContain("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    expect(harness.tui.requestRender).toBe(harness.originalMethods.requestRender);
    expect(harness.terminal.write).toBe(harness.originalMethods.write);
    harness.handle.hide();
  });

  it("restores only owned methods on disposal", async () => {
    const harness = realHarness("left");
    await waitForRender();
    expect(harness.controller.getStats().state).toBe("exclusive");

    harness.handle.hide();
    harness.controller.dispose();
    await waitForRender();
    expect(harness.tui.requestRender).toBe(harness.originalMethods.requestRender);
    expect(harness.tui.invalidate).toBe(harness.originalMethods.invalidate);
    expect(harness.tui.stop).toBe(harness.originalMethods.stop);
    expect(harness.terminal.write).toBe(harness.originalMethods.write);
    expect(harness.terminal.hideCursor).toBe(harness.originalMethods.hideCursor);
    harness.tui.stop();
  });

  it("fails closed on unsupported Pi internals", () => {
    const tui = {
      terminal: new RecordingTerminal(),
      requestRender() {},
      invalidate() {},
      stop() {},
    } as unknown as TUI;
    expect(() => installExclusiveFrame(tui, "right", true)).toThrow("incompatible");
  });
});
