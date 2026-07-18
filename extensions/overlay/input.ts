import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

/**
 * Conventional VT/PTY byte sequences for unmodified named keys. Hunk's child
 * PTY speaks classic VT input, not Pi's Kitty keyboard protocol, so parsed
 * Kitty events are re-encoded through this table before pty.write().
 */
const VT_KEYS: Record<string, string> = {
  escape: "\x1b",
  enter: "\r",
  return: "\r",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

const CSI_FINAL: Record<string, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
  f1: "P",
  f2: "Q",
  f3: "R",
  f4: "S",
};

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const X10_MOUSE = /^\x1b\[M[\s\S]{3}$/;

export interface MouseViewport {
  column: number;
  row: number;
  width: number;
  height: number;
}

/** Translate physical-terminal mouse coordinates into overlay-local coordinates. */
export function translateMouseInput(data: string, viewport: MouseViewport): string {
  const sgr = SGR_MOUSE.exec(data);
  if (sgr) {
    const x = Number.parseInt(sgr[2]!, 10) - viewport.column;
    const y = Number.parseInt(sgr[3]!, 10) - viewport.row;
    if (x < 1 || x > viewport.width || y < 1 || y > viewport.height) return "";
    return `\x1b[<${sgr[1]};${x};${y}${sgr[4]}`;
  }

  if (X10_MOUSE.test(data)) {
    const x = data.charCodeAt(4) - 32 - viewport.column;
    const y = data.charCodeAt(5) - 32 - viewport.row;
    if (x < 1 || x > viewport.width || y < 1 || y > viewport.height) return "";
    return `${data.slice(0, 4)}${String.fromCharCode(x + 32)}${String.fromCharCode(y + 32)}`;
  }
  return data;
}

const CSI_TILDE: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

/** VT encoding for modifier+key combos (CSI 1;mod final and CSI code;mod ~ forms). */
function modifiedVtKey(key: string): string | undefined {
  const parts = key.split("+");
  const base = parts.pop();
  if (!base || parts.includes("super")) return undefined;
  const modifiers = new Set(parts);

  if (modifiers.has("ctrl") && /^[a-z]$/.test(base)) {
    const control = String.fromCharCode(base.charCodeAt(0) - 96);
    return modifiers.has("alt") ? `\x1b${control}` : control;
  }
  if (modifiers.size === 1 && modifiers.has("alt") && base.length === 1) return `\x1b${base}`;
  if ((base === "enter" || base === "return") && modifiers.has("alt")) return "\x1b\r";
  if ((base === "enter" || base === "return") && modifiers.has("shift")) return "\r";
  if (base === "space" && modifiers.has("ctrl")) return modifiers.has("alt") ? "\x1b\0" : "\0";

  const modifier =
    1 +
    (modifiers.has("shift") ? 1 : 0) +
    (modifiers.has("alt") ? 2 : 0) +
    (modifiers.has("ctrl") ? 4 : 0);
  if (modifier === 1) return undefined;
  if (CSI_FINAL[base]) return `\x1b[1;${modifier}${CSI_FINAL[base]}`;
  if (CSI_TILDE[base]) return `\x1b[${CSI_TILDE[base]};${modifier}~`;
  return undefined;
}

/** Convert Pi's Kitty-protocol key events back to conventional PTY input. */
export function toPtyInput(data: string): string {
  if (isKeyRelease(data)) return "";
  if (!data.startsWith("\x1b[")) return data;
  if (SGR_MOUSE.test(data) || X10_MOUSE.test(data)) return data;

  const printable = decodeKittyPrintable(data);
  if (printable !== undefined) return printable;

  const key = parseKey(data);
  if (!key) return data;
  if (VT_KEYS[key] !== undefined) return VT_KEYS[key];
  return modifiedVtKey(key) ?? data;
}
