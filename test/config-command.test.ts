import { afterEach, describe, expect, it, vi } from "vitest";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  delete process.env.PI_HUNK_REVIEW;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function testProject(
  selections: string[],
  keySequences: string[][] = [],
  trusted = true,
): Promise<{ ctx: ExtensionCommandContext; root: string; globalPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "hunk-config-command-"));
  temporaryDirectories.push(root);
  // Isolate config loading from the developer's real global configuration.
  const globalPath = join(root, "global-hunk.json");
  process.env.PI_HUNK_CONFIG = globalPath;
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
  return { ctx, root, globalPath };
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

describe("config persistence", () => {
  it("ignores a symlink planted at the formerly predictable temp path", async () => {
    const { ctx, root } = await testProject([]);
    const configPath = process.env.PI_HUNK_CONFIG!;
    const victim = join(root, "external-victim.txt");
    const planted = join(root, `.global-hunk.json.${process.pid}.0.tmp`);
    await writeFile(victim, "do not overwrite\n");
    await symlink(victim, planted);

    const store = new ConfigStore();
    await store.persist(ctx, "global", { review: "live" });

    expect(await readFile(victim, "utf8")).toBe("do not overwrite\n");
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ review: "live" });
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".global-hunk.json.tmp-")),
    ).toEqual([]);
  });
});

