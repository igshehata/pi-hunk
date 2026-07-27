import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const OUTER_STYLE = "font-family: monospace; white-space: pre;";
const STYLE_CACHE_LIMIT = 2048;
const STYLE_CACHE = new Map<string, string>();
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SGR_PATTERN = new RegExp(String.raw`^\x1b\[[0-?]*[ -/]*m`);
const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`,
);

export interface TerminalCursor {
  /** Zero-based viewport row reported by libghostty. */
  row: number;
  /** Zero-based terminal column reported by libghostty. */
  column: number;
  visible: boolean;
}

const REPLACEMENT_CHARACTER = "\ufffd";

function isSafeTextCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 32 &&
    codePoint <= 0x10ffff &&
    codePoint !== 127 &&
    (codePoint < 128 || codePoint > 159) &&
    (codePoint < 0xd800 || codePoint > 0xdfff)
  );
}

function safeCodePoint(codePoint: number): string {
  return isSafeTextCodePoint(codePoint) ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
}

function decodeEntity(entity: string): string {
  if (entity === "&amp;") return "&";
  if (entity === "&lt;") return "<";
  if (entity === "&gt;") return ">";
  if (entity === "&quot;") return '"';
  if (entity === "&apos;") return "'";

  const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
  if (hex) return safeCodePoint(Number.parseInt(hex[1]!, 16));
  const decimal = /^&#(\d+);$/.exec(entity);
  if (decimal) return safeCodePoint(Number.parseInt(decimal[1]!, 10));
  // A syntactically entity-shaped numeric reference with malformed digits is
  // data corruption, not literal terminal text. Replace it deterministically.
  if (entity.startsWith("&#")) return REPLACEMENT_CHARACTER;
  return entity;
}

function sanitizeRawHtmlText(text: string): string {
  let sanitized = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    // Formatter line endings describe viewport rows, unlike numeric entities
    // for C0 values, which decodeEntity has already replaced.
    if (codePoint === 10 || codePoint === 13) sanitized += character;
    else sanitized += isSafeTextCodePoint(codePoint) ? character : REPLACEMENT_CHARACTER;
  }
  return sanitized;
}

function decodeHtml(text: string): string {
  const sanitized = sanitizeRawHtmlText(text);
  if (!sanitized.includes("&")) return sanitized;
  return sanitized.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[^;&<>\s]*|[^;&<>\s]*));/gi, decodeEntity);
}

function colorCode(value: string, foreground: boolean): string | undefined {
  if (value.startsWith("rgb(")) {
    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
    if (rgb) return `${foreground ? 38 : 48};2;${rgb[1]};${rgb[2]};${rgb[3]}`;
    return undefined;
  }

  if (value.startsWith("var(--vt-palette-")) {
    const palette = /^var\(--vt-palette-(\d+)\)$/.exec(value);
    if (palette) return `${foreground ? 38 : 48};5;${palette[1]}`;
  }
  return undefined;
}

/** Convert one libghostty HTML formatter style into equivalent terminal SGR. */
function styleSequence(style: string): string {
  if (!style || style === OUTER_STYLE) return "";

  let fontWeight = "";
  let opacity = "";
  let fontStyle = "";
  let decoration = "";
  let filter = "";
  let visibility = "";
  let foreground = "";
  let background = "";

  let declarationStart = 0;
  while (declarationStart < style.length) {
    while (declarationStart < style.length && style.charCodeAt(declarationStart) <= 32) {
      declarationStart += 1;
    }
    const separator = style.indexOf(":", declarationStart);
    let declarationEnd = style.indexOf(";", declarationStart);
    if (declarationEnd === -1) declarationEnd = style.length;
    if (separator === -1 || separator > declarationEnd) {
      declarationStart = declarationEnd + 1;
      continue;
    }

    let propertyEnd = separator;
    while (propertyEnd > declarationStart && style.charCodeAt(propertyEnd - 1) <= 32) {
      propertyEnd -= 1;
    }
    let valueStart = separator + 1;
    while (valueStart < declarationEnd && style.charCodeAt(valueStart) <= 32) valueStart += 1;
    let valueEnd = declarationEnd;
    while (valueEnd > valueStart && style.charCodeAt(valueEnd - 1) <= 32) valueEnd -= 1;

    const property = style.slice(declarationStart, propertyEnd);
    const value = style.slice(valueStart, valueEnd);
    switch (property) {
      case "font-weight":
        fontWeight = value;
        break;
      case "opacity":
        opacity = value;
        break;
      case "font-style":
        fontStyle = value;
        break;
      case "text-decoration-line":
        decoration = value;
        break;
      case "filter":
        filter = value;
        break;
      case "visibility":
        visibility = value;
        break;
      case "color":
        foreground = value;
        break;
      case "background-color":
        background = value;
        break;
    }
    declarationStart = declarationEnd + 1;
  }

  const codes: string[] = [];
  if (fontWeight === "bold") codes.push("1");
  if (opacity === "0.5") codes.push("2");
  if (fontStyle === "italic") codes.push("3");
  if (/\bunderline\b/.test(decoration)) codes.push("4");
  if (/\bblink\b/.test(decoration)) codes.push("5");
  if (filter === "invert(100%)") codes.push("7");
  if (visibility === "hidden") codes.push("8");
  if (/\bline-through\b/.test(decoration)) codes.push("9");
  if (/\boverline\b/.test(decoration)) codes.push("53");

  const foregroundCode = foreground && colorCode(foreground, true);
  if (foregroundCode) codes.push(foregroundCode);
  const backgroundCode = background && colorCode(background, false);
  if (backgroundCode) codes.push(backgroundCode);

  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function styleAttribute(tag: string): string {
  const marker = 'style="';
  const start = tag.indexOf(marker);
  if (start === -1) return "";
  const valueStart = start + marker.length;
  const end = tag.indexOf('"', valueStart);
  return end === -1 ? "" : decodeHtml(tag.slice(valueStart, end));
}

function cachedStyleSequence(style: string): string {
  const cached = STYLE_CACHE.get(style);
  if (cached !== undefined) return cached;
  const sequence = styleSequence(style);
  // Theme/style sets are normally tiny. Stop admitting new entries at the
  // bound so adversarial truecolor churn cannot grow memory or thrash the cache.
  if (STYLE_CACHE.size < STYLE_CACHE_LIMIT) STYLE_CACHE.set(style, sequence);
  return sequence;
}

/** Reshape an already published snapshot without consulting a partial VT buffer. */
export function resizeRenderedLines(
  lines: readonly string[],
  columns: number,
  rows: number,
): string[] {
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);
  const resized = lines.slice(0, height);
  while (resized.length < height) resized.push("");
  return resized.map((line) => {
    const lineWidth = visibleWidth(line);
    if (lineWidth <= width) return line + " ".repeat(width - lineWidth);
    const normalized = truncateToWidth(line + RESET, width, "", true);
    return normalized + " ".repeat(Math.max(0, width - visibleWidth(normalized)));
  });
}

function sgrState(sequence: string, state: { inverse: boolean }): void {
  const parameters = sequence.slice(2, -1);
  // Private/intermediate CSI sequences are not standard SGR. Do not infer
  // inverse state from numbers which have some other meaning in those forms.
  if (!/^[\d:;]*$/.test(parameters)) return;

  const fields = parameters === "" ? [""] : parameters.split(";");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const primary = field.split(":", 1)[0]!;
    const code = primary === "" ? 0 : /^\d+$/.test(primary) ? Number(primary) : undefined;
    if (code === undefined) continue;

    if (code === 38 || code === 48 || code === 58) {
      // A colon-form color and all of its subparameters occupy one field.
      if (field.includes(":")) continue;

      // In the widespread semicolon form, the following fields are color
      // payload, not independent SGR commands. In particular, RGB/palette
      // values 0, 7, and 27 must never reset or toggle inverse state.
      const modeField = fields[index + 1];
      if (modeField === undefined) continue;
      const modePrimary = modeField.split(":", 1)[0]!;
      const mode = /^\d+$/.test(modePrimary) ? Number(modePrimary) : undefined;
      if (mode === 2) index += modeField.includes(":") ? 1 : 4;
      else if (mode === 5) index += modeField.includes(":") ? 1 : 2;
      else index += 1;
      continue;
    }

    if (code === 0 || code === 27) state.inverse = false;
    else if (code === 7) state.inverse = true;
  }
}

/**
 * Invert the grapheme occupying a terminal cursor column by toggling only the
 * inverse attribute. Every other live SGR attribute remains untouched, and a
 * cursor on either half of a wide cell marks the complete cell without
 * adding/removing display columns.
 */
export function paintTerminalCursor(line: string, column: number): string {
  if (!Number.isInteger(column) || column < 0 || column >= visibleWidth(line)) return line;

  const state = { inverse: false };
  let currentColumn = 0;
  let output = "";
  let offset = 0;

  while (offset < line.length) {
    const sgr = SGR_PATTERN.exec(line.slice(offset));
    if (sgr) {
      output += sgr[0];
      sgrState(sgr[0], state);
      offset += sgr[0].length;
      continue;
    }

    const escape = ANSI_ESCAPE_PATTERN.exec(line.slice(offset));
    if (escape) {
      output += escape[0];
      offset += escape[0].length;
      continue;
    }

    const nextEscape = line.indexOf("\x1b", offset);
    const textEnd = nextEscape === -1 ? line.length : nextEscape;
    if (textEnd === offset) {
      // Be defensive around malformed/non-SGR escapes even though HTML
      // translation emits only well-formed SGR.
      output += line[offset];
      offset += 1;
      continue;
    }
    const text = line.slice(offset, textEnd);
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
      const cellWidth = visibleWidth(segment);
      if (cellWidth > 0 && column >= currentColumn && column < currentColumn + cellWidth) {
        const cursorStyle = state.inverse ? "\x1b[27m" : "\x1b[7m";
        const restoreInverse = state.inverse ? "\x1b[7m" : "\x1b[27m";
        output += cursorStyle + segment + restoreInverse;
        output += text.slice(index + segment.length);
        if (textEnd < line.length) output += line.slice(textEnd);
        return output;
      }
      output += segment;
      currentColumn += cellWidth;
    }
    offset = textEnd;
    if (nextEscape === -1) break;
  }
  return line;
}

/**
 * Convert libghostty's fast native HTML snapshot into Pi-compatible ANSI rows.
 *
 * libghostty performs VT parsing, grapheme handling, palette resolution, and
 * screen formatting natively. The HTML formatter crosses Node's native boundary
 * once per frame; this parser only translates its inline styles to SGR and pads
 * the resulting rows to the overlay width.
 */
export function renderGhosttyHtml(
  html: string,
  columns: number,
  rows: number,
  terminalCursor?: TerminalCursor,
): string[] {
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);
  const output = [""];
  const styleStack: string[] = [];
  let activeStyle = "";

  const append = (text: string): void => {
    if (!text) return;
    if (!text.includes("\n") && !text.includes("\r")) {
      output[output.length - 1] += text;
      return;
    }

    const parts = text.split(/\r\n|\r|\n/);
    output[output.length - 1] += parts[0] ?? "";
    for (let index = 1; index < parts.length; index++) {
      output.push(activeStyle + (parts[index] ?? ""));
    }
  };

  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) {
      append(decodeHtml(html.slice(cursor)));
      break;
    }
    if (tagStart > cursor) append(decodeHtml(html.slice(cursor, tagStart)));

    const tagEnd = html.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      append(decodeHtml(html.slice(tagStart)));
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    if (tag.startsWith("</")) {
      if (styleStack.length > 0) styleStack.pop();
      activeStyle = styleStack.at(-1) ?? "";
      if (activeStyle || output[output.length - 1]) append(RESET + activeStyle);
    } else if (/^<br\b/i.test(tag)) {
      append("\n");
    } else {
      const sequence = cachedStyleSequence(styleAttribute(tag));
      activeStyle += sequence;
      styleStack.push(activeStyle);
      if (sequence) append(RESET + activeStyle);
    }
    cursor = tagEnd + 1;
  }

  // The formatter trims ordinary trailing blanks and may omit untouched rows.
  // Restore the fixed terminal viewport expected by Pi's overlay component.
  const lines = output.slice(0, height);
  while (lines.length < height) lines.push("");
  const normalizedLines = lines.map((line) => {
    const lineWidth = visibleWidth(line);
    if (lineWidth <= width) {
      return line + RESET + " ".repeat(width - lineWidth);
    }
    const normalized = truncateToWidth(line + RESET, width, "", true);
    return normalized + " ".repeat(Math.max(0, width - visibleWidth(normalized)));
  });

  if (
    terminalCursor?.visible &&
    Number.isInteger(terminalCursor.row) &&
    terminalCursor.row >= 0 &&
    terminalCursor.row < height &&
    Number.isInteger(terminalCursor.column) &&
    terminalCursor.column >= 0 &&
    terminalCursor.column < width
  ) {
    normalizedLines[terminalCursor.row] = paintTerminalCursor(
      normalizedLines[terminalCursor.row]!,
      terminalCursor.column,
    );
  }
  return normalizedLines;
}
