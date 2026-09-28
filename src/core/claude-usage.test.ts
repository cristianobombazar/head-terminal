import { afterEach, describe, expect, it } from "vitest";

import type { ClaudeAccountUsage } from "../../electron/types/api";
import { setLocale } from "../i18n";
import {
  accountName,
  claudePaneProfiles,
  claudeProfilesInUse,
  currentWindow,
  describeAccountUsage,
  elapsedShare,
  FIVE_HOUR_MS,
  formatAge,
  formatDurationLong,
  formatDurationShort,
  formatResetLong,
  formatResetShort,
  nextReset,
  scopedAlerts,
  WEEK_MS,
} from "./claude-usage";
import type { ClaudeAccountProfile } from "./claude-accounts";
import type { AgentSession, LayoutNode } from "../types/session";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Local time, so the calendar words hold in any time zone the tests run in.
// 28/09/2026 is a Monday.
const NOW = new Date(2026, 8, 28, 13, 46, 20).getTime();

afterEach(() => setLocale("pt-BR"));

const PROFILES: ClaudeAccountProfile[] = [
  { id: "default", name: "Matheus" },
  { id: "p-tail", name: "Tailwind" },
  { id: "p-nsuite", name: "N Suite" },
];

function pane(paneId: string): LayoutNode {
  return { kind: "pane", paneId };
}

function session(
  id: string,
  agentProfileId: string,
  claudeAccountId: string | undefined,
  layout: LayoutNode,
): AgentSession {
  return { id, title: id, cwd: "/tmp", agentProfileId, claudeAccountId, layout };
}

const SESSIONS: AgentSession[] = [
  session("cursor", "cursor", undefined, pane("c1")),
  session("wab", "claude", "p-tail", {
    kind: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: pane("w1"),
    second: pane("w2"),
  }),
  session("matheus", "claude", undefined, pane("m1")),
  session("gone", "claude", "deleted-profile", pane("g1")),
];

describe("sessions → profiles", () => {
  it("lists the profiles in use in Settings order, without deleted ones", () => {
    expect(claudeProfilesInUse(SESSIONS, PROFILES)).toEqual(["default", "p-tail"]);
  });

  it("maps every Claude pane to its profile", () => {
    expect([...claudePaneProfiles(SESSIONS)]).toEqual([
      ["w1", "p-tail"],
      ["w2", "p-tail"],
      ["m1", "default"],
      ["g1", "deleted-profile"],
    ]);
  });

  it("names an account after every profile signed in to it", () => {
    expect(accountName(["p-tail", "p-nsuite"], PROFILES)).toBe("Tailwind · N Suite");
  });
});

describe("windows", () => {
  it("starts a window over once its reset time passed", () => {
    const window = { percent: 80, resetsAt: NOW + MINUTE };
    expect(currentWindow(window, NOW)).toBe(window);
    expect(currentWindow(window, NOW + MINUTE)).toEqual({ percent: 0, resetsAt: null });
    expect(currentWindow(null, NOW)).toBeNull();
  });

  it("measures how much of the window went by", () => {
    expect(elapsedShare({ percent: 0, resetsAt: NOW + 2 * HOUR }, FIVE_HOUR_MS, NOW)).toBeCloseTo(
      0.6,
    );
    expect(elapsedShare({ percent: 0, resetsAt: NOW + 8 * 24 * HOUR }, WEEK_MS, NOW)).toBe(0);
    expect(elapsedShare({ percent: 0, resetsAt: null }, WEEK_MS, NOW)).toBeNull();
  });

  it("surfaces a model's weekly window only near its limit", () => {
    const entry: ClaudeAccountUsage = {
      key: "k",
      profileIds: ["default"],
      status: "ok",
      fiveHour: null,
      sevenDay: null,
      scoped: [
        { label: "Fable", percent: 92, resetsAt: NOW + HOUR },
        { label: "Opus", percent: 40, resetsAt: NOW + HOUR },
        { label: "Sonnet", percent: 100, resetsAt: NOW - 1 },
      ],
    };
    expect(scopedAlerts(entry, NOW)).toEqual([{ label: "Fable", percent: 92 }]);
  });

  it("finds the next reset among every account", () => {
    const entry = (fiveHour: number | null, week: number | null): ClaudeAccountUsage => ({
      key: "k",
      profileIds: ["default"],
      status: "ok",
      fiveHour: fiveHour === null ? null : { percent: 1, resetsAt: fiveHour },
      sevenDay: week === null ? null : { percent: 1, resetsAt: week },
      scoped: [],
    });
    expect(nextReset([entry(NOW + HOUR, NOW + 50 * HOUR), entry(NOW + 30 * MINUTE, null)], NOW)).toBe(
      NOW + 30 * MINUTE,
    );
    expect(nextReset([entry(NOW - 1, null)], NOW)).toBeNull();
  });
});

