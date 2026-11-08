import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig } from "../src/config.js";

describe("shared shortcut configuration", () => {
  it("rejects literal and modified symbols Pi cannot bind", () => {
    expect(() => parseConfig({ prefix: "+" })).toThrow(Error);
    expect(() => parseConfig({ prefix: "ctrl++" })).toThrow(Error);
    expect(() => parseConfig({ prefix: '"' })).toThrow(Error);
  });

  it("rejects modifiers on Escape rather than registering an unreachable chord", () => {
    expect(() => parseConfig({ prefix: "ctrl+escape" })).toThrow(Error);
  });

  it("rejects explicit Shift with non-letter printable keys", () => {
    expect(() => parseConfig({ show: "shift+1" })).toThrow(Error);
  });

  it("rejects ambiguous or unreachable history triggers", () => {
    expect(() => parseConfig({ log: "h" })).toThrow(Error);
    expect(() => parseConfig({ log: "s" })).toThrow(Error);
    expect(() => parseConfig({ log: "escape" })).toThrow(Error);
    expect(() => parseConfig({ diff: "l" })).toThrow(Error);
  });

  it("preserves literal symbols and uppercase trigger semantics", () => {
    const { config } = parseConfig({ prefix: "ctrl+g", diff: "!", show: "H" });
    expect(matchesKey("\u0007", config.prefix as KeyId)).toBe(true);
    expect(matchesKey("!", config.diff as KeyId)).toBe(true);
    expect(matchesKey("H", config.show as KeyId)).toBe(true);
    expect(matchesKey("h", config.show as KeyId)).toBe(false);
  });
});

describe("host-global configuration persistence", () => {
  it("keeps the prior readable settings when a save is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-config-test-"));
    const path = join(directory, "pi-hunk.json");
    try {
      const saved = await saveConfig(path, {
        prefix: "ctrl+g",
        diff: "!",
        show: "H",
        delivery: "followUp",
      });
      await expect(saveConfig(path, { ...saved, diff: saved.show })).rejects.toThrow(Error);
      expect(await loadConfig(path)).toEqual({ _tag: "Loaded", config: saved, ignored: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Guards the bug where one field a newer build wrote disabled every known setting and made
  // `/hunk config` fail on the same file, leaving hand-editing as the only recovery.
  it("applies known settings beside an unknown field and reports the field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-config-test-"));
    const path = join(directory, "pi-hunk.json");
    try {
      await writeFile(
        path,
        `${JSON.stringify({ diff: "d", delivery: "followUp", theme: "dark" })}\n`,
      );
      const loaded = await loadConfig(path);
      expect(loaded).toEqual({
        _tag: "Loaded",
        config: { ...DEFAULT_CONFIG, diff: "d", delivery: "followUp" },
        ignored: ["theme"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
