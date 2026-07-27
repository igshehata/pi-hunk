import { createTerminal } from "@coder/libghostty-vt-node";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DirectRectanglePainter } from "../extensions/overlay/direct-rectangle.ts";
import { paintTerminalCursor, renderGhosttyHtml } from "../extensions/overlay/render-buffer.ts";

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function render(data: string, columns: number, rows: number): string[] {
  const terminal = createTerminal({ cols: columns, rows, scrollbackLimit: 0 });
  try {
    terminal.feed(data);
    const html = terminal.formatHtml?.();
    if (html === undefined) throw new Error("formatHtml unavailable");
    return renderGhosttyHtml(html, columns, rows);
  } finally {
    terminal.dispose();
  }
}

function renderCursor(data: string, columns: number, rows: number): string[] {
  const terminal = createTerminal({ cols: columns, rows, scrollbackLimit: 0 });
  try {
    terminal.feed(data);
    const snapshot = terminal.snapshot();
    const html = terminal.formatHtml?.();
    if (html === undefined) throw new Error("formatHtml unavailable");
    return renderGhosttyHtml(html, columns, rows, {
      visible: true,
      row: snapshot.cursorRow,
      column: snapshot.cursorCol,
    });
  } finally {
    terminal.dispose();
  }
}

describe("renderGhosttyHtml", () => {
  it("pads an untouched viewport with blank cells", () => {
    const lines = render("", 4, 2);
    expect(lines.map((line) => line.replace(ANSI, ""))).toEqual(["    ", "    "]);
  });

  it("preserves styled cells and line width", () => {
    const lines = render("\x1b[38;2;12;34;56mhi\x1b[0m", 8, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("38;2;12;34;56");
    expect(lines[0]!.replace(ANSI, "")).toBe("hi      ");
    expect(lines[1]!.replace(ANSI, "")).toBe("        ");
  });

  it("maps palette colors and text attributes back to SGR", () => {
    const [line] = render("\x1b[1;2;3;4;7;9;38;5;196;48;5;22mstyled", 12, 1);
    expect(line).toContain("1;2;3;4;7;9;38;5;196;48;5;22");
  });

  it("keeps Pi-visible width correct for wide and combining characters", () => {
    const [line] = render("界e\u0301🙂", 8, 2);
    expect(visibleWidth(line!)).toBe(8);
    expect(line!.replace(ANSI, "")).toContain("界e\u0301🙂");
  });

  it("renders the active alternate screen", () => {
    const lines = render("normal\x1b[?1049h\x1b[Halt", 6, 2);
    expect(lines[0]!.replace(ANSI, "")).toBe("alt   ");
  });

  it("decodes HTML entities without treating escaped text as markup", () => {
    const html =
      '<div style="font-family: monospace; white-space: pre;">&lt;a&amp;b&gt;&#128578;</div>';
    const [line] = renderGhosttyHtml(html, 8, 1);
    expect(line!.replace(ANSI, "")).toBe("<a&b>🙂 ");
  });

  it("sanitizes numeric controls, malformed scalars, and raw unsafe text at exact width", () => {
    const html =
      '<div style="font-family: monospace; white-space: pre;">' +
      "A&#1;B&#127;C&#x85;D&#xD800;E&#x110000;F&#999999999999999999999;" +
      "G&#xZZ;H\x00\x1b\x7f\u0085\ud800" +
      "</div>";

    const lines = renderGhosttyHtml(html, 32, 1);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBe(32);
    expect(lines[0]!.replace(ANSI, "")).toContain("A�B�C�D�E�F�G�H�����");

    const painter = new DirectRectanglePainter(() => undefined);
    const rectangle = {
      row: 0,
      column: 0,
      width: 32,
      height: 1,
      terminalColumns: 32,
      terminalRows: 1,
    };
    expect(() => painter.seed(rectangle, lines)).not.toThrow();
    expect(painter.paint(rectangle, lines)).toEqual({ changedRows: 0, bytes: 0 });
  });

  it("keeps real VT output containing surviving controls safe for direct paint", () => {
    const lines = render("a\x01b\x02c\x7fd\u0085e", 12, 2);
    expect(lines.map((line) => visibleWidth(line))).toEqual([12, 12]);

    const painter = new DirectRectanglePainter(() => undefined);
    const rectangle = {
      row: 0,
      column: 0,
      width: 12,
      height: 2,
      terminalColumns: 12,
      terminalRows: 2,
    };
    expect(() => painter.seed(rectangle, lines)).not.toThrow();
  });

  it("restores parent styles after nested and repeated spans", () => {
    const html =
      '<div style="font-family: monospace; white-space: pre;">' +
      '<span style="font-weight: bold;">a' +
      '<span style="font-style: italic;">b</span>c' +
      '<span style="font-style: italic;">d</span>e' +
      "</span></div>";
    const [line] = renderGhosttyHtml(html, 8, 1);

    expect(line).toContain("\x1b[0m\x1b[1m\x1b[3mb\x1b[0m\x1b[1mc");
    expect(line).toContain("\x1b[0m\x1b[1m\x1b[3md\x1b[0m\x1b[1me");
    expect(line!.replace(ANSI, "")).toBe("abcde   ");
  });

  it("carries active styles across LF, CRLF, and CR line endings", () => {
    const html =
      '<div style="font-family: monospace; white-space: pre;">' +
      '<span style="color: rgb(1, 2, 3);">a\nb\r\nc\rd</span></div>';
    const lines = renderGhosttyHtml(html, 2, 4);

    expect(lines.map((line) => line.replace(ANSI, ""))).toEqual(["a ", "b ", "c ", "d "]);
    for (const line of lines) expect(line).toContain("\x1b[38;2;1;2;3m");
  });

  it("truncates wide styled content to the exact requested width", () => {
    const html =
      '<div style="font-family: monospace; white-space: pre;">' +
      '<span style="color: rgb(12, 34, 56);">界🙂abcdef</span></div>';
    const [line] = renderGhosttyHtml(html, 7, 1);

    expect(visibleWidth(line!)).toBe(7);
    expect(line!.replace(ANSI, "")).toBe("界🙂abc");
  });

  it("marks the addressed styled cell and restores its style before the adjacent cell", () => {
    const [line] = renderCursor("\x1b[38;2;12;34;56mabc\x1b[1;2H", 6, 1);

    expect(line).toContain("a\x1b[7mb\x1b[27mc");
    expect(line!.replace(ANSI, "")).toBe("abc   ");
    expect(visibleWidth(line!)).toBe(6);
  });

  it("marks blank cells without changing the viewport width", () => {
    const lines = renderCursor("x\x1b[2;6H", 6, 2);

    expect(lines[1]).toContain("     \x1b[7m \x1b[27m");
    expect(lines.map((line) => visibleWidth(line))).toEqual([6, 6]);
  });

  it("marks a complete wide grapheme when the cursor addresses its continuation column", () => {
    const [line] = renderCursor("界x\x1b[1;2H", 6, 1);

    expect(line).toContain("\x1b[7m界\x1b[27m");
    expect(line!.replace(ANSI, "")).toBe("界x   ");
    expect(visibleWidth(line!)).toBe(6);
  });

  it("clips cursor metadata and honors hidden-cursor snapshots", () => {
    const html = '<div style="font-family: monospace; white-space: pre;">abc</div>';
    for (const cursor of [
      { visible: false, row: 0, column: 1 },
      { visible: true, row: -1, column: 1 },
      { visible: true, row: 0, column: 4 },
    ]) {
      const [line] = renderGhosttyHtml(html, 4, 1, cursor);
      expect(line).not.toContain("\x1b[7m");
      expect(visibleWidth(line!)).toBe(4);
    }
  });

  it("ignores RGB components 0, 7, and 27 while preserving adjacent styles", () => {
    const cases = [
      "\x1b[1m\x1b[38;2;0;1;2m",
      "\x1b[38;2;1;2;7m",
      "\x1b[38;2;1;2;27m",
      "\x1b[38:2::0:7:27m",
    ];

    for (const style of cases) {
      const line = paintTerminalCursor(`${style}ab`, 0);
      expect(line).toBe(`${style}\x1b[7ma\x1b[27mb`);
      expect(visibleWidth(line)).toBe(2);
    }
  });

  it("does not interpret palette values 7 and 27 as inverse controls", () => {
    for (const index of [7, 27]) {
      const style = `\x1b[38;5;${index}m`;
      const line = paintTerminalCursor(`${style}ab`, 0);
      expect(line).toBe(`${style}\x1b[7ma\x1b[27mb`);
      expect(visibleWidth(line)).toBe(2);
    }
  });

  it("toggles only the addressed cell in an inverse RGB-styled run", () => {
    for (const color of ["38;2;0;7;27", "38:2::0:7:27"]) {
      const style = `\x1b[7m\x1b[${color}m`;
      const line = paintTerminalCursor(`${style}ab`, 0);
      expect(line).toBe(`${style}\x1b[27ma\x1b[7mb`);
      expect(visibleWidth(line)).toBe(2);
    }
  });
});
