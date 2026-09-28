import { describe, expect, it } from "vitest";

import type { PaneActivity } from "../types/activity";
import {
  aggregatePaneActivity,
  countTerminalStatuses,
  countWorkingSessions,
  formatCloseWarning,
  formatWindowTitle,
  getSessionActivity,
  getSessionActivitySince,
  getSessionHasWorkingPane,
  getSessionShownAgent,
  getSessionStatusView,
} from "./activity-utils";
import { createInitialLayout, splitPaneInLayout } from "./session-layout";
import { createPaneRuntime, type PaneRuntime } from "./session-manager";
import type { AgentSession } from "../types/session";

function runtime(activity: PaneActivity, activitySince = 0, extra: Partial<PaneRuntime> = {}): PaneRuntime {
  return { status: "running", activity, activitySince, restartAttempts: 0, ...extra };
}

function twoPaneSession(id: string, a: string, b: string): AgentSession {
  const layout = splitPaneInLayout(createInitialLayout(a), a, "vertical", b);
  return {
    id,
    title: id,
    cwd: "/tmp",
    agentProfileId: "claude",
    layout,
  } as AgentSession;
}

describe("aggregatePaneActivity", () => {
  it("lets a pane that needs the user speak over one still working", () => {
    expect(
      aggregatePaneActivity({ a: runtime("working"), b: runtime("waiting_input") }, ["a", "b"]),
    ).toBe("waiting_input");
    expect(aggregatePaneActivity({ a: runtime("working"), b: runtime("idle") }, ["a", "b"])).toBe(
      "working",
    );
    expect(aggregatePaneActivity({}, [])).toBe("starting");
    expect(aggregatePaneActivity({}, ["missing"])).toBe("starting");
  });
});

describe("working sessions", () => {
  const sessions = [
    twoPaneSession("blocked-and-working", "a1", "a2"),
    twoPaneSession("crashed-and-working", "b1", "b2"),
    twoPaneSession("idle", "c1", "c2"),
  ];
  const paneRuntime: Record<string, PaneRuntime> = {
    a1: runtime("waiting_input"),
    a2: runtime("working"),
    b1: runtime("agent_fallback"),
    b2: runtime("working"),
    c1: runtime("idle"),
    c2: runtime("exited"),
  };

  it("counts every session with a pane at work, whatever its siblings do", () => {
    expect(countWorkingSessions(sessions, paneRuntime)).toBe(2);
    expect(getSessionHasWorkingPane(sessions[0], paneRuntime)).toBe(true);
    expect(getSessionHasWorkingPane(sessions[2], paneRuntime)).toBe(false);
    // The aggregated activity alone would have hidden that work.
    expect(getSessionActivity(sessions[0], paneRuntime)).toBe("waiting_input");
  });
});

describe("getSessionActivitySince", () => {
  it("times the session by the pane that has been in its state the longest", () => {
    const session = twoPaneSession("s", "a", "b");
    const paneRuntime = { a: runtime("working", 1_000), b: runtime("working", 50_000) };
    expect(getSessionActivitySince(session, paneRuntime)).toBe(1_000);
  });
});

describe("getSessionStatusView", () => {
  it("reports a session that never spawned as dormant", () => {
    const session = twoPaneSession("s", "a", "b");
    const paneRuntime = { a: runtime("starting"), b: runtime("starting") };
    expect(getSessionStatusView(session, paneRuntime, {}).tone).toBe("dormant");
    expect(getSessionStatusView(session, paneRuntime, { s: true }).tone).toBe("starting");
  });
});

// Review store-ui-semantics#6, harness F5: the window title and the close
// confirmation counted sessions (two agents running in one session said "1")
// and left out terminals blocked on an approval.
describe("countTerminalStatuses", () => {
  const sessions = [
    twoPaneSession("both-working", "a1", "a2"),
    twoPaneSession("waiting-and-done", "b1", "b2"),
    twoPaneSession("never-started", "c1", "c2"),
  ];
  const paneRuntime: Record<string, PaneRuntime> = {
    a1: runtime("working"),
    a2: runtime("working"),
    b1: runtime("waiting_input"),
    b2: runtime("idle", 0, { doneAt: 1 }),
    c1: runtime("working"),
    c2: runtime("waiting_input"),
  };

  it("counts terminals, not sessions, in the sessions that started", () => {
    expect(
      countTerminalStatuses(sessions, paneRuntime, { "both-working": true, "waiting-and-done": true }),
    ).toEqual({ working: 2, waiting: 1, done: 1 });
  });

  it("puts the same counts in the window title", () => {
    expect(formatWindowTitle("Head Terminal", { working: 2, waiting: 1, done: 1 })).toBe(
      "● 2 executando · 1 aguardando — Head Terminal",
    );
    expect(formatWindowTitle("Head Terminal", { working: 2, waiting: 0, done: 3 })).toBe(
      "● 2 executando — Head Terminal",
    );
    expect(formatWindowTitle("Head Terminal", { working: 0, waiting: 1, done: 0 })).toBe(
      "● 1 aguardando — Head Terminal",
    );
    expect(formatWindowTitle("Head Terminal", { working: 0, waiting: 0, done: 3 })).toBe("Head Terminal");
  });

  it("asks before closing over work running or blocked on the user", () => {
    expect(formatCloseWarning({ working: 2, waiting: 1, done: 0 })).toBe(
      "3 agent(s) executando ou aguardando você.",
    );
    expect(formatCloseWarning({ working: 0, waiting: 3, done: 0 })).toBe(
      "3 agent(s) executando ou aguardando você.",
    );
    expect(formatCloseWarning({ working: 0, waiting: 0, done: 4 })).toBeNull();
  });
});

function layoutSession(agentProfileId: string): AgentSession {
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

function paneRuntimes(overrides: Record<string, Partial<PaneRuntime>>): Record<string, PaneRuntime> {
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
      getSessionShownAgent(layoutSession("shell"), paneRuntimes({ p1: {}, p2: { runningAgent: "claude" } })),
    ).toBe("claude");
  });

  it("goes back to the session's own agent once claude is gone", () => {
    expect(getSessionShownAgent(layoutSession("shell"), paneRuntimes({ p1: {}, p2: {} }))).toBe("shell");
    expect(getSessionShownAgent(layoutSession("codex"), {})).toBe("codex");
  });

  it("keeps a Claude session on Claude after its CLI exits to the shell", () => {
    expect(getSessionShownAgent(layoutSession("claude"), paneRuntimes({ p1: {}, p2: {} }))).toBe("claude");
  });
});
