import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../extensions/config.ts";
import { ReviewCoordinator } from "../extensions/coordinator.ts";
import hunkExtension from "../extensions/index.ts";
import type { EmbeddedOptions } from "../extensions/overlay/embedded.ts";
import { OverlaySurface, type OverlayComponent } from "../extensions/overlay/surface.ts";

const temporaryDirectories: string[] = [];
type PrefixAction = "h" | "s";
type PrefixActionSource = PrefixAction | (() => PrefixAction);
interface ConfigInteraction {
  selections: string[];
  keySequences: string[][];
}

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(
  prefix = "ctrl+space",
  trusted = false,
  prefixAction: PrefixActionSource = "h",
  rawBindings: Record<string, string> = { prefix },
  configInteraction?: ConfigInteraction,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-hunk-extension-"));
  temporaryDirectories.push(root);
  process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
  await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ bindings: rawBindings }));

  const mounts: EmbeddedOptions[] = [];
  const overlay = new OverlaySurface((options): OverlayComponent => {
    mounts.push(options);
    return {
      render: () => ["hunk"],
      invalidate: () => undefined,
      setVisible: () => undefined,
      dispose: () => undefined,
    };
  });
  const coordinator = new ReviewCoordinator({ overlay });
  const events = new Map<
    string,
    (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void
  >();
  const shortcuts = new Map<string, (ctx: ExtensionCommandContext) => Promise<void> | void>();
  const commands = new Map<
    string,
    (input: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >();

  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void,
    ) => {
      events.set(name, handler);
    },
    registerShortcut: (
      key: string,
      spec: { handler: (ctx: ExtensionCommandContext) => Promise<void> | void },
    ) => {
      shortcuts.set(key, spec.handler);
    },
    registerCommand: (
      name: string,
      spec: {
        handler: (input: string, ctx: ExtensionCommandContext) => Promise<void> | void;
      },
    ) => {
      commands.set(name, spec.handler);
    },
    registerTool: () => undefined,
  } as unknown as ExtensionAPI;

  const store = new ConfigStore();
  hunkExtension(pi, {
    store,
    coordinator,
    reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    reviewWaitForSession: async () => ({ status: "not-found" }),
  });

  const ctx = createContext(root, trusted, prefixAction, configInteraction);
  await events.get("session_start")?.({ type: "session_start" }, ctx);
  return { ctx, coordinator, events, mounts, shortcuts, commands, store };
}

function createContext(
  cwd: string,
  trusted: boolean,
  prefixAction: PrefixActionSource,
  configInteraction?: ConfigInteraction,
): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    isProjectTrusted: () => trusted,
    waitForIdle: async () => undefined,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(async () => configInteraction?.selections.shift()),
      theme: { fg: (_color: string, text: string) => text },
      custom<T>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => unknown,
        options?: { onHandle?: (handle: unknown) => void },
      ): Promise<T> {
        const entry = { hidden: false };
        let result: T | undefined;
        const component = factory(
          {
            terminal: { columns: 80, rows: 24, write: vi.fn() },
            requestRender: vi.fn(),
          },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          (value: T) => {
            result = value;
          },
        ) as { handleInput?: (data: string) => void };
        if (!options?.onHandle) {
          const configuredSequence = configInteraction?.keySequences.shift();
          const sequence = configuredSequence ?? [
            typeof prefixAction === "function" ? prefixAction() : prefixAction,
          ];
          for (const data of sequence) component.handleInput?.(data);
          return Promise.resolve(result as T);
        }
        options.onHandle({
          hide: () => undefined,
          setHidden: (hidden: boolean) => {
            entry.hidden = hidden;
          },
          isHidden: () => entry.hidden,
          focus: () => undefined,
          isFocused: () => !entry.hidden,
        });
        return new Promise<T>(() => undefined);
      },
    },
  } as unknown as ExtensionCommandContext;
}

