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

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const X10_MOUSE = /^\x1b\[M[\s\S]{3}$/;
const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const SUPER = 8;
const LOCKS = 64 | 128;
const XTERM_MODIFIERS = SHIFT | ALT | CTRL;

// xterm mouse Cb packs modifiers and event flags around the button code.
const MOUSE_MODIFIERS = 4 | 8 | 16;
const MOUSE_MOTION = 32;
const MOUSE_WHEEL = 64;

// Kitty reserves this PUA interval for functional keys. Unsupported entries
// (locks, media keys, modifier-only keys, etc.) are deliberately suppressed;
// they must never become printable private-use characters in the child.
const KITTY_FUNCTIONAL_FIRST = 57344;
const KITTY_FUNCTIONAL_LAST = 57454;

interface KeyboardProtocolEvent {
  codepoint: number;
  shiftedCodepoint?: number;
  modifiers: number;
  kitty: boolean;
}

interface FunctionalKey {
  key: string;
  /** F13-F35 are the xterm shift/ctrl variants of F1-F12. */
  inheritedModifiers?: number;
}

function parseKeyboardProtocolEvent(data: string): KeyboardProtocolEvent | undefined {
  const kitty = KITTY_CSI_U.exec(data);
  if (kitty) {
    const modifierParameter = kitty[4] ? Number.parseInt(kitty[4], 10) : 1;
    return {
      codepoint: Number.parseInt(kitty[1]!, 10),
      shiftedCodepoint: kitty[2] && kitty[2].length > 0 ? Number.parseInt(kitty[2], 10) : undefined,
      modifiers: (modifierParameter - 1) & ~LOCKS,
      kitty: true,
    };
  }

  const modifyOtherKeys = MODIFY_OTHER_KEYS.exec(data);
  if (modifyOtherKeys) {
    return {
      codepoint: Number.parseInt(modifyOtherKeys[2]!, 10),
      modifiers: (Number.parseInt(modifyOtherKeys[1]!, 10) - 1) & ~LOCKS,
      kitty: false,
    };
  }
  return undefined;
}

/** Map Kitty's standardized functional PUA codepoints to xterm key identities. */
function kittyFunctionalKey(codepoint: number): FunctionalKey | undefined {
  const named: Record<number, string> = {
    57344: "escape",
    57345: "enter",
    57346: "tab",
    57347: "backspace",
    57348: "insert",
    57349: "delete",
    57350: "left",
    57351: "right",
    57352: "up",
    57353: "down",
    57354: "pageUp",
    57355: "pageDown",
    57356: "home",
    57357: "end",
    // Kitty keypad keys. Numeric/operator keys intentionally behave as text;
    // keypad navigation behaves like its non-keypad xterm counterpart.
    57399: "0",
    57400: "1",
    57401: "2",
    57402: "3",
    57403: "4",
    57404: "5",
    57405: "6",
    57406: "7",
    57407: "8",
    57408: "9",
    57409: ".",
    57410: "/",
    57411: "*",
    57412: "-",
    57413: "+",
    57414: "enter",
    57415: "=",
    57416: ",",
    57417: "left",
    57418: "right",
    57419: "up",
    57420: "down",
    57421: "pageUp",
    57422: "pageDown",
    57423: "home",
    57424: "end",
    57425: "insert",
    57426: "delete",
  };
  const key = named[codepoint];
  if (key) return { key };

  // xterm exposes F13-F24 as Shift+F1-F12 and F25-F35 as Ctrl+F1-F11.
  // This intentionally extends the required F1-F12 support without inventing
  // bytes that xterm-256color applications cannot identify.
  if (codepoint >= 57364 && codepoint <= 57375) {
    return { key: `f${codepoint - 57363}` };
  }
  if (codepoint >= 57376 && codepoint <= 57387) {
    return { key: `f${codepoint - 57375}`, inheritedModifiers: SHIFT };
  }
  if (codepoint >= 57388 && codepoint <= 57398) {
    return { key: `f${codepoint - 57387}`, inheritedModifiers: CTRL };
  }
  return undefined;
}

export interface MouseViewport {
  column: number;
  row: number;
  width: number;
  height: number;
}

type MouseProtocol = "sgr" | "x10";

interface MouseEventState {
  button: number;
  motion: boolean;
  wheel: boolean;
  release: boolean;
  /** X10 and old-style SGR encode release as button 3, without an identity. */
  anonymousRelease: boolean;
}

function mouseEventState(code: number, protocol: MouseProtocol, final?: string): MouseEventState {
  const motion = (code & MOUSE_MOTION) !== 0;
  const button = code & ~(MOUSE_MODIFIERS | MOUSE_MOTION);
  const wheel = (button & MOUSE_WHEEL) !== 0;
  const anonymousRelease =
    !motion && !wheel && button === 3 && (protocol === "x10" || final === "M");
  return {
    button,
    motion,
    wheel,
    release: protocol === "sgr" ? final === "m" || anonymousRelease : anonymousRelease,
    anonymousRelease,
  };
}

function clampCoordinate(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(1, value));
}

