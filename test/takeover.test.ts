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
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const tui = {
    terminal: { columns: 80, rows: 24, write: terminalWrite },
    requestRender,
    addInputListener: vi.fn((listener: (data: string) => { consume?: boolean } | undefined) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as TUI & {
    requestRender: ReturnType<typeof vi.fn>;
  };
  return { tui, terminalWrite, requestRender, listeners };
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

    const onData = (pty.onData.mock.calls as unknown as Array<[(data: string) => void]>)[0][0];
    terminalWrite.mockClear();
    onData("hello-from-hunk");
    expect(terminalWrite).toHaveBeenCalledWith("hello-from-hunk");
    expect(requestRender).not.toHaveBeenCalled();

    // Pi paint path is suspended: patched requestRender is a no-op.
    tui.requestRender();
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
