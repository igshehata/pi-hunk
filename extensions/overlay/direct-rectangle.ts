import { visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const CLOSE_HYPERLINK = "\x1b]8;;\x07";
const ROW_BOUNDARY = RESET + CLOSE_HYPERLINK;

export interface PhysicalRectangle {
  row: number;
  column: number;
  width: number;
  height: number;
  terminalColumns: number;
  terminalRows: number;
}

export interface DirectPaintResult {
  changedRows: number;
  bytes: number;
}

function validateRectangle(rectangle: PhysicalRectangle): void {
  const values = [
    rectangle.row,
    rectangle.column,
    rectangle.width,
    rectangle.height,
    rectangle.terminalColumns,
    rectangle.terminalRows,
  ];
  if (!values.every((value) => Number.isInteger(value))) {
    throw new Error("Direct Hunk rectangle must use integer geometry.");
  }
  if (
    rectangle.row < 0 ||
    rectangle.column < 0 ||
    rectangle.width < 1 ||
    rectangle.height < 1 ||
    rectangle.terminalColumns < 1 ||
    rectangle.terminalRows < 1 ||
    rectangle.column + rectangle.width > rectangle.terminalColumns ||
    rectangle.row + rectangle.height > rectangle.terminalRows
  ) {
    throw new Error("Direct Hunk rectangle is outside the physical terminal.");
  }
}

function assertSafeRow(row: string): void {
  let printable = "";
  for (let index = 0; index < row.length; index++) {
    if (row.charCodeAt(index) !== 27) {
      printable += row[index];
      continue;
    }

    if (row[index + 1] !== "[") {
      throw new Error("Direct Hunk rows may contain only printable text and SGR sequences.");
    }
    let end = index + 2;
    while (end < row.length) {
      const code = row.charCodeAt(end);
      if ((code >= 48 && code <= 57) || code === 59) end += 1;
      else break;
    }
    if (row[end] !== "m") {
      throw new Error("Direct Hunk rows may contain only printable text and SGR sequences.");
    }
    index = end;
  }

  for (const character of printable) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) {
      throw new Error("Direct Hunk rows contain a terminal control character.");
    }
  }
}

function normalizeTerminalText(text: string): string {
  if (!text.includes("\u0e33") && !text.includes("\u0eb3")) return text;
  return text.replaceAll("\u0e33", "\u0e4d\u0e32").replaceAll("\u0eb3", "\u0ecd\u0eb2");
}

function normalizeRows(rows: readonly string[], rectangle: PhysicalRectangle): readonly string[] {
  if (rows.length > rectangle.height) {
    throw new Error("Direct Hunk frame exceeds its rectangle height.");
  }

  const normalized: string[] = [];
  for (let index = 0; index < rectangle.height; index++) {
    const row = normalizeTerminalText(rows[index] ?? "");
    assertSafeRow(row);
    const width = visibleWidth(row);
    if (width > rectangle.width) {
      throw new Error(`Direct Hunk row ${index} exceeds its rectangle width.`);
    }
    normalized.push(`${row}${ROW_BOUNDARY}${" ".repeat(rectangle.width - width)}`);
  }
  return Object.freeze(normalized);
}

function sameRectangle(left: PhysicalRectangle, right: PhysicalRectangle): boolean {
  return (
    left.row === right.row &&
    left.column === right.column &&
    left.width === right.width &&
    left.height === right.height &&
    left.terminalColumns === right.terminalColumns &&
    left.terminalRows === right.terminalRows
  );
}

/**
 * Stateful changed-row painter for an absolute physical terminal rectangle.
 * It never emits relative movement, line erases, or newlines, and disables
 * autowrap while touching the bottom-right cell.
 */
export class DirectRectanglePainter {
  private rectangle: PhysicalRectangle | undefined;
  private previousRows: readonly string[] | undefined;

  constructor(private readonly write: (data: string) => void) {}

  seed(rectangle: PhysicalRectangle, rows: readonly string[]): void {
    validateRectangle(rectangle);
    this.rectangle = { ...rectangle };
    this.previousRows = normalizeRows(rows, rectangle);
  }

  paint(rectangle: PhysicalRectangle, rows: readonly string[]): DirectPaintResult {
    validateRectangle(rectangle);
    if (!this.rectangle || !this.previousRows) {
      throw new Error("Direct Hunk painter has not been seeded by a composed frame.");
    }
    if (!sameRectangle(this.rectangle, rectangle)) {
      throw new Error("Direct Hunk rectangle changed after lease acquisition.");
    }

    const nextRows = normalizeRows(rows, rectangle);
    const changed: number[] = [];
    for (let index = 0; index < rectangle.height; index++) {
      if (this.previousRows[index] !== nextRows[index]) changed.push(index);
    }
    if (changed.length === 0) return { changedRows: 0, bytes: 0 };

    let output =
      "\x1b[?2026h" + // synchronized output begin
      "\x1b[?7s" + // save autowrap mode
      "\x1b[?25s" + // save cursor visibility mode
      "\x1b[?6s" + // save origin mode
      "\x1b7" + // DECSC: save physical cursor position/rendition
      "\x1b[?25l" + // hide cursor
      "\x1b[?7l" + // disable autowrap
      "\x1b[?6l"; // use absolute CUP coordinates

    for (const index of changed) {
      output += ROW_BOUNDARY;
      output += `\x1b[${rectangle.row + index + 1};${rectangle.column + 1}H`;
      output += ROW_BOUNDARY + nextRows[index] + ROW_BOUNDARY;
    }

    output +=
      "\x1b[?6r" + // restore origin mode (may home the cursor)
      "\x1b[?7r" + // restore autowrap mode
      "\x1b8" + // DECRC: restore physical cursor position/rendition
      "\x1b[?25r" + // restore cursor visibility mode
      "\x1b[?2026l"; // synchronized output end

    this.write(output);
    this.previousRows = nextRows;
    return { changedRows: changed.length, bytes: Buffer.byteLength(output) };
  }

  reset(): void {
    this.rectangle = undefined;
    this.previousRows = undefined;
  }
}
