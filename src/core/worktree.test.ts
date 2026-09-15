import { describe, expect, it } from "vitest";

import { collectOccupiedCwds } from "./worktree";
import type { AgentSession, LayoutNode } from "../types/session";

function session(
  id: string,
  cwd: string,
  layout: LayoutNode = { kind: "pane", paneId: `${id}-p1` },
): AgentSession {
  return { id, title: id, cwd, agentProfileId: "claude", layout };
}

function split(first: LayoutNode, second: LayoutNode): LayoutNode {
  return { kind: "split", direction: "vertical", ratio: 0.5, first, second };
}

describe("collectOccupiedCwds", () => {
  it("reports where each terminal is, not where its session points", () => {
    const sessions = [
      session("a", "C:\\repo"),
      session(
        "b",
        "C:\\repo",
        split(
          { kind: "pane", paneId: "b-p1" },
          { kind: "pane", paneId: "b-p2", cwd: "C:\\repo-agent-1" },
        ),
      ),
    ];

    expect(collectOccupiedCwds(sessions)).toEqual([
      "C:\\repo",
      "C:\\repo",
      "C:\\repo-agent-1",
    ]);
  });

  it("keeps one entry per terminal so the plan can count agents", () => {
    const sessions = [
      session("a", "C:\\repo"),
      session("b", "C:\\repo"),
      session("c", "C:\\repo"),
    ];

    // Três terminais na mesma pasta são três agents brigando, não um.
    expect(collectOccupiedCwds(sessions)).toHaveLength(3);
  });

  it("leaves out a session that is closing and a pane that is isolating", () => {
    const sessions = [session("a", "C:\\repo"), session("b", "D:\\other")];

    expect(collectOccupiedCwds(sessions, { excludeSessionId: "a" })).toEqual([
      "D:\\other",
    ]);
    // Sem isso, um terminal sozinho na árvore acharia que ela já está tomada.
    expect(collectOccupiedCwds(sessions, { excludePaneId: "a-p1" })).toEqual([
      "D:\\other",
    ]);
  });

  it("ignores a session's own folder when no terminal is left in it", () => {
    const sessions = [
      session(
        "a",
        "C:\\repo",
        split(
          { kind: "pane", paneId: "a-p1", cwd: "C:\\repo-agent-1" },
          { kind: "pane", paneId: "a-p2", cwd: "C:\\repo-agent-2" },
        ),
      ),
    ];

    expect(collectOccupiedCwds(sessions)).toEqual([
      "C:\\repo-agent-1",
      "C:\\repo-agent-2",
    ]);
  });
});