/**
 * Per-surface physical-to-local mouse translator.
 *
 * A button pressed inside the viewport is captured until its protocol's
 * matching release. Captured drag/release events outside are clamped to the
 * current viewport edge; unrelated outside events remain rejected.
 */
export class MouseInputTranslator {
  private readonly captured = {
    sgr: new Set<number>(),
    x10: new Set<number>(),
  };
  /** Needed for identity-less legacy releases; most recently pressed wins. */
  private readonly pressOrder = {
    sgr: [] as number[],
    x10: [] as number[],
  };

  reset(): void {
    this.captured.sgr.clear();
    this.captured.x10.clear();
    this.pressOrder.sgr.length = 0;
    this.pressOrder.x10.length = 0;
  }

  translate(data: string, viewport: MouseViewport): string {
    const sgr = SGR_MOUSE.exec(data);
    if (sgr) {
      const code = Number.parseInt(sgr[1]!, 10);
      const state = mouseEventState(code, "sgr", sgr[4]);
      const coordinates = this.coordinates(
        Number.parseInt(sgr[2]!, 10),
        Number.parseInt(sgr[3]!, 10),
        viewport,
        "sgr",
        state,
      );
      if (!coordinates) return "";
      return `\x1b[<${code};${coordinates.x};${coordinates.y}${sgr[4]}`;
    }

    if (X10_MOUSE.test(data)) {
      const code = data.charCodeAt(3) - 32;
      const state = mouseEventState(code, "x10");
      const coordinates = this.coordinates(
        data.charCodeAt(4) - 32,
        data.charCodeAt(5) - 32,
        viewport,
        "x10",
        state,
      );
      if (!coordinates) return "";
      return `${data.slice(0, 4)}${String.fromCharCode(coordinates.x + 32)}${String.fromCharCode(coordinates.y + 32)}`;
    }
    return data;
  }

  private coordinates(
    physicalX: number,
    physicalY: number,
    viewport: MouseViewport,
    protocol: MouseProtocol,
    state: MouseEventState,
  ): { x: number; y: number } | undefined {
    if (viewport.width < 1 || viewport.height < 1) return undefined;
    const x = physicalX - viewport.column;
    const y = physicalY - viewport.row;
    const inside = x >= 1 && x <= viewport.width && y >= 1 && y <= viewport.height;
    const captures = this.captured[protocol];
    const order = this.pressOrder[protocol];

    let matchingCapture = false;
    let releasedButton: number | undefined;
    if (state.anonymousRelease) {
      releasedButton = order.at(-1);
      matchingCapture = releasedButton !== undefined;
    } else if (state.release || state.motion) {
      matchingCapture = captures.has(state.button);
      if (state.release && matchingCapture) releasedButton = state.button;
    }

    // Wheel events never establish/use capture. Button-less hover (Cb 35) also
    // cannot borrow another active button's capture.
    if (!inside && (!matchingCapture || state.wheel)) return undefined;

    if (state.release && releasedButton !== undefined) {
      captures.delete(releasedButton);
      const index = order.lastIndexOf(releasedButton);
      if (index >= 0) order.splice(index, 1);
    } else if (inside && !state.motion && !state.wheel && !state.release && state.button !== 3) {
      if (!captures.has(state.button)) order.push(state.button);
      captures.add(state.button);
    }

    return {
      x: inside ? x : clampCoordinate(x, viewport.width),
      y: inside ? y : clampCoordinate(y, viewport.height),
    };
  }
}