describe("interactive /hunk config", () => {
  it("auto-saves every changed setting to the global config without a Save step", async () => {
    const { ctx, globalPath } = await testProject([
      "Review behavior: off",
      "live",
      "Follow edits: on",
      "off",
      "Overlay layout: right",
      "Left — 50% split pane",
      "Done",
    ]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get()).toMatchObject({
      review: "live",
      followEdits: false,
      overlay: {
        layout: "left",
      },
    });
    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      review: "live",
      followEdits: false,
      overlay: {
        layout: "left",
      },
    });
    expect(ctx.ui.select).not.toHaveBeenCalledWith("Save Hunk config", expect.anything());
  });

  it("persists an interactive review choice while reporting the environment-effective policy", async () => {
    process.env.PI_HUNK_REVIEW = "off";
    const { ctx, globalPath } = await testProject(["Review behavior: off", "live", "Done"]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ review: "live" });
    expect(store.get().review).toBe("off");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `Hunk review=live was saved to ${globalPath}, but PI_HUNK_REVIEW keeps review=off.`,
      "warning",
    );
  });

  it("closes without writing when nothing changed", async () => {
    const { ctx, globalPath } = await testProject(["Done"]);
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get()).toEqual(DEFAULT_CONFIG);
    await expect(access(globalPath)).rejects.toThrow();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("rejects unsafe shortcuts and leaves the inherited binding intact", async () => {
    const { ctx, globalPath } = await testProject(
      ["Hunk prefix: ctrl+space", "Done"],
      [["h", "\x1b"]],
    );
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get().bindings.prefix).toBe("ctrl+space");
    await expect(access(globalPath)).rejects.toThrow();
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
  });

  it("auto-saves the dedicated prefix from raw keyboard input", async () => {
    const { ctx, globalPath } = await testProject(["Hunk prefix: ctrl+space", "Done"], [["\x18"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      bindings: { prefix: "ctrl+x" },
    });
    expect(store.get().bindings.prefix).toBe("ctrl+space");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("auto-saves a bare action hotkey and combines it with the prefix", async () => {
    const { ctx, globalPath } = await testProject(["Toggle hotkey: h", "Done"], [["t"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      bindings: { toggle: "t" },
    });
    expect(store.get().bindings.toggle).toBe("h");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("ctrl+space then t/s"),
      "info",
    );
  });

  it("rejects an action hotkey that collides with the prefix", async () => {
    const { ctx, globalPath } = await testProject(["Toggle hotkey: h", "Done"], [["\x00", "t"]]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      bindings: { toggle: "t" },
    });
  });

  it("auto-saves a shortcut to the global config but keeps the runtime key until reload", async () => {
    const { ctx, globalPath } = await testProject(
      ["Hunk prefix: ctrl+space", "Hunk prefix: ctrl+x", "Follow edits: on", "off", "Done"],
      [["\x18"]],
    );
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(store.get().bindings.prefix).toBe("ctrl+space");
    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      bindings: { prefix: "ctrl+x" },
      followEdits: false,
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("restores defaults by removing global overrides after confirmation", async () => {
    const { ctx, globalPath } = await testProject([
      "Restore defaults…",
      "Restore — remove global overrides",
      "Done",
    ]);
    const store = new ConfigStore();
    await store.persist(ctx, "global", {
      review: "live",
      bindings: { prefix: "ctrl+x" },
    });

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    await expect(access(globalPath)).rejects.toThrow();
    expect(store.get()).toMatchObject({
      review: "off",
      bindings: { prefix: "ctrl+x" },
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(`Global Hunk overrides removed from ${globalPath}`),
      "info",
    );
  });

  it("reports interactive persistence failure without claiming the change was saved", async () => {
    const { ctx, globalPath } = await testProject(["Review behavior: off", "live", "Done"]);
    await rm(globalPath, { force: true });
    await writeFile(globalPath, "not a directory");
    process.env.PI_HUNK_CONFIG = join(globalPath, "hunk.json");
    const store = new ConfigStore();

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not update global Hunk config"),
      "error",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
    expect(store.get().review).toBe("off");
  });

  it("still works when the project is untrusted because config is global", async () => {
    const { ctx, globalPath } = await testProject(
      ["Review behavior: off", "live", "Done"],
      [],
      false,
    );
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ review: "live" });
    expect(store.get().review).toBe("live");
  });
});

describe("direct /hunk config", () => {
  it("persists a changed layout directly to the global config with no scope argument", async () => {
    const { ctx, globalPath } = await testProject([]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("left", ctx, store, inactiveCoordinator);

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      overlay: {
        layout: "left",
      },
    });
    expect(store.get().overlay).toEqual({
      layout: "left",
    });
  });

  it("rejects exclusive, takeover, and wrap tokens as invalid config flags", async () => {
    const { ctx, globalPath } = await testProject([]);
    const store = new ConfigStore();
    await store.reload(ctx);

    await handleConfigCommand("right experimental-exclusive", ctx, store, inactiveCoordinator);
    await handleConfigCommand("full experimental-takeover", ctx, store, inactiveCoordinator);
    await handleConfigCommand("right experimental-wrap", ctx, store, inactiveCoordinator);
    await handleConfigCommand("left no-wrap", ctx, store, inactiveCoordinator);

    await expect(access(globalPath)).rejects.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "warning");
  });

  it("reports direct persistence failure and leaves runtime layout unchanged", async () => {
    const { ctx, globalPath } = await testProject([]);
    await writeFile(globalPath, "not a directory");
    process.env.PI_HUNK_CONFIG = join(globalPath, "hunk.json");
    const store = new ConfigStore();

    await handleConfigCommand("left", ctx, store, inactiveCoordinator);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not update global Hunk config"),
      "error",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "info");
    expect(store.get().overlay.layout).toBe("full");
  });

  it("warns a live surface that a changed layout applies after reopen", async () => {
    const { ctx } = await testProject([]);
    const store = new ConfigStore();
    const liveCoordinator = { hasLiveSurface: () => true } as ReviewCoordinator;

    await handleConfigCommand("left", ctx, store, liveCoordinator);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Close and reopen the current Hunk review"),
      "info",
    );
  });

  it("supports direct global reset and restores built-in defaults", async () => {
    const { ctx, globalPath } = await testProject([]);
    const store = new ConfigStore();
    await store.persist(ctx, "global", { review: "live" });

    await handleConfigCommand("restore", ctx, store, inactiveCoordinator);

    await expect(access(globalPath)).rejects.toThrow();
    expect(store.get()).toEqual(DEFAULT_CONFIG);
  });

  it("rejects the removed session and global scope modifiers", async () => {
    const { ctx, globalPath } = await testProject([]);
    const store = new ConfigStore();

    await handleConfigCommand("right session", ctx, store, inactiveCoordinator);
    await handleConfigCommand("right persist", ctx, store, inactiveCoordinator);

    await expect(access(globalPath)).rejects.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "warning");
  });
});
