import { createTerminal } from "@coder/libghostty-vt-node";
import { describe, expect, it } from "vitest";
import {
  DirectRectanglePainter,
  type PhysicalRectangle,
} from "../extensions/overlay/direct-rectangle.ts";

function rectangle(overrides: Partial<PhysicalRectangle> = {}): PhysicalRectangle {
  return {
    row: 0,
    column: 5,
    width: 5,
    height: 3,
    terminalColumns: 10,
    terminalRows: 3,
    ...overrides,
  };
}

function screenLines(terminal: ReturnType<typeof createTerminal>): string[] {
  const snapshot = terminal.snapshot({ includeScrollback: true });
  return Array.from({ length: snapshot.rows }, (_, row) => {
    return snapshot.visibleLines.find((line) => line.row === row)?.text ?? "";
  });
}

function seedPhysicalScreen(terminal: ReturnType<typeof createTerminal>): void {
  terminal.feed(
    "\x1b[?7l" +
      "\x1b[1;1HLLLLLAAAAA" +
      "\x1b[2;1HLLLLLBBBBB" +
      "\x1b[3;1HLLLLLCCCCC" +
      "\x1b[?7h" +
      "\x1b[2;3H",
  );
}

describe("direct Hunk rectangle painter", () => {
  it("updates only changed absolute rows and preserves the surrounding screen", () => {
    const terminal = createTerminal({ cols: 10, rows: 3, scrollbackLimit: 20 });
    try {
      seedPhysicalScreen(terminal);
      const before = terminal.snapshot({ includeScrollback: true });
      const writes: string[] = [];
      const painter = new DirectRectanglePainter((data) => {
        writes.push(data);
        terminal.feed(data);
      });
      painter.seed(rectangle(), ["AAAAA", "BBBBB", "CCCCC"]);

      expect(painter.paint(rectangle(), ["AAAAA", "22222", "CCCCC"])).toMatchObject({
        changedRows: 1,
      });
      expect(screenLines(terminal)).toEqual(["LLLLLAAAAA", "LLLLL22222", "LLLLLCCCCC"]);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("\x1b[2;6H");
      expect(writes[0]).not.toContain("\x1b[1;6H");
      expect(writes[0]).not.toContain("\x1b[3;6H");
      expect(writes[0]).not.toMatch(/[\r\n]/);
      expect(writes[0]).not.toContain("\x1b[2K");

      const after = terminal.snapshot({ includeScrollback: true });
      expect(after.cursorRow).toBe(before.cursorRow);
      expect(after.cursorCol).toBe(before.cursorCol);
      expect(after.scrollbackLines ?? []).toHaveLength(0);

      // Autowrap was enabled before painting and must still wrap at the margin.
      terminal.feed("\x1b[1;10HXY");
      expect(screenLines(terminal)[0]).toBe("LLLLLAAAAX");
      expect(screenLines(terminal)[1]?.startsWith("Y")).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("safely paints a styled wide row through the physical bottom-right cell", () => {
    const terminal = createTerminal({ cols: 10, rows: 3, scrollbackLimit: 20 });
    try {
      seedPhysicalScreen(terminal);
      const painter = new DirectRectanglePainter((data) => terminal.feed(data));
      painter.seed(rectangle(), ["AAAAA", "BBBBB", "CCCCC"]);

      const styled = "\x1b[31m界abc";
      painter.paint(rectangle(), ["AAAAA", "BBBBB", styled]);

      expect(screenLines(terminal)).toEqual(["LLLLLAAAAA", "LLLLLBBBBB", "LLLLL界abc"]);
      const styledCell = terminal
        .snapshot({ includeCells: true })
        .cells?.find((cell) => cell.row === 2 && cell.col === 5);
      expect(styledCell?.foreground).toBeDefined();
      expect(terminal.snapshot({ includeScrollback: true }).scrollbackLines ?? []).toHaveLength(0);
    } finally {
      terminal.dispose();
    }
  });

  it("restores origin mode as well as the saved cursor", () => {
    const terminal = createTerminal({ cols: 10, rows: 3, scrollbackLimit: 20 });
    try {
      seedPhysicalScreen(terminal);
      terminal.feed("\x1b[2;3r\x1b[?6h\x1b[1;1H");
      const painter = new DirectRectanglePainter((data) => terminal.feed(data));
      painter.seed(rectangle(), ["AAAAA", "BBBBB", "CCCCC"]);
      painter.paint(rectangle(), ["AAAAA", "22222", "CCCCC"]);

      expect(terminal.snapshot().cursorRow).toBe(1);
      terminal.feed("\x1b[1;1HZ");
      expect(screenLines(terminal)[0]).toBe("LLLLLAAAAA");
      expect(screenLines(terminal)[1]?.startsWith("Z")).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("supports an odd-width left rectangle and skips unchanged frames", () => {
    const writes: string[] = [];
    const painter = new DirectRectanglePainter((data) => writes.push(data));
    const left = rectangle({ column: 0, width: 4, terminalColumns: 9 });
    painter.seed(left, ["aaaa", "bbbb", "cccc"]);

    expect(painter.paint(left, ["aaaa", "bbbb", "cccc"])).toEqual({
      changedRows: 0,
      bytes: 0,
    });
    expect(writes).toEqual([]);
    expect(painter.paint(left, ["1111", "bbbb", "3333"]).changedRows).toBe(2);
    expect(writes[0]).toContain("\x1b[1;1H");
    expect(writes[0]).toContain("\x1b[3;1H");
  });

  it("matches Pi's Thai and Lao AM normalization before direct output", () => {
    const writes: string[] = [];
    const painter = new DirectRectanglePainter((data) => writes.push(data));
    painter.seed(rectangle(), ["AAAAA", "BBBBB", "CCCCC"]);

    painter.paint(rectangle(), ["\u0e33aaaa", "\u0eb3bbbb", "CCCCC"]);
    expect(writes[0]).toContain("\u0e4d\u0e32aaaa");
    expect(writes[0]).toContain("\u0ecd\u0eb2bbbb");
    expect(writes[0]).not.toContain("\u0e33");
    expect(writes[0]).not.toContain("\u0eb3");
  });

  it("rejects unsafe controls, overflow, and geometry changes before writing", () => {
    const writes: string[] = [];
    const painter = new DirectRectanglePainter((data) => writes.push(data));
    painter.seed(rectangle(), ["AAAAA", "BBBBB", "CCCCC"]);

    expect(() => painter.paint(rectangle(), ["AAAAA", "bad\n", "CCCCC"])).toThrow(
      "control character",
    );
    expect(() => painter.paint(rectangle(), ["AAAAA", "\x1b[2J", "CCCCC"])).toThrow(
      "only printable text and SGR",
    );
    expect(() => painter.paint(rectangle(), ["AAAAA", "123456", "CCCCC"])).toThrow(
      "exceeds its rectangle width",
    );
    expect(() =>
      painter.paint(rectangle({ terminalColumns: 11 }), ["AAAAA", "BBBBB", "CCCCC"]),
    ).toThrow("rectangle changed");
    expect(writes).toEqual([]);
  });
});
