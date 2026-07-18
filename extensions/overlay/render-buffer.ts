import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const OUTER_STYLE = "font-family: monospace; white-space: pre;";

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
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, decodeEntity);
}

function colorCode(value: string, foreground: boolean): string | undefined {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
  if (rgb) {
    return `${foreground ? 38 : 48};2;${rgb[1]};${rgb[2]};${rgb[3]}`;
  }

  const palette = /^var\(--vt-palette-(\d+)\)$/.exec(value);
  if (palette) return `${foreground ? 38 : 48};5;${palette[1]}`;
  return undefined;
}

/** Convert one libghostty HTML formatter style into equivalent terminal SGR. */
function styleSequence(style: string): string {
  if (!style || style === OUTER_STYLE) return "";

  const properties = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    properties.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
  }

  const codes: string[] = [];
  if (properties.get("font-weight") === "bold") codes.push("1");
  if (properties.get("opacity") === "0.5") codes.push("2");
  if (properties.get("font-style") === "italic") codes.push("3");

  const decoration = properties.get("text-decoration-line") ?? "";
  if (/\bunderline\b/.test(decoration)) codes.push("4");
  if (/\bblink\b/.test(decoration)) codes.push("5");
  if (properties.get("filter") === "invert(100%)") codes.push("7");
  if (properties.get("visibility") === "hidden") codes.push("8");
  if (/\bline-through\b/.test(decoration)) codes.push("9");
  if (/\boverline\b/.test(decoration)) codes.push("53");

  const foreground = properties.get("color");
  const foregroundCode = foreground && colorCode(foreground, true);
  if (foregroundCode) codes.push(foregroundCode);
  const background = properties.get("background-color");
  const backgroundCode = background && colorCode(background, false);
  if (backgroundCode) codes.push(backgroundCode);

  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function styleAttribute(tag: string): string {
  const match = /\bstyle="([^"]*)"/.exec(tag);
  return match ? decodeHtml(match[1]!) : "";
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

  const append = (text: string): void => {
    const parts = text.split(/\r\n|\r|\n/);
    output[output.length - 1] += parts[0] ?? "";
    for (let index = 1; index < parts.length; index++) {
      output.push("");
      const activeStyle = styleStack.join("");
      if (activeStyle) output[output.length - 1] += activeStyle;
      output[output.length - 1] += parts[index] ?? "";
    }
  };

  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      if (styleStack.length > 0) styleStack.pop();
      const activeStyle = styleStack.join("");
      if (activeStyle || output[output.length - 1]) append(RESET + activeStyle);
      continue;
    }
    if (token.startsWith("<")) {
      if (/^<br\b/i.test(token)) {
        append("\n");
        continue;
      }
      const sequence = styleSequence(styleAttribute(token));
      styleStack.push(sequence);
      if (sequence) append(RESET + styleStack.join(""));
      continue;
    }
    append(decodeHtml(token));
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
