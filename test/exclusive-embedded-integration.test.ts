import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { installExclusiveFrame } from "../extensions/overlay/exclusive-frame.ts";
import { installExperimentalPiWrap } from "../extensions/overlay/experimental-pi-wrap.ts";

beforeEach(() => vi.clearAllMocks());

class RecordingTerminal implements Terminal {
  columns = 10;
  rows = 3;
  kittyProtocolActive = true;
  writes: string[] = [];
  onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput;
  }
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
}

class BaseProbe implements Component {
  renders = 0;
  render(width: number): string[] {
    this.renders += 1;
    return ["L".repeat(width), "L".repeat(width), "L".repeat(width)];
  }
  invalidate(): void {}
}

async function waitForRender(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await Promise.resolve();
}

describe("exclusive EmbeddedHunk integration", () => {
  it("routes ready PTY frames directly and suppresses Pi's post-input render", async () => {
    const terminal = new RecordingTerminal();
    const tui = new TUI(terminal);
    const base = new BaseProbe();
    tui.addChild(base);
    const wrap = installExperimentalPiWrap(tui, "right", true)!;
    const exclusive = installExclusiveFrame(tui, "right", true)!;
    const component = new EmbeddedHunk({
      command: "hunk",
      args: ["diff"],
      cwd: "/repo",
      tui,
      initialRows: 3,
      resolveRows: () => 3,
      exclusiveFrame: exclusive,
      done: () => undefined,
    });
    exclusive.setComponent(component);
    const handle = tui.showOverlay(component, {
      width: "50%",
      maxHeight: "100%",
      anchor: "right-center",
      margin: 0,
    });
    exclusive.setFocusProbe(() => !handle.isHidden() && handle.isFocused());
    tui.start();
    await waitForRender();

    const onData = (pty.onData.mock.calls as unknown as Array<[(data: string) => void]>)[0][0];
    onData("\x1b[?2026h\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC\x1b[?2026l");
    await waitForRender();
    expect(exclusive.getStats().state).toBe("exclusive");

    const baseRenders = base.renders;
    terminal.writes = [];
    onData("\x1b[?2026h\x1b[2;1H22222\x1b[?2026l");
    await Promise.resolve();
    expect(base.renders).toBe(baseRenders);
    expect(exclusive.getStats()).toMatchObject({
      state: "exclusive",
      directFrames: 1,
      directRows: 1,
    });
    expect(terminal.writes.join("")).toContain("\x1b[2;6H");

    // Frame N must be snapshotted and directly painted even when frame N+1
    // starts later in the same PTY chunk.
    terminal.writes = [];
    onData("\x1b[?2026h\x1b[1;1HNNNNN\x1b[?2026l" + "\x1b[?2026h\x1b[1;1HPART1");
    await Promise.resolve();
    expect(terminal.writes.join("")).toContain("NNNNN");
    expect(terminal.writes.join("")).not.toContain("PART1");
    expect(exclusive.getStats()).toMatchObject({ state: "exclusive", revocations: 0 });

    // Finish the open frame, then reproduce the cross-chunk race: the second
    // chunk opens N+1 before N's queued direct-paint microtask can read a frame.
    onData("\x1b[?2026l");
    await Promise.resolve();
    terminal.writes = [];
    onData("\x1b[?2026h\x1b[1;1HMMMMM\x1b[?2026l");
    onData("\x1b[?2026h\x1b[1;1HPART2");
    await Promise.resolve();
    expect(terminal.writes.join("")).toContain("MMMMM");
    expect(terminal.writes.join("")).not.toContain("PART2");
    expect(exclusive.getStats()).toMatchObject({ state: "exclusive", revocations: 0 });

    terminal.onInput?.("j");
    await waitForRender();
    expect(pty.write).toHaveBeenCalledWith("j");
    expect(base.renders).toBe(baseRenders);
    expect(exclusive.getStats().suppressedInputRenders).toBe(1);

    // Exclusive mode reaches the same translator through TUI terminal input.
    terminal.onInput?.("\x1b[57365;1:2u");
    terminal.onInput?.("\x1b[57365;1:3u");
    await waitForRender();
    expect(pty.write).toHaveBeenCalledWith("\x1bOQ");
    expect(pty.write).not.toHaveBeenCalledWith("\x1b[57365;1:3u");

    exclusive.setVisible(false);
    component.setVisible(false);
    handle.hide();
    component.dispose();
    exclusive.dispose();
    wrap.dispose();
    await waitForRender();
    tui.stop();
  });
});
