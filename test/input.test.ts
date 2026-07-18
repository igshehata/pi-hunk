import { describe, expect, it } from "vitest";
import { toPtyInput, translateMouseInput } from "../extensions/overlay/input.ts";

describe("toPtyInput", () => {
  it("passes legacy input through", () => {
    expect(toPtyInput("a")).toBe("a");
    expect(toPtyInput("\x1b[A")).toBe("\x1b[A");
  });

  it("decodes Kitty printable and control keys", () => {
    expect(toPtyInput("\x1b[97u")).toBe("a");
    expect(toPtyInput("\x1b[13u")).toBe("\r");
    expect(toPtyInput("\x1b[99;5u")).toBe("\x03");
  });

  it("converts modified Kitty navigation keys to xterm sequences", () => {
    expect(toPtyInput("\x1b[57419;2u")).toBe("\x1b[1;2A");
    expect(toPtyInput("\x1b[57417;5u")).toBe("\x1b[1;5D");
    expect(toPtyInput("\x1b[57422;3u")).toBe("\x1b[6;3~");
  });

  it("forwards terminal mouse events unchanged", () => {
    expect(toPtyInput("\x1b[<35;20;5M")).toBe("\x1b[<35;20;5M");
    expect(toPtyInput("\x1b[<0;20;5m")).toBe("\x1b[<0;20;5m");
    expect(toPtyInput("\x1b[M !!")).toBe("\x1b[M !!");
  });

  it("translates physical mouse coordinates into a split overlay", () => {
    const right = { column: 50, row: 0, width: 50, height: 40 };
    expect(translateMouseInput("\x1b[<65;75;20M", right)).toBe("\x1b[<65;25;20M");
    expect(translateMouseInput("\x1b[<0;75;20m", right)).toBe("\x1b[<0;25;20m");
    expect(translateMouseInput("\x1b[<65;25;20M", right)).toBe("");

    const floating = { column: 12, row: 5, width: 75, height: 30 };
    expect(translateMouseInput("\x1b[<35;20;10M", floating)).toBe("\x1b[<35;8;5M");
  });

  it("drops Kitty key-release events", () => {
    expect(toPtyInput("\x1b[99;5:3u")).toBe("");
  });

  it("maps common legacy and modified keys used inside Hunk", () => {
    expect(toPtyInput("\x1b[13u")).toBe("\r");
    expect(toPtyInput("\x1b[27u")).toBe("\x1b");
    expect(toPtyInput("\x1b[9u")).toBe("\t");
    expect(toPtyInput("\x1b[127u")).toBe("\x7f");
    // Kitty arrow key codes already covered for up/left; re-check modifiers for nav.
    expect(toPtyInput("\x1b[57419;2u")).toBe("\x1b[1;2A"); // shift+up
    expect(toPtyInput("\x1b[57417;5u")).toBe("\x1b[1;5D"); // ctrl+left
  });

  it("passes through non-key CSI / leaves undecoded sequences alone", () => {
    // Bracketed-paste enable is not a Kitty key; keep it intact for the PTY.
    expect(toPtyInput("\x1b[?2004h")).toBe("\x1b[?2004h");
    // Unknown private CSI finals should not crash the translator.
    expect(typeof toPtyInput("\x1b[?1000h")).toBe("string");
  });
});
