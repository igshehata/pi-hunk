import { describe, expect, it } from "vitest";
import {
  MouseInputTranslator,
  PtyInputEncoder,
  toPtyInput,
  translateMouseInput,
} from "../extensions/overlay/input.ts";

function x10Mouse(code: number, x: number, y: number): string {
  return `\x1b[M${String.fromCharCode(code + 32)}${String.fromCharCode(x + 32)}${String.fromCharCode(y + 32)}`;
}

describe("toPtyInput", () => {
  it("passes legacy, text, paste, and non-key CSI input through", () => {
    expect(toPtyInput("a")).toBe("a");
    expect(toPtyInput("\x1b[A")).toBe("\x1b[A");
    expect(toPtyInput("\x1b[?2004h")).toBe("\x1b[?2004h");
    expect(toPtyInput("\x1b[200~paste \x1b[57364u :3F\x1b[201~")).toBe(
      "\x1b[200~paste \x1b[57364u :3F\x1b[201~",
    );
  });

  it("maps Kitty F1-F12 before PUA printable decoding", () => {
    const functionKeys = [
      [57364, "\x1bOP"],
      [57365, "\x1bOQ"],
      [57366, "\x1bOR"],
      [57367, "\x1bOS"],
      [57368, "\x1b[15~"],
      [57369, "\x1b[17~"],
      [57370, "\x1b[18~"],
      [57371, "\x1b[19~"],
      [57372, "\x1b[20~"],
      [57373, "\x1b[21~"],
      [57374, "\x1b[23~"],
      [57375, "\x1b[24~"],
    ] as const;

    for (const [codepoint, expected] of functionKeys) {
      expect(toPtyInput(`\x1b[${codepoint}u`), `Kitty codepoint ${codepoint}`).toBe(expected);
    }
  });

  it.each([
    ["standard Kitty KP Enter", "\x1b[57414u", "\r"],
    ["standard Kitty Left", "\x1b[57350u", "\x1b[D"],
    ["standard Kitty Page Down", "\x1b[57355u", "\x1b[6~"],
    ["Kitty keypad Up", "\x1b[57419u", "\x1b[A"],
    ["Kitty keypad 7", "\x1b[57406u", "7"],
    ["Kitty keypad Add", "\x1b[57413u", "+"],
    ["Kitty F13 / xterm Shift+F1", "\x1b[57376u", "\x1b[1;2P"],
    ["Kitty F25 / xterm Ctrl+F1", "\x1b[57388u", "\x1b[1;5P"],
  ])("maps broader functional keys: %s", (_name, input, expected) => {
    expect(toPtyInput(input)).toBe(expected);
  });

  it.each([
    ["press", "\x1b[57364;1:1u", "\x1bOP"],
    ["repeat", "\x1b[57364;1:2u", "\x1bOP"],
    ["release", "\x1b[57364;1:3u", ""],
    ["modified repeat", "\x1b[57364;6:2u", "\x1b[1;6P"],
    ["modified release", "\x1b[57364;6:3u", ""],
    ["KP Enter repeat", "\x1b[57414;1:2u", "\r"],
    ["KP Enter release", "\x1b[57414;1:3u", ""],
  ])("handles Kitty event type: %s", (_name, input, expected) => {
    expect(toPtyInput(input)).toBe(expected);
  });

  it.each([
    ["Kitty Shift+Enter degrades to Enter", "\x1b[13;2u", "\r"],
    ["modifyOtherKeys Shift+Enter degrades to Enter", "\x1b[27;2;13~", "\r"],
    ["Kitty Alt+Enter", "\x1b[13;3u", "\x1b\r"],
    ["modifyOtherKeys Alt+Enter", "\x1b[27;3;13~", "\x1b\r"],
    ["Kitty Ctrl+Shift+Enter is suppressed", "\x1b[13;6u", ""],
    ["modifyOtherKeys Ctrl+Enter is suppressed", "\x1b[27;5;13~", ""],
    ["Kitty Shift+Tab", "\x1b[9;2u", "\x1b[Z"],
    ["modifyOtherKeys Alt+Tab", "\x1b[27;3;9~", "\x1b\t"],
    ["Kitty Ctrl+Tab is suppressed", "\x1b[9;5u", ""],
    ["Kitty Alt+Backspace", "\x1b[127;3u", "\x1b\x7f"],
    ["modifyOtherKeys Ctrl+Backspace", "\x1b[27;5;127~", "\x08"],
    ["Kitty Ctrl+Space", "\x1b[32;5u", "\0"],
    ["modifyOtherKeys Ctrl+Alt+Space", "\x1b[27;7;32~", "\x1b\0"],
    ["Kitty shifted digit uses reported glyph", "\x1b[49:33;2u", "!"],
    ["modifyOtherKeys Shift+1 uses xterm identity", "\x1b[27;2;49~", "1"],
    ["Kitty Alt+7", "\x1b[55;3u", "\x1b7"],
    ["modifyOtherKeys Ctrl+2", "\x1b[27;5;50~", "\0"],
    ["Kitty Ctrl+8", "\x1b[56;5u", "\x7f"],
    ["Kitty Ctrl+1 has no classic encoding", "\x1b[49;5u", ""],
    ["Kitty Super+letter is suppressed", "\x1b[97;9u", ""],
    ["modifyOtherKeys Super+digit is suppressed", "\x1b[27;9;49~", ""],
  ])("applies the documented modified-key policy: %s", (_name, input, expected) => {
    expect(toPtyInput(input)).toBe(expected);
  });

  it.each([
    ["Kitty", "\x1b[99;5u", "\x03"],
    ["modifyOtherKeys", "\x1b[27;5;99~", "\x03"],
    ["Kitty Ctrl+Alt", "\x1b[99;7u", "\x1b\x03"],
    ["modifyOtherKeys Ctrl+Alt", "\x1b[27;7;99~", "\x1b\x03"],
  ])("maps printable controls from %s", (_name, input, expected) => {
    expect(toPtyInput(input)).toBe(expected);
  });

  it("converts modified Kitty navigation and function keys to xterm sequences", () => {
    expect(toPtyInput("\x1b[57419;2u")).toBe("\x1b[1;2A");
    expect(toPtyInput("\x1b[57417;5u")).toBe("\x1b[1;5D");
    expect(toPtyInput("\x1b[57422;3u")).toBe("\x1b[6;3~");
    expect(toPtyInput("\x1b[57375;7u")).toBe("\x1b[24;7~");
  });

  it("suppresses unsupported Kitty functional and incompatible keyboard protocol events", () => {
    expect(toPtyInput("\x1b[57358u")).toBe(""); // Caps Lock
    expect(toPtyInput("\x1b[57428u")).toBe(""); // Media Play
    expect(toPtyInput("\x1b[57414;9u")).toBe(""); // Super+KP Enter
    expect(toPtyInput("\x1b[99999;5u")).toBe(""); // Unknown Ctrl+Unicode
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
});

describe("PtyInputEncoder", () => {
  it("reassembles ordinary non-BMP input split into UTF-16 callbacks", () => {
    const encoder = new PtyInputEncoder();
    const emoji = "😀";

    expect(encoder.translate(emoji[0]!)).toBe("");
    expect(encoder.translate(emoji[1]!)).toBe(emoji);
    expect(encoder.translate(emoji)).toBe(emoji);
  });
});

describe("MouseInputTranslator", () => {
  const viewport = { column: 10, row: 5, width: 20, height: 10 };

  it.each([
    {
      protocol: "SGR",
      input: ["\x1b[<16;15;8M", "\x1b[<48;40;20M", "\x1b[<0;40;20m"],
      output: ["\x1b[<16;5;3M", "\x1b[<48;20;10M", "\x1b[<0;20;10m"],
    },
    {
      protocol: "X10",
      input: [x10Mouse(16, 15, 8), x10Mouse(48, 40, 20), x10Mouse(3, 40, 20)],
      output: [x10Mouse(16, 5, 3), x10Mouse(48, 20, 10), x10Mouse(3, 20, 10)],
    },
  ])(
    "captures a modified button for an inside press, outside drag, and outside $protocol release",
    ({ input, output }) => {
      const translator = new MouseInputTranslator();
      expect(input.map((event) => translator.translate(event, viewport))).toEqual(output);
      // The matching release consumed capture; another outside release is unrelated.
      expect(translator.translate(input[2]!, viewport)).toBe("");
    },
  );

  it.each([
    ["SGR wheel", "\x1b[<64;40;20M"],
    ["SGR hover", "\x1b[<35;40;20M"],
    ["SGR button motion without capture", "\x1b[<32;40;20M"],
    ["SGR press", "\x1b[<0;40;20M"],
    ["SGR release", "\x1b[<0;40;20m"],
    ["X10 wheel", x10Mouse(64, 40, 20)],
    ["X10 hover", x10Mouse(35, 40, 20)],
    ["X10 button motion without capture", x10Mouse(32, 40, 20)],
    ["X10 press", x10Mouse(0, 40, 20)],
    ["X10 release", x10Mouse(3, 40, 20)],
  ])("rejects outside %s without applicable capture", (_name, event) => {
    expect(new MouseInputTranslator().translate(event, viewport)).toBe("");
  });

  it("tracks SGR button identities independently and ignores mismatched outside releases", () => {
    const translator = new MouseInputTranslator();
    expect(translator.translate("\x1b[<0;15;8M", viewport)).toBe("\x1b[<0;5;3M");
    expect(translator.translate("\x1b[<2;16;9M", viewport)).toBe("\x1b[<2;6;4M");
    expect(translator.translate("\x1b[<1;40;20m", viewport)).toBe("");
    expect(translator.translate("\x1b[<34;40;20M", viewport)).toBe("\x1b[<34;20;10M");
    expect(translator.translate("\x1b[<2;40;20m", viewport)).toBe("\x1b[<2;20;10m");
    expect(translator.translate("\x1b[<32;0;0M", viewport)).toBe("\x1b[<32;1;1M");
    expect(translator.translate("\x1b[<0;0;0m", viewport)).toBe("\x1b[<0;1;1m");
  });

  it("uses deterministic press order for identity-less X10 releases", () => {
    const translator = new MouseInputTranslator();
    translator.translate(x10Mouse(0, 15, 8), viewport);
    translator.translate(x10Mouse(2, 16, 9), viewport);
    expect(translator.translate(x10Mouse(3, 40, 20), viewport)).toBe(x10Mouse(3, 20, 10));
    expect(translator.translate(x10Mouse(34, 40, 20), viewport)).toBe("");
    expect(translator.translate(x10Mouse(32, 40, 20), viewport)).toBe(x10Mouse(32, 20, 10));
    expect(translator.translate(x10Mouse(3, 0, 0), viewport)).toBe(x10Mouse(3, 1, 1));
    expect(translator.translate(x10Mouse(3, 0, 0), viewport)).toBe("");
  });

  it("reset prevents stale capture from crossing a surface lifecycle boundary", () => {
    const translator = new MouseInputTranslator();
    translator.translate("\x1b[<0;15;8M", viewport);
    translator.reset();
    expect(translator.translate("\x1b[<0;40;20m", viewport)).toBe("");
    expect(translator.translate("\x1b[<32;40;20M", viewport)).toBe("");
  });
});
