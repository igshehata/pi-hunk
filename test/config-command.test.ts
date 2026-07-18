import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  handleConfigCommand,
  hotkeyBindingFromInput,
  prefixBindingFromInput,
} from "../extensions/config-command.ts";
import { ConfigStore, DEFAULT_CONFIG } from "../extensions/config.ts";
import type { ReviewCoordinator } from "../extensions/coordinator.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function testProject(
  selections: string[],
  keySequences: string[][] = [],
  trusted = true,
): Promise<{ ctx: ExtensionCommandContext; root: string; projectPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "hunk-config-command-"));
  temporaryDirectories.push(root);
  // Isolate config loading from the developer's real global configuration.
  process.env.PI_HUNK_CONFIG = join(root, "global-hunk.json");
  const ctx = {
    cwd: root,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: {
      select: vi.fn(async () => selections.shift()),
      custom: vi.fn(async (factory: Function) => {
        let result: unknown;
        let finished = false;
        const component = factory(
          { requestRender: vi.fn() },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          (value: unknown) => {
            result = value;
            finished = true;
          },
        );
        for (const data of keySequences.shift() ?? []) {
          component.handleInput?.(data);
          if (finished) break;
        }
        return result;
      }),
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, root, projectPath: join(root, ".pi", "hunk.json") };
}

const inactiveCoordinator = { hasLiveSurface: () => false } as ReviewCoordinator;

describe("prefix keyboard capture", () => {
  it("converts raw terminal input instead of accepting typed key-id text", () => {
    expect(prefixBindingFromInput("\x00")).toBe("ctrl+space");
    expect(prefixBindingFromInput("\x1b[104;6u")).toBe("shift+ctrl+h");
    expect(prefixBindingFromInput("\x1bOP")).toBe("f1");
    expect(hotkeyBindingFromInput("h")).toBe("h");
  });

  it("rejects plain typing and bare navigation keys", () => {
    expect(prefixBindingFromInput("h")).toBeUndefined();
    expect(prefixBindingFromInput("\x1b[A")).toBeUndefined();
  });
});

describe("interactive /hunk config", () => {
  it("auto-saves every changed setting to the trusted project without a Save step", async () => {
    const { ctx, projectPath } = await testProject([
      "Review behavior: after-run",
      "live",
      "Follow edits: on",
      "off",
      "Overlay layout: full",
      "Right — 50% split pane",
      "Pi word wrap: off",
      "On — wrap Pi beside Hunk (experimental)",
      "Done",
    ]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get()).toMatchObject({
      review: "live",
      followEdits: false,
      overlay: { layout: "right", experimentalPiWrap: true },
    });
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      review: "live",
      followEdits: false,
      overlay: { layout: "right", experimentalPiWrap: true },
    });
    expect(ctx.ui.select).not.toHaveBeenCalledWith("Save Hunk config", expect.anything());
  });

  it("closes without writing when nothing changed", async () => {
    const { ctx, projectPath } = await testProject(["Done"]);
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get()).toEqual(DEFAULT_CONFIG);
    await expect(access(projectPath)).rejects.toThrow();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("rejects unsafe shortcuts and leaves the inherited binding intact", async () => {
    const { ctx, projectPath } = await testProject(
      ["Hunk prefix: ctrl+space", "Done"],
      [["h", "\x1b"]],
    );
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get().bindings.prefix).toBe("ctrl+space");
    await expect(access(projectPath)).rejects.toThrow();
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
  });

  it("auto-saves the dedicated prefix from raw keyboard input", async () => {
    const { ctx, projectPath } = await testProject(["Hunk prefix: ctrl+space", "Done"], [["\x18"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      bindings: { prefix: "ctrl+x" },
    });
    expect(store.get().bindings.prefix).toBe("ctrl+space");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("auto-saves a bare action hotkey and combines it with the prefix", async () => {
    const { ctx, projectPath } = await testProject(["Toggle hotkey: h", "Done"], [["t"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      bindings: { toggle: "t" },
    });
    expect(store.get().bindings.toggle).toBe("h");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("ctrl+space then t/s"),
      "info",
    );
  });

  it("rejects an action hotkey that collides with the prefix", async () => {
    const { ctx, projectPath } = await testProject(["Toggle hotkey: h", "Done"], [["\x00", "t"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      bindings: { toggle: "t" },
    });
  });

  it("auto-saves a shortcut to the project but keeps the runtime key until reload", async () => {
    const { ctx, projectPath } = await testProject(
      ["Hunk prefix: ctrl+space", "Hunk prefix: ctrl+x", "Follow edits: on", "off", "Done"],
      [["\x18"]],
    );
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get().bindings.prefix).toBe("ctrl+space");
    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      bindings: { prefix: "ctrl+x" },
      followEdits: false,
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("restores defaults by removing project overrides after confirmation", async () => {
    const { ctx, projectPath } = await testProject([
      "Restore defaults…",
      "Restore — remove project overrides",
      "Done",
    ]);
    const store = new ConfigStore();
    await store.persist(ctx, "project", {
      review: "live",
      bindings: { prefix: "ctrl+x" },
    });

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    await expect(access(projectPath)).rejects.toThrow();
    expect(store.get()).toMatchObject({
      review: "after-run",
      bindings: { prefix: "ctrl+x" },
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("settings restored"),
      "info",
    );
  });

  it("refuses to expose temporary fallback behavior in an untrusted project", async () => {
    const { ctx, projectPath } = await testProject([], [], false);
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    await expect(access(projectPath)).rejects.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("trusted project"),
      "warning",
    );
  });
});

describe("direct /hunk config", () => {
  it("persists directly to the project with no scope argument", async () => {
    const { ctx, projectPath } = await testProject([]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("right experimental-wrap", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
      overlay: { layout: "right", experimentalPiWrap: true },
    });
    expect(store.get().overlay).toEqual({ layout: "right", experimentalPiWrap: true });
  });

  it("rejects experimental wrapping for non-split layouts instead of discarding it", async () => {
    const { ctx, projectPath } = await testProject([]);
    const store = new ConfigStore();

    await handleConfigCommand("full experimental-wrap", ctx, store, inactiveCoordinator);

    await expect(access(projectPath)).rejects.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Experimental Pi word wrap only applies to left and right layouts.",
      "warning",
    );
  });

  it("supports direct project reset and restores inherited global settings", async () => {
    const { ctx, root, projectPath } = await testProject([]);
    await writeFile(join(root, "global-hunk.json"), JSON.stringify({ review: "off" }));
    const store = new ConfigStore();
    await store.persist(ctx, "project", { review: "live" });

    await handleConfigCommand("restore", ctx, store, inactiveCoordinator);

    await expect(access(projectPath)).rejects.toThrow();
    expect(store.get()).toEqual({ ...DEFAULT_CONFIG, review: "off" });
  });

  it("rejects the removed session and global scope modifiers", async () => {
    const { ctx, projectPath } = await testProject([]);
    const store = new ConfigStore();

    await handleConfigCommand("right session", ctx, store, inactiveCoordinator);
    await handleConfigCommand("right persist", ctx, store, inactiveCoordinator);

    await expect(access(projectPath)).rejects.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "warning");
  });
});
