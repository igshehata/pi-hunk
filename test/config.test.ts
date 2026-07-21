import { describe, expect, it } from "vitest";
import {
  applyConfig,
  cloneConfig,
  DEFAULT_CONFIG,
  isPrefixBinding,
  isHotkeyBinding,
  resolveHunkArgs,
  resolveOverlayLayout,
  splitArgs,
} from "../extensions/config.ts";

describe("overlay config", () => {
  it("ships a wrapped right-split overlay by default", () => {
    expect(DEFAULT_CONFIG).toEqual(
      expect.objectContaining({
        review: "after-run",
        followEdits: true,
        hunk: { command: "hunk", args: ["diff", "--watch"] },
        overlay: { layout: "right", experimentalPiWrap: true },
        bindings: { prefix: "ctrl+space", toggle: "h", show: "s" },
      }),
    );
    expect(DEFAULT_CONFIG).not.toHaveProperty("display");
    expect(DEFAULT_CONFIG).not.toHaveProperty("split");
    expect(DEFAULT_CONFIG).not.toHaveProperty("fallback");
  });

  it("cannot reactivate removed display integrations", () => {
    const config = applyConfig(cloneConfig(DEFAULT_CONFIG), {
      display: "split",
      fallback: ["overlay"],
      split: { provider: "tmux" },
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("layers sparse supported values", () => {
    const config = applyConfig(cloneConfig(DEFAULT_CONFIG), {
      review: "live",
      overlay: { layout: "right", experimentalPiWrap: true },
      bindings: { prefix: "ctrl+x", toggle: "t", show: "l" },
    });
    expect(config.review).toBe("live");
    expect(config.overlay).toEqual({ layout: "right", experimentalPiWrap: true });
    expect(config.bindings).toEqual({ prefix: "ctrl+x", toggle: "t", show: "l" });
  });

  it("accepts modified action suffixes without reinterpretation", () => {
    const sparse = applyConfig(cloneConfig(DEFAULT_CONFIG), {
      bindings: { toggle: "ctrl+x" },
    });
    const explicit = applyConfig(cloneConfig(DEFAULT_CONFIG), {
      bindings: { prefix: "ctrl+space", toggle: "ctrl+x" },
    });
    expect(sparse.bindings.toggle).toBe("ctrl+x");
    expect(explicit.bindings.toggle).toBe("ctrl+x");
  });

  it.each([
    { prefix: "ctrl+x", toggle: "ctrl+x", show: "s" },
    { prefix: "ctrl+x", toggle: "h", show: "ctrl+x" },
    { prefix: "ctrl+x", toggle: "j", show: "j" },
  ])("rejects every colliding Hunk chord atomically: %j", (bindings) => {
    const config = applyConfig(cloneConfig(DEFAULT_CONFIG), { bindings });
    expect(config.bindings).toEqual(DEFAULT_CONFIG.bindings);
  });

  it("does not reset an inherited layout when only the experiment flag is layered", () => {
    const global = applyConfig(cloneConfig(DEFAULT_CONFIG), { overlay: { layout: "right" } });
    const project = applyConfig(global, { overlay: { experimentalPiWrap: true } });
    expect(project.overlay).toEqual({ layout: "right", experimentalPiWrap: true });
  });

  it("resolves the four named layouts", () => {
    expect(resolveOverlayLayout("full")).toEqual({
      anchor: "center",
      width: "100%",
      maxHeight: "100%",
    });
    expect(resolveOverlayLayout("left")).toEqual({
      anchor: "left-center",
      width: "50%",
      maxHeight: "100%",
    });
    expect(resolveOverlayLayout("right")).toEqual({
      anchor: "right-center",
      width: "50%",
      maxHeight: "100%",
    });
    expect(resolveOverlayLayout("float")).toEqual({
      anchor: "center",
      width: "75%",
      maxHeight: "75%",
    });
  });

  it("validates safe bindings", () => {
    expect(isPrefixBinding("ctrl+space")).toBe(true);
    expect(isPrefixBinding("f12")).toBe(true);
    expect(isPrefixBinding("h")).toBe(false);
    expect(isPrefixBinding("shift+h")).toBe(false);
    expect(isPrefixBinding("space")).toBe(false);
    expect(isHotkeyBinding("h")).toBe(true);
    expect(isHotkeyBinding("left")).toBe(true);
    expect(isHotkeyBinding("escape")).toBe(false);
  });

  it("rejects Hunk entrypoints that require external terminal integration", () => {
    for (const verb of ["patch", "pager", "difftool"]) {
      expect(() => resolveHunkArgs(verb, DEFAULT_CONFIG.hunk.args)).toThrow(
        `${verb} is not supported through /hunk`,
      );
    }
  });

  it("preserves explicit empty argv entries", () => {
    expect(splitArgs(`show "" '' tail`)).toEqual(["show", "", "", "tail"]);
    expect(splitArgs(`  ""  `)).toEqual([""]);
  });

  it("passes VCS-neutral Hunk argv and targets through", () => {
    expect(resolveHunkArgs("show HEAD~1", DEFAULT_CONFIG.hunk.args)).toEqual(["show", "HEAD~1"]);
    expect(resolveHunkArgs('show "mine() & ~empty()"', DEFAULT_CONFIG.hunk.args)).toEqual([
      "show",
      "mine() & ~empty()",
    ]);
    expect(resolveHunkArgs("trunk()..@", DEFAULT_CONFIG.hunk.args)).toEqual(["diff", "trunk()..@"]);
    expect(resolveHunkArgs("third-vcs:change-42", DEFAULT_CONFIG.hunk.args)).toEqual([
      "diff",
      "third-vcs:change-42",
    ]);
    expect(resolveHunkArgs("--staged", DEFAULT_CONFIG.hunk.args)).toEqual(["diff", "--staged"]);
  });
});
