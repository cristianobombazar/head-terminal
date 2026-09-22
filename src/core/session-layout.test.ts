import { describe, expect, it } from "vitest";

import type { LayoutNode } from "../types/session";
import {
  collectPaneIds,
  collectPaneRects,
  collectSplitDividers,
  collectVisiblePaneRects,
  collectVisibleSplitDividers,
  createInitialLayout,
  createPaneId,
  findPaneNode,
  mapPaneNodes,
  resolvePaneCwd,
  setPaneCwdInLayout,
  splitPaneInLayout,
} from "./session-layout";

describe("session-layout", () => {
  it("collects pane ids from nested splits", () => {
    const left = createPaneId();
    const right = createPaneId();
    const layout = splitPaneInLayout(
      createInitialLayout(left),
      left,
      "vertical",
      right,
    );

    expect(collectPaneIds(layout)).toEqual([left, right]);
  });
});

describe("pane folders in the layout", () => {
  const session = {
    cwd: "C:\\Users\\m\\default",
    layout: {
      kind: "split" as const,
      direction: "horizontal" as const,
      ratio: 0.5,
      first: { kind: "pane" as const, paneId: "a" },
      second: { kind: "pane" as const, paneId: "b", cwd: "D:\\repo" },
    },
  };

  it("resolves a pane's own folder, else the session default", () => {
    expect(resolvePaneCwd(session, "a")).toBe("C:\\Users\\m\\default");
    expect(resolvePaneCwd(session, "b")).toBe("D:\\repo");
    expect(resolvePaneCwd(session, "missing")).toBe("C:\\Users\\m\\default");
  });

  it("gives the new pane of a split the folder it was told to inherit", () => {
    const layout = splitPaneInLayout(session.layout, "b", "vertical", "c", "D:\\repo");
    expect(findPaneNode(layout, "c")).toEqual({ kind: "pane", paneId: "c", cwd: "D:\\repo" });
    const plain = splitPaneInLayout(session.layout, "a", "vertical", "d");
    expect(findPaneNode(plain, "d")).toEqual({ kind: "pane", paneId: "d" });
  });

  it("sets and clears one pane's folder without touching the others", () => {
    const pinned = setPaneCwdInLayout(session.layout, "a", "E:\\other");
    expect(findPaneNode(pinned, "a")?.cwd).toBe("E:\\other");
    expect(findPaneNode(pinned, "b")?.cwd).toBe("D:\\repo");
    const cleared = setPaneCwdInLayout(pinned, "b", undefined);
    expect(findPaneNode(cleared, "b")).toEqual({ kind: "pane", paneId: "b" });
    expect(findPaneNode(cleared, "a")?.cwd).toBe("E:\\other");
  });

  it("maps every pane node and keeps the split structure", () => {
    const stripped = mapPaneNodes(session.layout, ({ cwd: _cwd, ...pane }) => pane);
    expect(stripped).toEqual({
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", paneId: "a" },
      second: { kind: "pane", paneId: "b" },
    });
  });
});

describe("layout with minimized panes", () => {
  // a | (b / c), with b over c.
  const layout: LayoutNode = {
    kind: "split",
    direction: "horizontal",
    ratio: 0.4,
    first: { kind: "pane", paneId: "a" },
    second: {
      kind: "split",
      direction: "vertical",
      ratio: 0.25,
      first: { kind: "pane", paneId: "b" },
      second: { kind: "pane", paneId: "c" },
    },
  };

  it("is the full layout when nothing is hidden", () => {
    expect(collectVisiblePaneRects(layout, new Set())).toEqual(collectPaneRects(layout));
    expect(collectVisibleSplitDividers(layout, new Set())).toEqual(
      collectSplitDividers(layout),
    );
  });

  it("gives a hidden pane's room to its sibling", () => {
    expect(collectVisiblePaneRects(layout, new Set(["b"]))).toEqual([
      { paneId: "a", top: 0, left: 0, width: 40, height: 100 },
      { paneId: "c", top: 0, left: 40, width: 60, height: 100 },
    ]);
  });

  it("gives a whole hidden side to the other one", () => {
    expect(collectVisiblePaneRects(layout, new Set(["b", "c"]))).toEqual([
      { paneId: "a", top: 0, left: 0, width: 100, height: 100 },
    ]);
    expect(collectVisiblePaneRects(layout, new Set(["a"]))).toEqual([
      { paneId: "b", top: 0, left: 0, width: 100, height: 25 },
      { paneId: "c", top: 25, left: 0, width: 100, height: 75 },
    ]);
  });

  it("has nothing to lay out when every pane is hidden", () => {
    const hidden = new Set(["a", "b", "c"]);
    expect(collectVisiblePaneRects(layout, hidden)).toEqual([]);
    expect(collectVisibleSplitDividers(layout, hidden)).toEqual([]);
  });

  it("keeps each divider's path into the real tree", () => {
    // With a hidden, only b/c is split on screen: it spans the canvas but is
    // still the second child of the root, so a drag updates that ratio.
    expect(collectVisibleSplitDividers(layout, new Set(["a"]))).toEqual([
      {
        path: [1],
        direction: "vertical",
        ratio: 0.25,
        top: 0,
        left: 0,
        width: 100,
        height: 100,
      },
    ]);
    // A split with one side gone divides nothing.
    expect(collectVisibleSplitDividers(layout, new Set(["c"]))).toEqual([
      {
        path: [],
        direction: "horizontal",
        ratio: 0.4,
        top: 0,
        left: 0,
        width: 100,
        height: 100,
      },
    ]);
  });
});
