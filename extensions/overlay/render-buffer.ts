import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const OUTER_STYLE = "font-family: monospace; white-space: pre;";
const STYLE_CACHE_LIMIT = 2048;
const STYLE_CACHE = new Map<string, string>();

function decodeEntity(entity: string): string {
  if (entity === "&amp;") return "&";
  if (entity === "&lt;") return "<";
  if (entity === "&gt;") return ">";
  if (entity === "&quot;") return '"';
  if (entity === "&apos;") return "'";

  const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
  if (hex) return String.fromCodePoint(Number.parseInt(hex[1]!, 16));
  const decimal = /^&#(\d+);$/.exec(entity);
  if (decimal) return String.fromCodePoint(Number.parseInt(decimal[1]!, 10));
  return entity;
}

function decodeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, decodeEntity);
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

/**
 * Convert libghostty's fast native HTML snapshot into Pi-compatible ANSI rows.
 *
 * libghostty performs VT parsing, grapheme handling, palette resolution, and
 * screen formatting natively. The HTML formatter crosses Node's native boundary
 * once per frame; this parser only translates its inline styles to SGR and pads
 * the resulting rows to the overlay width.
 */
export function renderGhosttyHtml(html: string, columns: number, rows: number): string[] {
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
  return lines.map((line) => {
    const lineWidth = visibleWidth(line);
    if (lineWidth <= width) {
      return line + RESET + " ".repeat(width - lineWidth);
    }
    const normalized = truncateToWidth(line + RESET, width, "", true);
    return normalized + " ".repeat(Math.max(0, width - visibleWidth(normalized)));
  });
}
