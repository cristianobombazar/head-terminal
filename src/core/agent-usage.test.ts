import { afterEach, describe, expect, it } from "vitest";

import type { AgentUsage, UsageWindow } from "../../electron/types/api";
import { setLocale } from "../i18n";
import {
  currentWindow,
  describeUsage,
  elapsedShare,
  extraAlerts,
  formatAge,
  formatDurationLong,
  formatDurationShort,
  formatResetLong,
  formatResetShort,
  nextReset,
  usageAccountName,
  usageTarget,
  usageTargetKey,
  windowName,
  windowShortLabel,
} from "./agent-usage";
import type { ClaudeAccountProfile } from "./claude-accounts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Local time, so the calendar words hold in any time zone the tests run in.
// 28/09/2026 is a Monday.
const NOW = new Date(2026, 8, 28, 13, 46, 20).getTime();

afterEach(() => setLocale("pt-BR"));

const PROFILES: ClaudeAccountProfile[] = [
  { id: "default", name: "Matheus" },
  { id: "p-tail", name: "Tailwind" },
];

function win(
  kind: UsageWindow["kind"],
  percent: number,
  resetsAt: number | null,
  extra: Partial<UsageWindow> = {},
): UsageWindow {
  return { kind, percent, resetsAt, windowMs: kind === "session" ? 5 * HOUR : 7 * DAY, ...extra };
}

describe("usageTarget", () => {
  it("follows the session's agent, and its Claude profile", () => {
    expect(
      usageTarget({ agentProfileId: "claude", claudeAccountId: "p-tail" }, "claude", PROFILES),
    ).toEqual({ provider: "claude", profileId: "p-tail" });
    expect(usageTarget({ agentProfileId: "claude" }, "claude", PROFILES)).toEqual({
      provider: "claude",
      profileId: "default",
    });
    expect(usageTarget({ agentProfileId: "codex" }, "codex", PROFILES)).toEqual({
      provider: "codex",
    });
    expect(usageTarget({ agentProfileId: "cursor" }, "cursor", PROFILES)).toEqual({
      provider: "cursor",
    });
  });

  it("has nothing for a profile deleted from under its session", () => {
    expect(
      usageTarget({ agentProfileId: "claude", claudeAccountId: "gone" }, "claude", PROFILES),
    ).toBeNull();
  });

  it("reads a claude typed in a Shell session on the shell's ~/.claude", () => {
    expect(usageTarget({ agentProfileId: "shell" }, "claude", PROFILES)).toEqual({
      provider: "claude",
      profileId: "global",
    });
  });

  it("has nothing inside WSL, where the logins are the distribution's", () => {
    for (const agent of ["claude", "codex", "cursor"]) {
      expect(
        usageTarget({ agentProfileId: "shell", wslDistro: "Ubuntu" }, agent, PROFILES),
      ).toBeNull();
    }
  });

  it("has nothing for agents without a plan, or no session", () => {
    for (const agent of ["shell", "ollama", "ornith", "qwen27", "antigravity"]) {
      expect(usageTarget({ agentProfileId: agent }, agent, PROFILES)).toBeNull();
    }
    expect(usageTarget(null, null, PROFILES)).toBeNull();
  });

  it("keys and names each target", () => {
    expect(usageTargetKey({ provider: "claude", profileId: "p-tail" })).toBe("claude:p-tail");
    expect(usageTargetKey({ provider: "cursor" })).toBe("cursor");
    expect(usageAccountName({ provider: "claude", profileId: "p-tail" }, PROFILES)).toBe(
      "Tailwind",
    );
    expect(usageAccountName({ provider: "claude", profileId: "global" }, PROFILES)).toBe(
      "~/.claude",
    );
    expect(usageAccountName({ provider: "claude", profileId: "gone" }, PROFILES)).toBe(
      "Perfil removido",
    );
    expect(usageAccountName({ provider: "codex" }, PROFILES)).toBe("Codex");
    expect(usageAccountName({ provider: "cursor" }, PROFILES)).toBe("Cursor");
  });
});

describe("windows", () => {
  it("labels each kind of window", () => {
    expect(windowShortLabel(win("session", 1, null))).toBe("5h");
    expect(windowShortLabel(win("week", 1, null))).toBe("7d");
    expect(windowShortLabel(win("cycle", 1, null, { label: "API" }))).toBe("API");
    expect(windowShortLabel(win("cycle", 1, null))).toBe("mês");
    expect(windowName(win("session", 1, null))).toBe("Sessão (5 h)");
    expect(windowName(win("week", 1, null, { label: "Fable" }))).toBe("Semana · Fable");
    expect(windowName(win("cycle", 1, null, { label: "Total" }))).toBe(
      "Ciclo de cobrança · Total",
    );
  });

  it("starts a window over once its reset time passed", () => {
    const window = win("session", 80, NOW + MINUTE);
    expect(currentWindow(window, NOW)).toBe(window);
    expect(currentWindow(window, NOW + MINUTE)).toMatchObject({ percent: 0, resetsAt: null });
  });

  it("measures how much of the window went by", () => {
    expect(elapsedShare(win("session", 0, NOW + 2 * HOUR), NOW)).toBeCloseTo(0.6);
    expect(elapsedShare(win("week", 0, NOW + 8 * DAY), NOW)).toBe(0);
    expect(elapsedShare(win("week", 0, null), NOW)).toBeNull();
    expect(elapsedShare(win("cycle", 0, NOW + DAY, { windowMs: null }), NOW)).toBeNull();
  });

  it("surfaces a narrower window only near its limit, and finds the next reset", () => {
    const usage: AgentUsage = {
      provider: "claude",
      status: "ok",
      windows: [win("session", 10, NOW + HOUR)],
      extra: [
        win("week", 92, NOW + 30 * MINUTE, { label: "Fable" }),
        win("week", 40, NOW + HOUR, { label: "Opus" }),
        win("week", 100, NOW - 1, { label: "Sonnet" }),
      ],
    };
    expect(extraAlerts(usage, NOW).map((window) => window.label)).toEqual(["Fable"]);
    expect(nextReset(usage, NOW)).toBe(NOW + 30 * MINUTE);
  });
});

