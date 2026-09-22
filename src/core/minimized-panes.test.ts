import { describe, expect, it } from "vitest";

import { describeMinimizedPane, nextFinishedAt } from "./minimized-panes";

describe("nextFinishedAt", () => {
  it("marks the moment a working agent stops", () => {
    expect(nextFinishedAt(undefined, "working", "waiting_input", 500)).toBe(500);
    expect(nextFinishedAt(undefined, "working", "idle", 500)).toBe(500);
    expect(nextFinishedAt(undefined, "working", "exited", 500)).toBe(500);
    expect(nextFinishedAt(undefined, "working", "error", 500)).toBe(500);
  });

  it("keeps the first stop while the agent stays stopped", () => {
    expect(nextFinishedAt(500, "waiting_input", "idle", 900)).toBe(500);
    expect(nextFinishedAt(500, "idle", "waiting_input", 900)).toBe(500);
  });

  it("forgets it as soon as the agent is back at work", () => {
    expect(nextFinishedAt(500, "idle", "working", 900)).toBeUndefined();
  });

  it("has nothing to report for a pane never seen working", () => {
    expect(nextFinishedAt(undefined, "idle", "waiting_input", 900)).toBeUndefined();
    expect(nextFinishedAt(undefined, "starting", "idle", 900)).toBeUndefined();
  });

  it("does not count a restart as finishing", () => {
    expect(nextFinishedAt(undefined, "working", "starting", 900)).toBeUndefined();
  });
});

describe("describeMinimizedPane", () => {
  const minute = 60_000;

  it("shows how long a working agent has been at it", () => {
    expect(
      describeMinimizedPane(
        { activity: "working", activitySince: 0 },
        { since: 0 },
        12 * minute,
      ),
    ).toEqual({ tone: "working", label: "Executando", time: "12m", attention: false });
  });

  it("flags an agent that stopped since it was minimized", () => {
    for (const activity of ["idle", "waiting_input"] as const) {
      expect(
        describeMinimizedPane(
          { activity, activitySince: 3 * minute },
          { since: 0, finishedAt: 3 * minute },
          5 * minute,
        ),
      ).toEqual({ tone: "done", label: "Terminou", time: "há 2m", attention: true });
    }
  });

  it("stays quiet about a pane that was already idle when minimized", () => {
    expect(
      describeMinimizedPane({ activity: "idle", activitySince: 0 }, { since: 0 }, minute),
    ).toEqual({ tone: "idle", label: "Pronto", attention: false });
    expect(
      describeMinimizedPane(
        { activity: "waiting_input", activitySince: 0 },
        { since: 0 },
        minute,
      ),
    ).toEqual({ tone: "waiting", label: "Aguardando", attention: false });
  });

  it("says an approval prompt is not the agent finishing", () => {
    expect(
      describeMinimizedPane(
        { activity: "waiting_input", activitySince: 0, awaitingApproval: true },
        { since: 0, finishedAt: 0 },
        30_000,
      ),
    ).toEqual({ tone: "approval", label: "Pede aprovação", time: "há 30s", attention: true });
  });

  it("always flags errors and a fallen agent", () => {
    expect(
      describeMinimizedPane({ activity: "error", activitySince: 0 }, { since: 0 }, 0),
    ).toMatchObject({ tone: "error", attention: true });
    expect(
      describeMinimizedPane(
        { activity: "agent_fallback", activitySince: 0 },
        { since: 0 },
        0,
      ),
    ).toMatchObject({ tone: "fallback", attention: true });
  });

  it("flags an exit only when it happened while minimized", () => {
    expect(
      describeMinimizedPane({ activity: "exited", activitySince: 0 }, { since: 0 }, 0),
    ).toMatchObject({ tone: "exited", attention: false });
    expect(
      describeMinimizedPane(
        { activity: "exited", activitySince: 0 },
        { since: 0, finishedAt: 0 },
        0,
      ),
    ).toMatchObject({ tone: "exited", attention: true });
  });

  it("treats a pane with no runtime yet as starting", () => {
    expect(describeMinimizedPane(undefined, { since: 0 }, 0)).toEqual({
      tone: "starting",
      label: "Iniciando",
      attention: false,
    });
  });
});
