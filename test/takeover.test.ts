import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";

const pty = vi.hoisted(() => ({
  write: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  pid: 4242,
}));

vi.mock("../extensions/overlay/pty.ts", () => ({
  spawnOverlayPty: vi.fn(() => pty),
}));

import { TakeoverHunk } from "../extensions/overlay/takeover.ts";
import { resolveOverlayHostMode } from "../extensions/config.ts";

beforeEach(() => {
  vi.clearAllMocks();
  pty.onData.mockReturnValue({ dispose: vi.fn() });
  pty.onExit.mockReturnValue({ dispose: vi.fn() });
});

function makeTui() {
  const terminalWrite = vi.fn();
  const requestRender = vi.fn();
  const terminal = { columns: 80, rows: 24, write: terminalWrite };
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const tui = {
    terminal,
    requestRender,
    addInputListener: vi.fn((listener: (data: string) => { consume?: boolean } | undefined) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as TUI & {
    requestRender: ReturnType<typeof vi.fn>;
  };
  return { tui, terminal, terminalWrite, requestRender, listeners };
}

describe("TakeoverHunk", () => {
  it("writes PTY data to the real terminal and does not request Pi paints", () => {
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
    onData("hello-from-hunk");
    expect(terminalWrite).toHaveBeenCalledWith("hello-from-hunk");
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

  it("forces a real resize transition and redraw when an unchanged takeover resumes", () => {
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

    onData("initial-frame");
    component.setVisible(false);
    onData("discarded-while-hidden");
    terminalWrite.mockClear();
    pty.resize.mockClear();
    pty.resize
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => onData("fresh-frame"));

    component.setVisible(true);

    expect(pty.resize.mock.calls).toEqual([
      [80, 23],
      [80, 24],
    ]);
    const resumedOutput = terminalWrite.mock.calls.flat().join("");
    expect(resumedOutput).toContain("Restoring Hunk…");
    expect(resumedOutput).toContain("fresh-frame");
    expect(resumedOutput).not.toContain("discarded-while-hidden");
    component.dispose();
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
    expect(pty.write).toHaveBeenCalledWith("j");

    component.dispose();
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
});

describe("resolveOverlayHostMode", () => {
  it("maps layout to takeover, exclusive, or embed", () => {
    expect(resolveOverlayHostMode({ layout: "full" })).toBe("takeover");
    expect(resolveOverlayHostMode({ layout: "right" })).toBe("exclusive");
    expect(resolveOverlayHostMode({ layout: "left" })).toBe("exclusive");
    expect(resolveOverlayHostMode({ layout: "float" })).toBe("embed");
  });
});