/** One-shot coordinate translation for callers that do not need capture state. */
export function translateMouseInput(data: string, viewport: MouseViewport): string {
  return new MouseInputTranslator().translate(data, viewport);
}

function xtermModifiedKey(base: string, modifiers: number): string | undefined {
  const modifierParameter = 1 + (modifiers & XTERM_MODIFIERS);
  if (modifierParameter === 1) return undefined;
  if (CSI_FINAL[base]) return `\x1b[1;${modifierParameter}${CSI_FINAL[base]}`;
  if (CSI_TILDE[base]) return `\x1b[${CSI_TILDE[base]};${modifierParameter}~`;
  return undefined;
}

function controlCharacter(base: string): string | undefined {
  if (/^[a-z]$/.test(base)) return String.fromCharCode(base.charCodeAt(0) - 96);
  const controls: Record<string, string> = {
    "@": "\0",
    "2": "\0",
    "[": "\x1b",
    "3": "\x1b",
    "\\": "\x1c",
    "4": "\x1c",
    "]": "\x1d",
    "5": "\x1d",
    "^": "\x1e",
    "6": "\x1e",
    _: "\x1f",
    "-": "\x1f",
    "7": "\x1f",
    "?": "\x7f",
    "8": "\x7f",
  };
  return controls[base];
}

function shiftedAscii(base: string): string {
  if (/^[a-z]$/.test(base)) return base.toUpperCase();
  const shifted: Record<string, string> = {
    "1": "!",
    "2": "@",
    "3": "#",
    "4": "$",
    "5": "%",
    "6": "^",
    "7": "&",
    "8": "*",
    "9": "(",
    "0": ")",
    "`": "~",
    "-": "_",
    "=": "+",
    "[": "{",
    "]": "}",
    "\\": "|",
    ";": ":",
    "'": '"',
    ",": "<",
    ".": ">",
    "/": "?",
  };
  return shifted[base] ?? base;
}

/**
 * Encode a parsed key without leaking Kitty/modifyOtherKeys bytes to Hunk.
 *
 * Policy for keys with no lossless classic VT representation:
 * - Super/Hyper/Meta combinations are suppressed.
 * - Shift degrades for Enter, Backspace, and Space; Alt remains an ESC prefix.
 * - Ctrl+Enter and Ctrl+Tab are suppressed (there is no distinct classic code).
 * - Ctrl+Backspace uses BS, Ctrl+Space uses NUL, and Ctrl+2..8 use the classic
 *   ASCII control aliases; Ctrl+0/1/9 are suppressed.
 * - Shift+Tab uses Backtab. Alt+Tab prefixes either Tab or Backtab with ESC.
 * - Shifted CSI-u digits use Kitty's reported alternate when present.
 *   modifyOtherKeys has no alternate field, so its reported codepoint is used;
 *   Alt+Shift key IDs fall back to the conventional xterm/US identity.
 */
