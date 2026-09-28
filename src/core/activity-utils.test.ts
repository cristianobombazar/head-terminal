import { describe, expect, it } from "vitest";

import { getSessionShownAgent } from "./activity-utils";
import { createPaneRuntime, type PaneRuntime } from "./session-manager";
import type { AgentSession } from "../types/session";

function session(agentProfileId: string): AgentSession {
  return {
    id: "s1",
    title: "s1",
    cwd: "/tmp",
    agentProfileId,
    layout: {
      kind: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { kind: "pane", paneId: "p1" },
      second: { kind: "pane", paneId: "p2" },
    },
  };
}

function runtime(overrides: Record<string, Partial<PaneRuntime>>): Record<string, PaneRuntime> {
  return Object.fromEntries(
    Object.entries(overrides).map(([paneId, value]) => [
      paneId,
      { ...createPaneRuntime(), ...value },
    ]),
  );
}

describe("getSessionShownAgent", () => {
  it("shows Claude while any terminal of a shell session runs it", () => {
    expect(
      getSessionShownAgent(session("shell"), runtime({ p1: {}, p2: { runningAgent: "claude" } })),
    ).toBe("claude");
  });

  it("goes back to the session's own agent once claude is gone", () => {
    expect(getSessionShownAgent(session("shell"), runtime({ p1: {}, p2: {} }))).toBe("shell");
    expect(getSessionShownAgent(session("codex"), {})).toBe("codex");
  });

  it("keeps a Claude session on Claude after its CLI exits to the shell", () => {
    expect(getSessionShownAgent(session("claude"), runtime({ p1: {}, p2: {} }))).toBe("claude");
  });
});
