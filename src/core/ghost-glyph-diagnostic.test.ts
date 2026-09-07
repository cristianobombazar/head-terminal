import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";

import {
  collectGhostGlyphReport,
  GHOST_PREFIX_COLS,
  isBlankPrefix,
} from "./ghost-glyph-diagnostic";

function fakeTerminal(rows: string[], viewportY = 0): Terminal {
  const lines = rows.map((text) => ({
    translateToString: (trim: boolean, start = 0, end = text.length) => {
      const slice = text.slice(start, end).padEnd(Math.min(end, 200) - start, " ");
      return trim ? slice.trimEnd() : slice;
    },
  }));
  return {
    cols: 80,
    rows: rows.length,
    element: undefined,
    buffer: {
      active: {
        viewportY,
        getLine: (y: number) => lines[y - viewportY],
      },
    },
  } as unknown as Terminal;
}

describe("ghost-glyph-diagnostic", () => {
  it("treats spaces and empty cells as blank", () => {
    expect(isBlankPrefix("   ")).toBe(true);
    expect(isBlankPrefix("")).toBe(true);
    expect(isBlankPrefix("A  ")).toBe(false);
  });

  it("lists only rows with content in the first columns", () => {
    const report = collectGhostGlyphReport(
      fakeTerminal([
        "● O que é o ASDLC",
        "  ASDLC = Agentic",
        "As  Também deixam claro",
        "",
        "   1. Spec antes",
      ]),
    );

    expect(report.rows).toBe(5);
    expect(report.dirtyRows.map((row) => row.row)).toEqual([0, 2]);
    expect(report.dirtyRows[1].prefix).toBe("As".slice(0, GHOST_PREFIX_COLS));
    expect(report.dirtyRows[1].text).toBe("As  Também deixam claro");
    expect(report.renderer).toBe("unknown");
  });

  it("reads rows relative to the viewport, not the buffer top", () => {
    const report = collectGhostGlyphReport(fakeTerminal(["Tr", "  ok"], 120));

    expect(report.viewportY).toBe(120);
    expect(report.dirtyRows).toHaveLength(1);
    expect(report.dirtyRows[0].row).toBe(0);
  });
});
