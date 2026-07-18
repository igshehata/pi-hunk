import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  createTerminal: vi.fn(() => ({
    feed: vi.fn(),
    resize: vi.fn(),
    snapshot: vi.fn(),
    getVisibleText: vi.fn(() => ""),
    formatPlain: vi.fn(() => ""),
    dispose: vi.fn(),
  })),
  spawnOverlayPty: vi.fn(),
}));

vi.mock("@coder/libghostty-vt-node", () => ({
  createTerminal: native.createTerminal,
}));

vi.mock("../extensions/overlay/pty.ts", () => ({
  spawnOverlayPty: native.spawnOverlayPty,
}));

import { EmbeddedHunk } from "../extensions/overlay/embedded.ts";

describe("EmbeddedHunk capability validation", () => {
  it("rejects a binding without formatHtml before spawning the PTY", () => {
    const terminal = native.createTerminal();
    native.createTerminal.mockReturnValueOnce(terminal);
    const tui = {
      terminal: { columns: 100, rows: 40, write: vi.fn() },
      requestRender: vi.fn(),
    } as unknown as TUI;

    expect(
      () =>
        new EmbeddedHunk({
          command: "hunk",
          args: ["diff", "--watch"],
          cwd: "/repo",
          tui,
          done: vi.fn(),
        }),
    ).toThrow("does not expose formatHtml");

    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(native.spawnOverlayPty).not.toHaveBeenCalled();
  });
});