function translateKey(key: string, inheritedModifiers = 0): string {
  // "+" is itself a Pi key ID, so modified forms end in a delimiter ("ctrl++").
  const plusKey = key.endsWith("+");
  const parts = plusKey ? key.slice(0, -1).split("+").filter(Boolean) : key.split("+");
  const base = plusKey ? "+" : parts.pop();
  if (!base) return "";
  let modifiers = inheritedModifiers;
  if (parts.includes("shift")) modifiers |= SHIFT;
  if (parts.includes("alt")) modifiers |= ALT;
  if (parts.includes("ctrl")) modifiers |= CTRL;
  if (parts.includes("super")) modifiers |= SUPER;

  if ((modifiers & ~XTERM_MODIFIERS) !== 0) return "";
  const shift = (modifiers & SHIFT) !== 0;
  const alt = (modifiers & ALT) !== 0;
  const ctrl = (modifiers & CTRL) !== 0;

  if (base === "enter" || base === "return") {
    if (ctrl) return "";
    return `${alt ? "\x1b" : ""}\r`;
  }
  if (base === "tab") {
    if (ctrl) return "";
    const tab = shift ? "\x1b[Z" : "\t";
    return alt ? `\x1b${tab}` : tab;
  }
  if (base === "backspace") {
    const backspace = ctrl ? "\x08" : "\x7f";
    return alt ? `\x1b${backspace}` : backspace;
  }
  if (base === "space") {
    const space = ctrl ? "\0" : " ";
    return alt ? `\x1b${space}` : space;
  }
  if (base === "escape") {
    if (ctrl) return "";
    return alt ? "\x1b\x1b" : "\x1b";
  }

  if (CSI_FINAL[base] || CSI_TILDE[base]) {
    return xtermModifiedKey(base, modifiers) ?? VT_KEYS[base] ?? "";
  }

  if (base.length === 1) {
    if (ctrl) {
      const control = controlCharacter(base);
      if (control === undefined) return "";
      return alt ? `\x1b${control}` : control;
    }
    const printable = shift ? shiftedAscii(base) : base;
    return alt ? `\x1b${printable}` : printable;
  }
  return VT_KEYS[key] ?? "";
}

/** Translate an Alt-modified Unicode protocol event that parseKey cannot name. */
function translateProtocolPrintable(event: KeyboardProtocolEvent): string {
  if ((event.modifiers & ~XTERM_MODIFIERS) !== 0 || (event.modifiers & CTRL) !== 0) return "";
  const codepoint =
    event.modifiers & SHIFT && event.shiftedCodepoint !== undefined
      ? event.shiftedCodepoint
      : event.codepoint;
  if (codepoint < 32 || codepoint > 0x10ffff) return "";
  try {
    const printable = String.fromCodePoint(codepoint);
    return event.modifiers & ALT ? `\x1b${printable}` : printable;
  } catch {
    return "";
  }
}

/** Convert Pi's Kitty/modifyOtherKeys events back to conventional xterm PTY input. */
export function toPtyInput(data: string): string {
  // Press and repeat have identical PTY semantics. Releases never reach Hunk.
  if (isKeyRelease(data)) return "";
  if (!data.startsWith("\x1b[")) return data;
  if (SGR_MOUSE.test(data) || X10_MOUSE.test(data)) return data;

  const protocol = parseKeyboardProtocolEvent(data);
  if (protocol?.kitty) {
    // Functional PUA keys must be recognized before printable decoding, which
    // otherwise turns them into literal U+E000-range text.
    const functional = kittyFunctionalKey(protocol.codepoint);
    if (functional) {
      return translateKey(
        functional.key,
        protocol.modifiers | (functional.inheritedModifiers ?? 0),
      );
    }
    if (
      protocol.codepoint >= KITTY_FUNCTIONAL_FIRST &&
      protocol.codepoint <= KITTY_FUNCTIONAL_LAST
    ) {
      return "";
    }
  }

  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return kittyPrintable;
  // Pi accepts printable modifyOtherKeys forms but only exports its Kitty
  // decoder. Mirror parseKey's semantics here: plain/Shift use the reported
  // codepoint (modifyOtherKeys has no shifted alternate-codepoint field).
  if (
    protocol &&
    !protocol.kitty &&
    (protocol.modifiers & ~SHIFT) === 0 &&
    protocol.codepoint >= 32 &&
    protocol.codepoint <= 0x10ffff
  ) {
    try {
      return String.fromCodePoint(protocol.codepoint);
    } catch {
      return "";
    }
  }

  const key = parseKey(data);
  if (key) return translateKey(key);

  // A syntactically valid keyboard-protocol event is either translated or
  // intentionally suppressed. Raw CSI-u/modifyOtherKeys is incompatible with
  // the xterm-256color child and must not be silently forwarded.
  if (protocol) return translateProtocolPrintable(protocol);
  return data;
}
