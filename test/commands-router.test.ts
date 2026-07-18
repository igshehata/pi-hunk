import { describe, expect, it } from "vitest";
import { HUNK_VERBS, hunkArgumentCompletions, RESERVED_SUBCOMMANDS } from "../extensions/config.ts";
import { parseConfigCommand } from "../extensions/config-command.ts";

describe("/hunk subcommand routing invariants", () => {
  it("exposes only overlay-compatible Hunk CLI verbs", () => {
    expect([...HUNK_VERBS].sort()).toEqual(["diff", "show", "stash"]);
    for (const reserved of RESERVED_SUBCOMMANDS) {
      expect(HUNK_VERBS.has(reserved)).toBe(false);
    }
    for (const verb of HUNK_VERBS) {
      expect(RESERVED_SUBCOMMANDS.has(verb)).toBe(false);
    }
  });

  it("reserves exactly the settings/lifecycle words", () => {
    expect([...RESERVED_SUBCOMMANDS].sort()).toEqual(
      ["close", "config", "feedback", "review", "status", "toggle"].sort(),
    );
  });
});

describe("hunkArgumentCompletions", () => {
  const values = (text: string) => (hunkArgumentCompletions(text) ?? []).map((item) => item.value);
  const labels = (text: string) => (hunkArgumentCompletions(text) ?? []).map((item) => item.label);

  it("offers subcommands and hunk verbs for the first token", () => {
    const first = values("");
    expect(first).toContain("close");
    expect(first).toContain("feedback");
    expect(first).toContain("review");
    expect(first).toContain("config");
    expect(first).not.toContain("send");
    expect(first).toContain("diff");
    expect(first).not.toContain("patch");
    expect(first).not.toContain("pager");
    expect(first).not.toContain("difftool");
  });

  it("filters the first token by its prefix", () => {
    expect(values("re")).toEqual(["review"]);
    expect(values("di")).toEqual(["diff"]);
    expect(hunkArgumentCompletions("zzz")).toBeNull();
  });

  it("offers per-subcommand values for the second token, replacing the whole argument", () => {
    expect(values("review ")).toEqual(["review off", "review after-run", "review live"]);
    expect(labels("review ")).toEqual(["off", "after-run", "live"]);
    expect(values("config ")).toEqual([
      "config restore",
      "config full",
      "config left",
      "config right",
      "config float",
    ]);
  });

  it("filters the second token by its partial prefix", () => {
    expect(values("review l")).toEqual(["review live"]);
    expect(values("config res")).toEqual(["config restore"]);
  });

  it("offers only layout modifiers, with no persistence scopes", () => {
    expect(values("review live ")).toEqual([]);
    expect(values("config restore ")).toEqual([]);
    expect(values("config right e")).toEqual(["config right experimental-wrap"]);
    expect(values("config right ")).toEqual([
      "config right experimental-wrap",
      "config right no-wrap",
    ]);
  });

  it("returns null for verbs and unknown first tokens on the second token", () => {
    expect(hunkArgumentCompletions("diff ")).toBeNull();
    expect(hunkArgumentCompletions("staged ")).toBeNull();
  });
});

describe("/hunk config parsing", () => {
  it("parses direct project changes without a scope", () => {
    expect(parseConfigCommand("right", false)).toEqual({
      layout: "right",
      experimentalPiWrap: false,
    });
    expect(parseConfigCommand("left experimental-wrap", false)).toEqual({
      layout: "left",
      experimentalPiWrap: true,
    });
  });

  it("disables inherited wrapping for non-split layouts and rejects explicit wrap intent", () => {
    expect(parseConfigCommand("float", true)).toEqual({
      layout: "float",
      experimentalPiWrap: false,
    });
    expect(parseConfigCommand("full experimental-wrap", false)).toBeUndefined();
    expect(parseConfigCommand("float wrap", false)).toBeUndefined();
  });

  it("rejects unknown layouts, flags, and removed scopes", () => {
    expect(parseConfigCommand("custom", false)).toBeUndefined();
    expect(parseConfigCommand("right magic", false)).toBeUndefined();
    expect(parseConfigCommand("right session", false)).toBeUndefined();
    expect(parseConfigCommand("right persist", false)).toBeUndefined();
  });
});
