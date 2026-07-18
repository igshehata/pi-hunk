import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { installExperimentalPiWrap } from "../extensions/overlay/experimental-pi-wrap.ts";

class RecordingTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = true;
  writes: string[] = [];
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  clearWrites(): void {
    this.writes = [];
  }
  output(): string {
    return this.writes.join("");
  }
}

class WidthProbe implements Component {
  widths: number[] = [];
  constructor(
    private readonly label: string,
    private readonly reflow = false,
  ) {}
  render(width: number): string[] {
    this.widths.push(width);
    const lineCount = this.reflow ? (width <= 40 ? 4 : 2) : 1;
    return Array.from({ length: lineCount }, (_, index) => `${this.label}:${width}:${index}`);
  }
  invalidate(): void {}
}

async function waitForRender(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function fakeTui() {
  const render = vi.fn((width: number) => [`pi:${width}`]);
  const tui = {
    terminal: { columns: 100, rows: 40 },
    previousWidth: 100,
    render,
    invalidate: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TUI;
  return { tui, render };
}

describe("experimental Pi split wrapping", () => {
  it("narrows Pi beside a right split only while visible", () => {
    const { tui, render } = fakeTui();
    const controller = installExperimentalPiWrap(tui, "right", true)!;

    expect(tui.render(100)).toEqual(["pi:50"]);
    expect(render).toHaveBeenLastCalledWith(50);

    controller.setVisible(false);
    expect(tui.render(100)).toEqual(["pi:100"]);

    controller.setVisible(true);
    expect(tui.render(81)).toEqual(["pi:41"]);
  });

  it("pads narrowed Pi to the right of a left split", () => {
    const { tui } = fakeTui();
    const controller = installExperimentalPiWrap(tui, "left", true)!;

    expect(tui.render(100)).toEqual([`${" ".repeat(50)}pi:50`]);
    controller.dispose();
    expect(tui.render(100)).toEqual(["pi:100"]);
  });

  it("reflows and redraws through the real Pi TUI overlay pipeline", async () => {
    const terminal = new RecordingTerminal();
    const tui = new TUI(terminal);
    const base = new WidthProbe("base", true);
    const overlay = new WidthProbe("hunk");
    tui.addChild(base);
    const handle = tui.showOverlay(overlay, { width: "50%", anchor: "right-center" });
    tui.start();
    await waitForRender();
    expect(base.widths.at(-1)).toBe(80);
    expect(overlay.widths.at(-1)).toBe(40);

    const redrawsBeforeSplit = tui.fullRedraws;
    terminal.clearWrites();
    const controller = installExperimentalPiWrap(tui, "right", true)!;
    await waitForRender();
    expect(base.widths.at(-1)).toBe(40);
    expect(overlay.widths.at(-1)).toBe(40);
    expect(tui.fullRedraws).toBe(redrawsBeforeSplit);
    expect(terminal.output()).not.toContain("\x1b[2J");

    terminal.clearWrites();
    controller.setVisible(false);
    handle.setHidden(true);
    await waitForRender();
    expect(base.widths.at(-1)).toBe(80);
    expect(tui.fullRedraws).toBe(redrawsBeforeSplit);
    expect(terminal.output()).not.toContain("\x1b[2J");

    terminal.clearWrites();
    handle.setHidden(false);
    controller.setVisible(true);
    await waitForRender();
    expect(base.widths.at(-1)).toBe(40);
    expect(tui.fullRedraws).toBe(redrawsBeforeSplit);
    expect(terminal.output()).not.toContain("\x1b[2J");

    terminal.clearWrites();
    for (let index = 0; index < 5; index++) {
      controller.setVisible(false);
      handle.setHidden(true);
      await waitForRender();
      handle.setHidden(false);
      controller.setVisible(true);
      await waitForRender();
    }
    expect(tui.fullRedraws).toBe(redrawsBeforeSplit);
    expect(terminal.output()).not.toContain("\x1b[2J");

    controller.dispose();
    handle.hide();
    await waitForRender();
    expect(base.widths.at(-1)).toBe(80);
    tui.stop();
  });

  it("restores Pi's renderer when the initial reflow fails", () => {
    const { tui } = fakeTui();
    const originalRender = tui.render;
    vi.mocked(tui.requestRender).mockImplementation(() => {
      throw new Error("render scheduling failed");
    });

    expect(() => installExperimentalPiWrap(tui, "right", true)).toThrow("render scheduling failed");
    expect(tui.render).toBe(originalRender);
    expect(tui.render(100)).toEqual(["pi:100"]);
  });

  it("does nothing for non-split layouts or without explicit opt-in", () => {
    const { tui } = fakeTui();
    const originalRender = tui.render;

    expect(installExperimentalPiWrap(tui, "full", true)).toBeUndefined();
    expect(installExperimentalPiWrap(tui, "right", false)).toBeUndefined();
    expect(tui.render).toBe(originalRender);
  });
});
