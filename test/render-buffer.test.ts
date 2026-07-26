import { createTerminal } from "@coder/libghostty-vt-node";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderGhosttyHtml } from "../extensions/overlay/render-buffer.ts";

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
});