describe("durations", () => {
  it("rounds countdowns up to the minute", () => {
    expect(formatDurationShort(10_000)).toBe("1 min");
    expect(formatDurationShort(45 * MINUTE)).toBe("45 min");
    expect(formatDurationShort(2 * HOUR + 13 * MINUTE + 30_000)).toBe("2h 14m");
    expect(formatDurationShort(3 * HOUR)).toBe("3h");
    expect(formatDurationShort(3 * 24 * HOUR + 4 * HOUR)).toBe("3d 4h");
    expect(formatDurationLong(2 * HOUR + 14 * MINUTE)).toBe("2 h 14 min");
    expect(formatDurationLong(5 * 24 * HOUR)).toBe("5 d");
  });
});

describe("reset times", () => {
  it("counts down within the day and names the weekday beyond it", () => {
    // Off the hour by a hair, as the endpoint sends it.
    const fiveHour = new Date(2026, 8, 28, 16, 59, 59, 896).getTime();
    expect(formatResetShort(fiveHour, NOW)).toBe("3h 14m");

    const saturday = new Date(2026, 9, 3, 14, 0, 0, 105).getTime();
    expect(formatResetShort(saturday, NOW)).toBe("sáb 14h");

    const halfPast = new Date(2026, 9, 3, 14, 30).getTime();
    expect(formatResetShort(halfPast, NOW)).toBe("sáb 14:30");

    expect(formatResetShort(null, NOW)).toBe("—");
    expect(formatResetShort(NOW - MINUTE, NOW)).toBe("agora");
  });

  it("spells the day out in the tooltip", () => {
    const today = new Date(2026, 8, 28, 17, 0).getTime();
    expect(formatResetLong(today, NOW)).toBe("hoje às 17:00 (em 3 h 14 min)");

    const tomorrow = new Date(2026, 8, 29, 9, 0).getTime();
    expect(formatResetLong(tomorrow, NOW)).toBe("amanhã às 09:00 (em 19 h 14 min)");

    const saturday = new Date(2026, 9, 3, 14, 0).getTime();
    expect(formatResetLong(saturday, NOW)).toBe("sáb., 03/10 às 14:00 (em 5 d)");
  });

  it("speaks English clocks in English", () => {
    setLocale("en");
    const saturday = new Date(2026, 9, 3, 14, 0).getTime();
    expect(formatResetShort(saturday, NOW)).toBe("Sat 2 PM");
    expect(formatResetShort(new Date(2026, 9, 3, 14, 30).getTime(), NOW)).toBe("Sat 2:30 PM");
    // ICU puts a narrow no-break space before "AM".
    expect(formatResetLong(new Date(2026, 8, 29, 9, 0).getTime(), NOW)).toMatch(
      /^tomorrow at 9:00\sAM \(in 19 h 14 min\)$/u,
    );
  });

  it("says how old a read is", () => {
    expect(formatAge(NOW - 20_000, NOW)).toBe("agora há pouco");
    expect(formatAge(NOW - 3 * MINUTE, NOW)).toBe("há 3 min");
    expect(formatAge(NOW - 2 * HOUR, NOW)).toBe("há 2 h");
  });
});

describe("describeAccountUsage", () => {
  const base: ClaudeAccountUsage = {
    key: "k",
    profileIds: ["default"],
    status: "ok",
    plan: "Pro",
    fiveHour: { percent: 100, resetsAt: new Date(2026, 8, 28, 17, 0).getTime() },
    sevenDay: { percent: 45, resetsAt: null },
    scoped: [{ label: "Fable", percent: 30, resetsAt: new Date(2026, 8, 28, 17, 0).getTime() }],
    fetchedAt: NOW - 3 * MINUTE,
  };

  it("lists every window, the read's age and the pace hint", () => {
    expect(describeAccountUsage(base, "Matheus", NOW).split("\n")).toEqual([
      "Matheus — Pro",
      "Sessão (5 h): 100% usado — limite atingido · reinicia hoje às 17:00 (em 3 h 14 min)",
      "Semana: 45% usado · sem janela aberta — começa na próxima mensagem",
      "Semana · Fable: 30% usado · reinicia hoje às 17:00 (em 3 h 14 min)",
      "atualizado há 3 min",
      "A marca na barra é quanto da janela já passou.",
    ]);
  });

  it("explains old numbers and missing ones", () => {
    expect(
      describeAccountUsage({ ...base, status: "stale", problem: "expired" }, "Matheus", NOW),
    ).toContain("atualizado há 3 min (desatualizado)\nO login desta conta expirou.");
    expect(
      describeAccountUsage(
        { ...base, status: "unavailable", problem: "network", fiveHour: null, sevenDay: null, scoped: [] },
        "Matheus",
        NOW,
      ).split("\n"),
    ).toEqual([
      "Matheus — Pro",
      "Uso indisponível",
      "Não foi possível falar com a Anthropic agora.",
    ]);
    expect(
      describeAccountUsage(
        { key: "k", profileIds: ["default"], status: "signed-out", fiveHour: null, sevenDay: null, scoped: [] },
        "Matheus",
        NOW,
      ),
    ).toBe("Matheus\nSem login — rode /login numa sessão");
  });
});
