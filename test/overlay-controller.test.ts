import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { cloneConfig, DEFAULT_CONFIG } from "../extensions/config.ts";
import type { EmbeddedOptions } from "../extensions/overlay/embedded.ts";
import { OverlaySurface, type OverlayComponent } from "../extensions/overlay/surface.ts";
import {
  resolveOverlayRows,
  type OpenRequest,
  type SurfaceState,
} from "../extensions/overlay/types.ts";

type FakeHandle = OverlayHandle & {
  id: number;
  hidden: boolean;
  focused: boolean;
  removed: boolean;
};

interface FakeComponent extends OverlayComponent {
  id: number;
  visible: boolean;
  disposed: boolean;
  options: EmbeddedOptions;
}

function request(args = ["diff", "--watch"]): OpenRequest {
  return {
    cwd: "/repo",
    command: "hunk",
    args,
    source: "manual",
  };
}

/**
 * Test harness that mirrors Pi 0.80.6 overlay semantics:
 * - done() calls global hideOverlay() of the TOPMOST overlay only
 * - OverlayHandle.hide() removes THIS entry by identity
 * - optional microtask-delayed mount (autoHandle=false)
 */
function createHarness(options: { autoHandle?: boolean; delayedMount?: boolean } = {}) {
  const autoHandle = options.autoHandle !== false;
  const delayedMount = Boolean(options.delayedMount);
  const events: string[] = [];
  const handles: FakeHandle[] = [];
  const components: FakeComponent[] = [];
  const stack: FakeHandle[] = [];
  const overlayOptions: Array<Record<string, unknown> | undefined> = [];
  const pendingMounts: Array<() => void> = [];
  let nextId = 1;
  const tui = {
    terminal: { columns: 100, rows: 40, write: vi.fn() },
    previousWidth: 100,
    render: vi.fn((width: number) => [`pi:${width}`]),
    invalidate: vi.fn(),
    requestRender: vi.fn(),
  };

  const hideTopmost = () => {
    const top = stack.pop();
    if (!top) return;
    top.removed = true;
    top.hidden = true;
    events.push(`global:hideOverlay:${top.id}`);
  };

  const createComponent = vi.fn((opts: EmbeddedOptions): FakeComponent => {
    const id = nextId++;
    const component: FakeComponent = {
      id,
      options: opts,
      pid: 9000 + id,
      visible: true,
      disposed: false,
      render: () => ["hunk"],
      invalidate: () => undefined,
      setVisible(visible: boolean) {
        this.visible = visible;
        events.push(`component:${this.id}:${visible}`);
      },
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        events.push(`component:dispose:${this.id}`);
      },
    };
    return component;
  });

  const ctx = {
    cwd: "/repo",
    mode: "tui",
    ui: {
      notify: vi.fn(),
      custom<T>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => Component & { dispose?(): void },
        customOptions?: {
          overlayOptions?: Record<string, unknown>;
          onHandle?: (handle: OverlayHandle) => void;
        },
      ): Promise<T> {
        overlayOptions.push(customOptions?.overlayOptions);
        let resolve!: (result: T) => void;
        let reject!: (error: unknown) => void;
        let settled = false;
        let closed = false;
        const lifetime = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });

        // Pi's done() for overlays: global hideOverlay of TOPMOST only.
        const done = (result: T) => {
          if (settled) return;
          settled = true;
          closed = true;
          hideTopmost();
          // Dispose whatever is currently top after hide — Pi disposes the factory component var.
          resolve(result);
        };

        // Pi evaluates factory(...) synchronously inside Promise.resolve(factory(...)).
        let component: (Component & { dispose?(): void }) | undefined;
        try {
          component = factory(tui, {}, {}, done);
        } catch (error) {
          settled = true;
          reject(error);
          return lifetime;
        }

        components.push(component as FakeComponent);

        const publishHandle = () => {
          // Pi's .then: if already closed, return without disposing / without showOverlay.
          if (closed) return;

          const handle: FakeHandle = {
            id: (component as FakeComponent).id,
            hidden: false,
            focused: true,
            removed: false,
            hide: vi.fn(() => {
              const index = stack.indexOf(handle);
              if (index === -1) return;
              stack.splice(index, 1);
              handle.removed = true;
              handle.hidden = true;
              events.push(`handle:hide:${handle.id}`);
            }),
            setHidden: vi.fn((hidden: boolean) => {
              handle.hidden = hidden;
              handle.focused = !hidden;
              events.push(`handle:hidden:${handle.id}:${hidden}`);
            }),
            isHidden: vi.fn(() => handle.hidden),
            focus: vi.fn(() => {
              handle.focused = true;
              events.push(`handle:focus:${handle.id}`);
            }),
            unfocus: vi.fn(() => {
              handle.focused = false;
              events.push(`handle:unfocus:${handle.id}`);
            }),
            isFocused: vi.fn(() => handle.focused),
          };
          handles.push(handle);
          stack.push(handle);
          customOptions?.onHandle?.(handle);
        };

        if (autoHandle && !delayedMount) {
          publishHandle();
        } else if (delayedMount) {
          // Match Pi's Promise.resolve(factory).then(showOverlay/onHandle) microtask.
          pendingMounts.push(publishHandle);
          queueMicrotask(() => {
            const next = pendingMounts.shift();
            next?.();
          });
        } else {
          pendingMounts.push(publishHandle);
        }

        return lifetime;
      },
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    events,
    handles,
    components,
    stack,
    overlayOptions,
    tui,
    createComponent,
    releaseHandle: () => pendingMounts.shift()?.(),
    /** Push a second overlay above Hunk (simulates a dialog). */
    pushForeignOverlay(): FakeHandle {
      const id = nextId++;
      const handle: FakeHandle = {
        id,
        hidden: false,
        focused: true,
        removed: false,
        hide: vi.fn(() => {
          const index = stack.indexOf(handle);
          if (index === -1) return;
          stack.splice(index, 1);
          handle.removed = true;
          events.push(`handle:hide:${id}`);
        }),
        setHidden: vi.fn(),
        isHidden: vi.fn(() => handle.hidden),
        focus: vi.fn(),
        unfocus: vi.fn(),
        isFocused: vi.fn(() => handle.focused),
      };
      stack.push(handle);
      handles.push(handle);
      events.push(`foreign:push:${id}`);
      return handle;
    },
  };
}

