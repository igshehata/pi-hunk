import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig, saveConfig } from "../src/config.js";

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

  it("preserves literal symbols and uppercase trigger semantics", () => {
    const config = parseConfig({ prefix: "ctrl+g", diff: "!", show: "H" });
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
      const saved = await Effect.runPromise(
        saveConfig(path, { prefix: "ctrl+g", diff: "!", show: "H", delivery: "followUp" }),
      );
      await expect(
        Effect.runPromise(saveConfig(path, { ...saved, diff: saved.show })),
      ).rejects.toThrow(Error);
      expect(await Effect.runPromise(loadConfig(path))).toEqual(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