describe("extension overlay integration", () => {
  it("restores a hidden overlay with prefix+h", async () => {
    const { ctx, coordinator, mounts, shortcuts } = await setup("ctrl+space", false, "h");

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("hunk", "hunk: after-run");
    expect([...shortcuts.keys()]).toEqual(["ctrl+space"]);
    await shortcuts.get("ctrl+space")?.(ctx);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.prefixKey).toBe("ctrl+space");
    expect(mounts[0]?.toggleKey).toBe("h");
    expect(mounts[0]?.showKey).toBe("s");
    expect(coordinator.getActiveInfo()?.state).toBe("visible");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("hunk", "hunk: visible");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Hunk overlay opened.", "info");

    // Real focused-overlay toggles bypass Pi's shortcut dispatcher. The live
    // coordinator subscription must still refresh Pi's status segment.
    mounts[0]?.onToggleRequest?.();
    expect(mounts).toHaveLength(1);
    await vi.waitFor(() => expect(coordinator.getActiveInfo()?.state).toBe("hidden"));
    expect(coordinator.hasLiveSurface()).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("hunk", "hunk: hidden");

    await shortcuts.get("ctrl+space")?.(ctx);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("hunk", "hunk: visible");
  });

  it("toggles show when repeated and replaces a different focused review", async () => {
    const { ctx, coordinator, mounts, shortcuts, commands } = await setup("ctrl+space", false, "s");

    await shortcuts.get("ctrl+space")?.(ctx);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.args).toEqual(["show"]);

    // The focused overlay handles the repeated show chord and hides itself.
    mounts[0]?.onShowRequest?.();
    await vi.waitFor(() => expect(coordinator.getActiveInfo()?.state).toBe("hidden"));

    // Once hidden, Pi owns focus again; the same chord restores the show review.
    await shortcuts.get("ctrl+space")?.(ctx);
    expect(mounts).toHaveLength(1);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");

    await commands.get("hunk")?.("", ctx);
    expect(mounts).toHaveLength(2);
    expect(mounts[1]?.args).toEqual(["diff", "--watch"]);

    // The embedded component intercepts the same key because Pi does not
    // dispatch extension shortcuts while the overlay owns keyboard focus.
    mounts[1]?.onShowRequest?.();
    await vi.waitFor(() => expect(mounts).toHaveLength(3));
    expect(mounts[2]?.args).toEqual(["show"]);
  });

  it("switches a visible show review back to diff when focused prefix+h is pressed", async () => {
    const { ctx, coordinator, mounts, shortcuts } = await setup("ctrl+space", false, "s");

    await shortcuts.get("ctrl+space")?.(ctx);
    expect(mounts[0]?.args).toEqual(["show"]);

    // While Hunk owns focus, EmbeddedHunk dispatches prefix+h through this callback.
    mounts[0]?.onToggleRequest?.();
    await vi.waitFor(() => expect(mounts).toHaveLength(2));

    expect(mounts[1]?.args).toEqual(["diff", "--watch"]);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");
  });

  it("switches a hidden show review back to diff when prefix+h is pressed", async () => {
    let action: PrefixAction = "s";
    const { ctx, coordinator, mounts, shortcuts } = await setup("ctrl+space", false, () => action);

    await shortcuts.get("ctrl+space")?.(ctx);
    expect(mounts[0]?.args).toEqual(["show"]);

    mounts[0]?.onShowRequest?.();
    await vi.waitFor(() => expect(coordinator.getActiveInfo()?.state).toBe("hidden"));

    action = "h";
    await shortcuts.get("ctrl+space")?.(ctx);

    expect(mounts).toHaveLength(2);
    expect(mounts[1]?.args).toEqual(["diff", "--watch"]);
    expect(coordinator.getActiveInfo()?.state).toBe("visible");
  });

  it("routes /hunk argv and closes the managed overlay", async () => {
    const { ctx, coordinator, mounts, commands } = await setup();
    const hunk = commands.get("hunk");
    expect(hunk).toBeDefined();

    await hunk?.("staged", ctx);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.args).toEqual(["diff", "--staged"]);
    expect(coordinator.hasLiveSurface()).toBe(true);

    await hunk?.("close", ctx);
    expect(coordinator.hasLiveSurface()).toBe(false);
  });

  it("rejects ignored arguments on lifecycle and status subcommands", async () => {
    const { ctx, coordinator, mounts, commands } = await setup();
    const hunk = commands.get("hunk");

    await hunk?.("close now", ctx);
    await hunk?.("toggle extra", ctx);
    await hunk?.("status verbose", ctx);
    await hunk?.("feedback extra", ctx);
    await hunk?.("submit extra", ctx);
    await hunk?.("next extra", ctx);

    expect(mounts).toHaveLength(0);
    expect(coordinator.hasLiveSurface()).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(6);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "Usage: /hunk close", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "Usage: /hunk toggle", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(3, "Usage: /hunk status", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(4, "Usage: /hunk feedback", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(5, "Usage: /hunk submit", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(6, "Usage: /hunk next", "warning");
  });

  it("rejects patch, pager, and difftool instead of opening broken overlays", async () => {
    const { ctx, mounts, commands } = await setup();

    for (const verb of ["patch", "pager", "difftool"]) {
      await commands.get("hunk")?.(verb, ctx);
    }

    expect(mounts).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "Hunk difftool is not supported through /hunk; run it directly in a terminal.",
      "error",
    );
  });

  it("passes jj revsets and workspace cwd through to Hunk unchanged", async () => {
    const { ctx, mounts, commands } = await setup();

    await commands.get("hunk")?.("show mine()", ctx);

    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.cwd).toBe(ctx.cwd);
    expect(mounts[0]?.args).toEqual(["show", "mine()"]);
  });

  it("writes /hunk review changes directly to trusted project config", async () => {
    const { ctx, commands } = await setup("ctrl+space", true);

    await commands.get("hunk")?.("review live", ctx);

    expect(JSON.parse(await readFile(join(ctx.cwd, ".pi", "hunk.json"), "utf8"))).toEqual({
      review: "live",
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Hunk review set to live in .pi/hunk.json.", "info");
  });

  it("keeps the entire pending chord inactive across file reloads and /hunk review until session start", async () => {
    const originalBindings = { prefix: "ctrl+space", toggle: "h", show: "s" } as const;
    const pendingBindings = { prefix: "ctrl+x", toggle: "j", show: "k" } as const;
    const { ctx, commands, events, shortcuts, store } = await setup(
      originalBindings.prefix,
      true,
      "h",
      originalBindings,
      {
        selections: ["Hunk prefix:", "Toggle hotkey:", "Show hotkey:", "Done"],
        keySequences: [["\x18"], ["j"], ["k"]],
      },
    );

    await commands.get("hunk")?.("config", ctx);

    expect(store.get().bindings).toEqual(originalBindings);
    expect(store.getLoaded().bindings).toEqual(pendingBindings);
    await store.reload(ctx);
    expect(store.get().bindings).toEqual(originalBindings);

    await commands.get("hunk")?.("review live", ctx);

    expect(store.get()).toMatchObject({ review: "live", bindings: originalBindings });
    expect(store.getLoaded()).toMatchObject({ review: "live", bindings: pendingBindings });
    expect(JSON.parse(await readFile(join(ctx.cwd, ".pi", "hunk.json"), "utf8"))).toEqual({
      bindings: pendingBindings,
      review: "live",
    });
    expect([...shortcuts.keys()]).toEqual([originalBindings.prefix]);

    await events.get("session_start")?.({ type: "session_start" }, ctx);

    expect(store.get()).toMatchObject({ review: "live", bindings: pendingBindings });
    expect([...shortcuts.keys()]).toEqual([originalBindings.prefix, pendingBindings.prefix]);
  });
});
