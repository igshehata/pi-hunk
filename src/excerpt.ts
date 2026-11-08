/**
 * The reviewed diff lines a saved comment talks about.
 *
 * Hunk hands the bridge each file's exact patch, so a note can carry its own
 * evidence instead of borrowing today's files. Pure: the caller supplies the
 * patch, the note's inclusive old/new line ranges, and nothing else.
 */

/** Context lines kept on each side of the selected lines. */
const CONTEXT = 3;

/** Whole-excerpt budget, so one note cannot flood the handoff. */
const MAX_BODY_LINES = 40;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface DiffLine {
  /** `" "`, `"-"`, `"+"`, or `"\\"` for a no-newline marker. */
  readonly marker: string;
  readonly oldNumber?: number;
  readonly newNumber?: number;
  /** The line exactly as it appears in the patch, marker included. */
  readonly text: string;
}

interface Hunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

/** Split a unified diff into hunks, numbering every line on the side it belongs to. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: { header: string; lines: DiffLine[] } | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let bodyComplete = false;

  const flush = (): void => {
    if (hunk) hunks.push(hunk);
    hunk = undefined;
  };

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      oldNumber = Number(header[1]);
      newNumber = Number(header[3]);
      // A missing count means exactly one line.
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      bodyComplete = false;
      hunk = { header: line, lines: [] };
      continue;
    }
    if (!hunk) continue;
    if (bodyComplete) {
      // `\ No newline at end of file` belongs to the hunk it follows.
      if (line.startsWith("\\")) {
        hunk.lines.push({ marker: "\\", text: line });
        continue;
      }
      flush();
      continue;
    }
    const marker = line[0];
    if (marker === " ") {
      hunk.lines.push({ marker, oldNumber, newNumber, text: line });
      oldNumber += 1;
      newNumber += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (marker === "-") {
      hunk.lines.push({ marker, oldNumber, text: line });
      oldNumber += 1;
      oldRemaining -= 1;
    } else if (marker === "+") {
      hunk.lines.push({ marker, newNumber, text: line });
      newNumber += 1;
      newRemaining -= 1;
    } else if (marker === "\\") {
      hunk.lines.push({ marker, text: line });
      continue;
    } else {
      flush();
      continue;
    }
    if (oldRemaining <= 0 && newRemaining <= 0) bodyComplete = true;
  }
  flush();
  return hunks;
}

/**
 * Unified-diff lines around a comment's old/new ranges: each affected hunk's
 * header plus the selected lines and up to three context lines on each side.
 * Returns undefined when the patch carries nothing to show.
 */
export function excerptFor(
  patch: string,
  oldRange?: readonly [number, number],
  newRange?: readonly [number, number],
): string | undefined {
  if (patch.length === 0) return undefined;
  const sections: { readonly header: string; readonly body: readonly string[] }[] = [];
  let total = 0;
  for (const hunk of parseHunks(patch)) {
    const selected = hunk.lines
      .map((line, index) => {
        if (
          line.oldNumber !== undefined &&
          oldRange &&
          line.oldNumber >= oldRange[0] &&
          line.oldNumber <= oldRange[1]
        )
          return index;
        if (
          line.newNumber !== undefined &&
          newRange &&
          line.newNumber >= newRange[0] &&
          line.newNumber <= newRange[1]
        )
          return index;
        return -1;
      })
      .filter((index) => index >= 0);
    if (selected.length === 0) continue;
    const from = Math.max(0, selected[0] - CONTEXT);
    const to = Math.min(hunk.lines.length - 1, selected[selected.length - 1] + CONTEXT);
    const body = hunk.lines.slice(from, to + 1).map((line) => line.text);
    sections.push({ header: hunk.header, body });
    total += body.length;
  }
  if (sections.length === 0) return undefined;
  const output: string[] = [];
  let remaining = MAX_BODY_LINES;
  for (const section of sections) {
    if (remaining <= 0) break;
    const body = section.body.slice(0, remaining);
    output.push(section.header, ...body);
    remaining -= body.length;
  }
  if (total > MAX_BODY_LINES) output.push(`… ${total - MAX_BODY_LINES} more lines`);
  return output.join("\n");
}
