import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

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

import { cloneConfig, DEFAULT_CONFIG } from "../extensions/config.ts";
import { EmbeddedHunk } from "../extensions/overlay/embedded.ts";
import { spawnOverlayPty } from "../extensions/overlay/pty.ts";
import { OverlaySurface, type OverlayComponent } from "../extensions/overlay/surface.ts";

beforeEach(() => vi.clearAllMocks());

function integrationHarness() {
  const tui = {
    terminal: { columns: 100, rows: 40, write: vi.fn() },
    previousWidth: 100,
    render: vi.fn((width: number) => [`pi:${width}`]),
    invalidate: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TUI;
  let mounted: OverlayComponent | undefined;
  let overlayOptions: Record<string, unknown> | undefined;
  const handle: OverlayHandle & { hidden: boolean } = {
    hidden: false,
    hide: vi.fn(),
    setHidden: vi.fn((hidden: boolean) => {
      handle.hidden = hidden;
    }),
    isHidden: vi.fn(() => handle.hidden),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => !handle.hidden),
  };
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    ui: {
      notify: vi.fn(),
      custom<T>(
        factory: (
          tui: TUI,
          theme: unknown,
          keybindings: unknown,
          done: (value: T) => void,
        ) => Component,
        options?: {
          overlayOptions?: Record<string, unknown>;
          onHandle?: (handle: OverlayHandle) => void;
        },
      ): Promise<T> {
        mounted = factory(tui, {}, {}, () => undefined) as OverlayComponent;
        overlayOptions = options?.overlayOptions;
        options?.onHandle?.(handle);
        return new Promise<T>(() => undefined);
      },
    },
  } as unknown as ExtensionContext;
  return {
    tui,
    ctx,
    handle,
    get mounted() {
      return mounted;
    },
    get overlayOptions() {
      return overlayOptions;
    },
  };
}

describe("critical surface + embedded Hunk integration", () => {
  it("mounts a right exclusive split and delivers overlay-local wheel/hover coordinates", async () => {
    const harness = integrationHarness();
    const surface = new OverlaySurface((options) => new EmbeddedHunk(options));
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay = { layout: "right" };

    await surface.open(
      harness.ctx,
      { cwd: "/repo", command: "hunk", args: ["diff"], source: "shortcut" },
      config,
    );

    expect(harness.overlayOptions).toEqual({
      anchor: "right-center",
      width: "50%",
      maxHeight: "100%",
      margin: 0,
    });
    expect(harness.tui.render(100)).toEqual(["pi:50"]);

    // Pi allocates/render-calls the overlay at 50 columns before mouse input.
    harness.mounted!.render(50);
    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[<65;75;20M");
    expect(pty.write).toHaveBeenCalledWith("\x1b[<65;25;20M");
    harness.mounted!.handleInput!("\x1b[<35;90;10M");
    expect(pty.write).toHaveBeenCalledWith("\x1b[<35;40;10M");

    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[<35;25;20M");
    expect(pty.write).not.toHaveBeenCalled();

    // A split owns a drag that started inside and clamps its outside drag/up.
    harness.mounted!.handleInput!("\x1b[<0;75;20M");
    harness.mounted!.handleInput!("\x1b[<32;25;20M");
    harness.mounted!.handleInput!("\x1b[<0;25;20m");
    expect(pty.write.mock.calls.map(([data]) => data)).toEqual([
      "\x1b[<0;25;20M",
      "\x1b[<32;1;20M",
      "\x1b[<0;1;20m",
    ]);

    // Losing keyboard focus is not a surface lifecycle boundary: Pi may blur
    // the component as the captured pointer leaves its rectangle.
    harness.mounted!.handleInput!("\x1b[<0;75;20M");
    (harness.mounted as EmbeddedHunk).focused = false;
    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[<0;25;20m");
    expect(pty.write).toHaveBeenCalledWith("\x1b[<0;1;20m");
    (harness.mounted as EmbeddedHunk).focused = true;

    // Hide/show is a capture lifecycle boundary; an old outside release must
    // not leak into the newly presented surface.
    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[<0;75;20M");
    await surface.hide();
    expect(harness.handle.hidden).toBe(true);
    expect(harness.tui.render(100)).toEqual(["pi:100"]);
    await surface.show();
    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[<0;25;20m");
    expect(pty.write).not.toHaveBeenCalled();
    await surface.close();
  });

  it("starts a 75% float at its resolved PTY geometry and keeps mouse rows aligned", async () => {
    const harness = integrationHarness();
    const surface = new OverlaySurface((options) => new EmbeddedHunk(options));
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay = {
      layout: "float",
    };

    await surface.open(
      harness.ctx,
      { cwd: "/repo", command: "hunk", args: ["diff"], source: "shortcut" },
      config,
    );
    // The child must never observe a transient full-terminal geometry before
    // Pi's first component render; Hunk lays out its initial frame immediately.
    expect(spawnOverlayPty).toHaveBeenCalledWith(
      expect.objectContaining({ columns: 75, rows: 30 }),
    );
    expect(pty.resize).not.toHaveBeenCalled();

    harness.mounted!.render(75);
    pty.write.mockClear();

    // Regression: without the one-row float compensation, Hunk renders the
    // hover-only comment [+] one row above the physical pointer, so moving to
    // click it changes the target. Hover and mouse-up must reach the same cell.
    harness.mounted!.handleInput!("\x1b[<35;20;10M");
    harness.mounted!.handleInput!("\x1b[<0;20;10M");
    harness.mounted!.handleInput!("\x1b[<32;100;40M");
    harness.mounted!.handleInput!("\x1b[<0;100;40m");
    expect(pty.write.mock.calls.map(([data]) => data)).toEqual([
      "\x1b[<35;8;6M",
      "\x1b[<0;8;6M",
      "\x1b[<32;75;30M",
      "\x1b[<0;75;30m",
    ]);

    // Embed mode uses the shared Kitty-to-xterm input translator.
    pty.write.mockClear();
    harness.mounted!.handleInput!("\x1b[57364;1:2u");
    harness.mounted!.handleInput!("\x1b[57364;1:3u");
    expect(pty.write.mock.calls.map(([data]) => data)).toEqual(["\x1bOP"]);
    await surface.close();
  });

  it("does not expose capability negotiation before Hunk's first real frame", async () => {
    const harness = integrationHarness();
    const surface = new OverlaySurface((options) => new EmbeddedHunk(options));

    await surface.open(
      harness.ctx,
      { cwd: "/repo", command: "hunk", args: ["diff"], source: "shortcut" },
      cloneConfig(DEFAULT_CONFIG),
    );
    const onData = (pty.onData.mock.calls as unknown as Array<[(data: string) => void]>)[0][0];
    onData("\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x07\x1b[?2026$p\x1b[6n");
    expect(harness.mounted!.render(100)[0]).toContain("Starting Hunk");

    onData("\x1b[?2026h\x1b[1;1Hready\x1b[?2026l");
    await Promise.resolve();
    expect(harness.mounted!.render(100).join("\n")).toContain("ready");
    await surface.close();
  });
});