describe("durations and reset times", () => {
  it("rounds countdowns up to the minute", () => {
    expect(formatDurationShort(10_000)).toBe("1 min");
    expect(formatDurationShort(2 * HOUR + 13 * MINUTE + 30_000)).toBe("2h 14m");
    expect(formatDurationShort(3 * DAY + 4 * HOUR)).toBe("3d 4h");
    expect(formatDurationLong(2 * HOUR + 14 * MINUTE)).toBe("2 h 14 min");
    expect(formatDurationLong(5 * DAY)).toBe("5 d");
  });

  it("counts down within the day, names the weekday within the week, dates beyond", () => {
    // Off the hour by a hair, as the endpoints send it.
    expect(formatResetShort(new Date(2026, 8, 28, 16, 59, 59, 896).getTime(), NOW)).toBe(
      "3h 14m",
    );
    expect(formatResetShort(new Date(2026, 9, 3, 14, 0, 0, 105).getTime(), NOW)).toBe("sáb 14h");
    expect(formatResetShort(new Date(2026, 9, 3, 14, 30).getTime(), NOW)).toBe("sáb 14:30");
    expect(formatResetShort(new Date(2026, 9, 25, 3, 7).getTime(), NOW)).toBe("25/10");
    expect(formatResetShort(null, NOW)).toBe("—");
    expect(formatResetShort(NOW - MINUTE, NOW)).toBe("agora");
  });

  it("spells the day out in the tooltip", () => {
    expect(formatResetLong(new Date(2026, 8, 28, 17, 0).getTime(), NOW)).toBe(
      "hoje às 17:00 (em 3 h 14 min)",
    );
    expect(formatResetLong(new Date(2026, 8, 29, 9, 0).getTime(), NOW)).toBe(
      "amanhã às 09:00 (em 19 h 14 min)",
    );
    expect(formatResetLong(new Date(2026, 9, 3, 14, 0).getTime(), NOW)).toBe(
      "sáb., 03/10 às 14:00 (em 5 d)",
    );
  });

  it("speaks English clocks and dates in English", () => {
    setLocale("en");
    expect(formatResetShort(new Date(2026, 9, 3, 14, 0).getTime(), NOW)).toBe("Sat 2 PM");
    expect(formatResetShort(new Date(2026, 9, 3, 14, 30).getTime(), NOW)).toBe("Sat 2:30 PM");
    expect(formatResetShort(new Date(2026, 9, 25, 3, 7).getTime(), NOW)).toBe("Oct 25");
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

describe("describeUsage", () => {
  const at17 = new Date(2026, 8, 28, 17, 0).getTime();
  const claude: AgentUsage = {
    provider: "claude",
    status: "ok",
    plan: "Pro",
    windows: [win("session", 100, at17), win("week", 45, null)],
    extra: [win("week", 30, at17, { label: "Fable" })],
    fetchedAt: NOW - 3 * MINUTE,
  };

  it("lists every window, the read's age and the pace hint", () => {
    expect(describeUsage(claude, "Matheus", NOW).split("\n")).toEqual([
      "Matheus — Pro",
      "Sessão (5 h): 100% usado — limite atingido · reinicia hoje às 17:00 (em 3 h 14 min)",
      "Semana: 45% usado · sem janela aberta — começa na próxima mensagem",
      "Semana · Fable: 30% usado · reinicia hoje às 17:00 (em 3 h 14 min)",
      "atualizado há 3 min",
      "A marca na barra é quanto da janela já passou.",
    ]);
  });

  it("explains old and missing numbers in the agent's own terms", () => {
    expect(
      describeUsage(
        { ...claude, provider: "codex", status: "stale", problem: "expired" },
        "Codex",
        NOW,
      ),
    ).toContain("atualizado há 3 min (desatualizado)\nO login expirou. O Codex renova sozinho");
    expect(
      describeUsage(
        { provider: "cursor", status: "unavailable", problem: "auth", windows: [], extra: [] },
        "Cursor",
        NOW,
      ).split("\n"),
    ).toEqual([
      "Cursor",
      "Uso indisponível",
      "O login foi recusado. Entre de novo com cursor-agent login.",
    ]);
    expect(
      describeUsage(
        { provider: "claude", status: "signed-out", windows: [], extra: [] },
        "Matheus",
        NOW,
      ),
    ).toBe("Matheus\nSem login — rode /login");
  });
});