describe("OverlaySurface state machine", () => {
  it("wires the prefix so the focused component can hide the surface", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    expect(surface.getState()).toBe("visible");

    const options = harness.components[0]?.options;
    expect(options?.prefixKey).toBe("ctrl+space");
    expect(options?.toggleKey).toBe("h");
    expect(options?.onToggleRequest).toBeTypeOf("function");

    // Simulates the embedded prefix dispatcher selecting h while Hunk owns focus.
    options?.onToggleRequest?.();
    expect(surface.getState()).toBe("hidden");
    expect(harness.components[0]?.visible).toBe(false);
    expect(harness.handles[0]?.hidden).toBe(true);

    await surface.close();
  });

  it("replaces a focused diff with show, then hides show when repeated", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    const options = harness.components[0]?.options;
    expect(options?.prefixKey).toBe("ctrl+space");
    expect(options?.showKey).toBe("s");
    expect(options?.onShowRequest).toBeTypeOf("function");

    options?.onShowRequest?.();
    await vi.waitFor(() => expect(harness.components).toHaveLength(2));
    expect(harness.components[1]?.options.args).toEqual(["show"]);
    expect(surface.getState()).toBe("visible");

    harness.components[1]?.options.onShowRequest?.();
    await vi.waitFor(() => expect(surface.getState()).toBe("hidden"));
    expect(harness.components).toHaveLength(2);

    await surface.close();
  });

  it("switches a focused show review back to diff through the request state machine", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(["show"]), config);
    harness.components[0]?.options.onToggleRequest?.();

    await vi.waitFor(() => expect(harness.components).toHaveLength(2));
    expect(harness.components[0]?.disposed).toBe(true);
    expect(harness.components[1]?.options.args).toEqual(["diff", "--watch"]);
    expect(surface.getState()).toBe("visible");

    await surface.close();
  });

  it("replaces a hidden show review when toggle requests the default diff", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(["show"]), config);
    await surface.hide();
    await surface.toggle(harness.ctx, { ...request(config.hunk.args), source: "shortcut" }, config);

    expect(harness.components).toHaveLength(2);
    expect(harness.components[0]?.disposed).toBe(true);
    expect(harness.components[1]?.options.args).toEqual(["diff", "--watch"]);
    expect(surface.getState()).toBe("visible");
    expect(surface.getInfo()?.argsKey).toContain("--watch");

    await surface.close();
  });

  it("passes every named layout through Pi's real overlay option shape", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);
    const expected = [
      ["full", { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 }],
      ["left", { anchor: "left-center", width: "50%", maxHeight: "100%", margin: 0 }],
      ["right", { anchor: "right-center", width: "50%", maxHeight: "100%", margin: 0 }],
      ["float", { anchor: "center", width: "75%", maxHeight: "75%", margin: 0 }],
    ] as const;

    for (const [layout, options] of expected) {
      config.overlay.layout = layout;
      await surface.open(harness.ctx, request(["diff", layout]), config);
      expect(harness.overlayOptions.at(-1)).toEqual(options);
      await surface.close();
    }
  });

  it("resolves overlay-local mouse viewports for split and floating layouts", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay.layout = "right";

    await surface.open(harness.ctx, request(), config);
    expect(harness.components[0]?.options.resolveMouseViewport?.(100, 40, 50, 40)).toEqual({
      column: 50,
      row: 0,
      width: 50,
      height: 40,
    });
    await surface.close();

    config.overlay.layout = "float";
    await surface.open(harness.ctx, request(), config);
    expect(harness.components[1]?.options.resolveMouseViewport?.(100, 40, 75, 30)).toEqual({
      column: 12,
      row: 4,
      width: 75,
      height: 30,
    });
    await surface.close();
  });

  it("experimentally reflows Pi only while a split overlay is visible", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay = { layout: "right", experimentalPiWrap: true };

    await surface.open(harness.ctx, request(), config);
    expect(harness.tui.render(100)).toEqual(["pi:50"]);

    await surface.hide();
    expect(harness.tui.render(100)).toEqual(["pi:100"]);

    await surface.show();
    expect(harness.tui.render(100)).toEqual(["pi:50"]);

    await surface.close();
    expect(harness.tui.render(100)).toEqual(["pi:100"]);
  });

  it("finishes closing when experimental renderer disposal throws", async () => {
    const harness = createHarness();
    const originalRender = harness.tui.render;
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay = { layout: "right", experimentalPiWrap: true };

    await surface.open(harness.ctx, request(), config);
    harness.tui.requestRender.mockImplementation(() => {
      throw new Error("render scheduling failed");
    });

    await expect(surface.close()).resolves.toBeUndefined();
    expect(surface.getState()).toBe("closed");
    expect(surface.getInfo()).toBeNull();
    expect(harness.components[0]?.disposed).toBe(true);
    expect(harness.tui.render).toBe(originalRender);
  });

  it("ignores a stale toggle callback after the surface was reopened", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    const staleToggle = harness.components[0]?.options.onToggleRequest;
    await surface.close();
    await surface.open(harness.ctx, request(["show", "HEAD"]), config);

    staleToggle?.();
    expect(surface.getState()).toBe("visible");

    await surface.close();
  });

  it("exposes the managed child pid in session info", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);

    expect(surface.getInfo()?.pid).toBe(9001);

    await surface.close();
  });

  it("opens, hides, shows, focuses, and closes via owned handle + dispose (never done)", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    expect(surface.getState()).toBe("visible");
    expect(harness.createComponent).toHaveBeenCalledOnce();

    harness.events.length = 0;
    await surface.hide();
    expect(surface.getState()).toBe("hidden");
    expect(harness.components[0]?.visible).toBe(false);
    expect(harness.events).toEqual(["component:1:false", "handle:hidden:1:true"]);

    harness.events.length = 0;
    await surface.show();
    expect(surface.getState()).toBe("visible");
    expect(harness.components[0]?.visible).toBe(true);
    expect(harness.events).toEqual(["handle:hidden:1:false", "component:1:true"]);
    expect(harness.handles[0]?.focus).not.toHaveBeenCalled();
    expect(harness.handles[0]?.unfocus).not.toHaveBeenCalled();

    harness.events.length = 0;
    await surface.close();
    expect(surface.getState()).toBe("closed");
    expect(harness.components[0]?.disposed).toBe(true);
    // Owned path: handle.hide + dispose — NOT global hideOverlay.
    expect(harness.events).toEqual(["component:1:false", "handle:hide:1", "component:dispose:1"]);
    expect(harness.events.some((e) => e.startsWith("global:hideOverlay"))).toBe(false);
    expect(harness.stack).toHaveLength(0);

    await surface.close();
    expect(harness.events).toEqual(["component:1:false", "handle:hide:1", "component:dispose:1"]);
  });

  it("coalesces duplicate concurrent starts", async () => {
    const harness = createHarness({ autoHandle: false });
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    const first = surface.open(harness.ctx, request(), config);
    const duplicate = surface.open(harness.ctx, request(), config);
    expect(harness.createComponent).toHaveBeenCalledOnce();
    expect(surface.getState()).toBe("starting");

    harness.releaseHandle();
    await Promise.all([first, duplicate]);
    expect(surface.getState()).toBe("visible");
    expect(harness.createComponent).toHaveBeenCalledOnce();

    await surface.close();
  });

  it("restarts for identical argv launched from a different cwd", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.ensure(harness.ctx, request(), config);
    await surface.ensure(harness.ctx, { ...request(), cwd: "/repo-b" }, config);

    expect(harness.components).toHaveLength(2);
    expect(harness.components[0]?.disposed).toBe(true);
    expect(harness.components[1]?.options.cwd).toBe("/repo-b");
    expect(surface.getInfo()).toMatchObject({ launchCwd: "/repo-b" });

    await surface.close();
  });

  it("restarts predictably for different args and ignores stale child completion", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.ensure(harness.ctx, request(["diff", "--watch"]), config);
    const firstDone = harness.components[0]!.options.done;
    await surface.ensure(harness.ctx, request(["diff", "--staged"]), config);

    expect(harness.createComponent).toHaveBeenCalledTimes(2);
    expect(harness.components[0]?.disposed).toBe(true);
    expect(surface.getState()).toBe("visible");
    expect(surface.getInfo()?.argsKey).toContain("--staged");

    firstDone({ exitCode: 9 });
    await Promise.resolve();
    expect(surface.getState()).toBe("visible");
    expect(harness.components[1]?.disposed).toBe(false);

    await surface.close();
  });

  it("returns to closed and restores Pi rendering when component creation fails", async () => {
    const harness = createHarness();
    const originalRender = harness.tui.render;
    const surface = new OverlaySurface(() => {
      throw new Error("pty spawn failed");
    });
    const config = cloneConfig(DEFAULT_CONFIG);
    config.overlay = { layout: "right", experimentalPiWrap: true };

    await expect(surface.open(harness.ctx, request(), config)).rejects.toThrow("pty spawn failed");
    expect(surface.getState()).toBe("closed");
    expect(harness.tui.render).toBe(originalRender);
  });

  it("cancels microtask-delayed mount without hanging open() and disposes the local component", async () => {
    const harness = createHarness({ delayedMount: true });
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    const openPromise = surface.open(harness.ctx, request(), config);
    expect(surface.getState()).toBe("starting");

    // Cancel before Pi's microtask onHandle runs.
    const closePromise = surface.close();
    await Promise.all([openPromise, closePromise]);

    expect(surface.getState()).toBe("closed");
    // Local component was created by the sync factory and must be disposed.
    // (Pi would not dispose it when closed before .then assignment.)
    await Promise.resolve(); // flush microtask mount
    await Promise.resolve();

    // Any late mount must not leave the surface live or leak a stack entry.
    expect(surface.getState()).toBe("closed");
    expect(surface.isLive()).toBe(false);
    // Stale onHandle should have hidden the entry if it mounted.
    for (const handle of harness.handles) {
      expect(handle.removed || !harness.stack.includes(handle)).toBe(true);
    }
    // Components created must be disposed.
    for (const component of harness.components) {
      expect(component.disposed).toBe(true);
    }
  });

  it("stacked overlay: Hunk close removes only its own handle/component, not the dialog above", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    const hunkHandle = harness.handles[0]!;
    expect(hunkHandle.removed).toBe(false);

    // Another dialog opens above the persistent Hunk overlay.
    const foreign = harness.pushForeignOverlay();
    expect(harness.stack.map((h) => h.id)).toEqual([hunkHandle.id, foreign.id]);

    harness.events.length = 0;
    await surface.close();

    // Hunk removed itself by identity.
    expect(hunkHandle.removed).toBe(true);
    expect(harness.components[0]?.disposed).toBe(true);
    // Foreign dialog remains.
    expect(foreign.removed).toBe(false);
    expect(harness.stack.map((h) => h.id)).toEqual([foreign.id]);
    // Must NOT have used global hideOverlay (which would pop foreign).
    expect(harness.events.some((e) => e.startsWith("global:hideOverlay"))).toBe(false);
    expect(harness.events).toContain(`handle:hide:${hunkHandle.id}`);
    expect(harness.events).toContain(`component:dispose:${hunkHandle.id}`);
  });

  it("natural child exit uses the same owned-handle removal path", async () => {
    const harness = createHarness();
    const onChildExit = vi.fn();
    const surface = new OverlaySurface(harness.createComponent, { onChildExit });
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    const foreign = harness.pushForeignOverlay();
    const childDone = harness.components[0]!.options.done;

    harness.events.length = 0;
    childDone({ exitCode: 0 });
    await Promise.resolve();

    expect(surface.getState()).toBe("closed");
    expect(harness.components[0]?.disposed).toBe(true);
    expect(onChildExit).toHaveBeenCalledOnce();
    expect(onChildExit).toHaveBeenCalledWith({ exitCode: 0 });
    expect(foreign.removed).toBe(false);
    expect(harness.stack.map((h) => h.id)).toEqual([foreign.id]);
    expect(harness.events.some((e) => e.startsWith("global:hideOverlay"))).toBe(false);
    expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("notifies once for unexpected child exit after the overlay is live", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    const childDone = harness.components[0]!.options.done;

    childDone({ exitCode: 0, signal: 15, detail: "line1\nline2\nline3\nline4\nline5" });
    childDone({ exitCode: 0, signal: 15, detail: "late duplicate" });
    await Promise.resolve();

    const notify = vi.mocked(harness.ctx.ui.notify);
    expect(surface.getState()).toBe("closed");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("code 0, signal 15"), "error");
    expect(notify.mock.calls[0]?.[0]).toContain("line5");
    expect(notify.mock.calls[0]?.[0]).not.toContain("line1");
  });

  it("omits signal zero from unexpected live-exit notifications", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    harness.components[0]!.options.done({ exitCode: 2, signal: 0 });
    await Promise.resolve();

    const notify = vi.mocked(harness.ctx.ui.notify);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("code 2"), "error");
    expect(notify.mock.calls[0]?.[0]).not.toContain("signal 0");
  });

  it("child done before onHandle follows pre-mount cancel so a late handle cannot resurrect", async () => {
    const harness = createHarness({ delayedMount: true });
    const onChildExit = vi.fn();
    const surface = new OverlaySurface(harness.createComponent, { onChildExit });
    const config = cloneConfig(DEFAULT_CONFIG);

    const openPromise = surface.open(harness.ctx, request(), config);
    const settled = openPromise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    expect(surface.getState()).toBe("starting");
    expect(harness.components).toHaveLength(1);

    // Natural exit before Pi publishes the overlay handle is startup failure.
    harness.components[0]!.options.done({ exitCode: 0 });
    const result = await settled;

    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("exited before startup");
    expect(onChildExit).not.toHaveBeenCalled();
    expect(surface.getState()).toBe("closed");
    expect(surface.isLive()).toBe(false);
    expect(harness.components[0]?.disposed).toBe(true);

    // Flush the delayed onHandle microtask — it must only hide the stale entry.
    await Promise.resolve();
    await Promise.resolve();

    expect(surface.getState()).toBe("closed");
    expect(surface.isLive()).toBe(false);
    expect(surface.getInfo()).toBeNull();
    for (const handle of harness.handles) {
      expect(handle.removed || !harness.stack.includes(handle)).toBe(true);
    }
    // Must not reattach as a live overlay after dispose.
    expect(harness.events.some((e) => e.startsWith("global:hideOverlay"))).toBe(false);
  });

  it("rejects open with child exit detail when startup fails before onHandle", async () => {
    const harness = createHarness({ delayedMount: true });
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);

    const openPromise = surface.open(harness.ctx, request(), config);
    const settled = openPromise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    expect(surface.getState()).toBe("starting");

    harness.components[0]!.options.done({
      exitCode: 2,
      signal: 0,
      detail: "fatal:\x00 bad repo\ntry --repo /repo",
    });

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("exited before startup");
    expect(String(result)).toContain("code 2");
    expect(String(result)).not.toContain("signal 0");
    expect(String(result)).toContain("fatal: bad repo");
    expect(String(result)).toContain("try --repo /repo");
    expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
    expect(surface.getState()).toBe("closed");
  });

  it("fails a lazy native-module load without mutating surface state", async () => {
    const harness = createHarness();
    const loadEmbedded = vi.fn(async () => {
      throw new Error("native binding unavailable");
    });
    const surface = new OverlaySurface(undefined, { loadEmbedded });

    await expect(surface.open(harness.ctx, request(), cloneConfig(DEFAULT_CONFIG))).rejects.toThrow(
      "native binding unavailable",
    );
    expect(loadEmbedded).toHaveBeenCalledOnce();
    expect(harness.components).toHaveLength(0);
    expect(surface.getState()).toBe("closed");
    expect(surface.isLive()).toBe(false);
  });

  it("fails open() when the overlay handle never arrives (start timeout)", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ autoHandle: false });
      const surface = new OverlaySurface(harness.createComponent, { startTimeoutMs: 5000 });
      const config = cloneConfig(DEFAULT_CONFIG);

      const openPromise = surface.open(harness.ctx, request(), config);
      // Capture the rejection early so it is never an unhandled rejection.
      const settled = openPromise.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      expect(surface.getState()).toBe("starting");

      // Neither onHandle nor a custom() rejection fires — only the watchdog.
      await vi.advanceTimersByTimeAsync(5000);

      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toMatch(/did not start/);
      expect(surface.getState()).toBe("closed");
      expect(surface.isLive()).toBe(false);
      // The locally-created component must be disposed on timeout.
      expect(harness.components[0]?.disposed).toBe(true);

      // A late onHandle after timeout must only hide the stale entry.
      harness.releaseHandle();
      expect(surface.getState()).toBe("closed");
      expect(surface.isLive()).toBe(false);
      for (const handle of harness.handles) {
        expect(handle.removed || !harness.stack.includes(handle)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the start timeout once the handle arrives in time", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const surface = new OverlaySurface(harness.createComponent, { startTimeoutMs: 5000 });
      const config = cloneConfig(DEFAULT_CONFIG);

      await surface.open(harness.ctx, request(), config);
      expect(surface.getState()).toBe("visible");

      // Advancing well past the timeout must not disturb the live overlay.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(surface.getState()).toBe("visible");
      expect(surface.isLive()).toBe(true);

      await surface.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies onStateChange on open, component toggle-hide, and close", async () => {
    const harness = createHarness();
    const states: SurfaceState[] = [];
    const surface = new OverlaySurface(harness.createComponent, {
      onStateChange: () => states.push(surface.getState()),
    });
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    expect(states).toContain("visible");

    states.length = 0;
    // Component-initiated hide (Pi routes the toggle key to the focused overlay).
    harness.components[0]?.options.onToggleRequest?.();
    expect(surface.getState()).toBe("hidden");
    expect(states).toContain("hidden");

    states.length = 0;
    await surface.close();
    expect(states).toContain("closed");
  });

  it("routes focused-component actions through the injected lifecycle scheduler", async () => {
    const harness = createHarness();
    const surface = new OverlaySurface(harness.createComponent);
    const config = cloneConfig(DEFAULT_CONFIG);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scheduled = 0;
    surface.setTransitionScheduler(async (operation) => {
      scheduled += 1;
      await gate;
      return operation();
    });

    await surface.open(harness.ctx, request(), config);
    harness.components[0]?.options.onToggleRequest?.();
    await Promise.resolve();
    expect(scheduled).toBe(1);
    expect(surface.getState()).toBe("visible");

    release();
    await vi.waitFor(() => expect(surface.getState()).toBe("hidden"));
    await surface.close();
  });

  it("notifies onStateChange on natural child exit", async () => {
    const harness = createHarness();
    const states: SurfaceState[] = [];
    const surface = new OverlaySurface(harness.createComponent, {
      onStateChange: () => states.push(surface.getState()),
    });
    const config = cloneConfig(DEFAULT_CONFIG);

    await surface.open(harness.ctx, request(), config);
    states.length = 0;

    harness.components[0]?.options.done({ exitCode: 0 });
    await Promise.resolve();

    expect(surface.getState()).toBe("closed");
    expect(states).toContain("closed");
  });
});

describe("overlay sizing and fallback safety", () => {
  it("resolves percentage and absolute maxHeight against terminal rows", () => {
    expect(resolveOverlayRows("100%", 40)).toBe(40);
    expect(resolveOverlayRows("50%", 40)).toBe(20);
    expect(resolveOverlayRows(12, 40)).toBe(12);
    expect(resolveOverlayRows("100%", 1)).toBe(1);
  });
});
