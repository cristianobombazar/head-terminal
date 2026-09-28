import type {
  AgentUsage,
  UsageProvider,
  UsageTarget,
  UsageWindow,
} from "../../electron/types/api";
import { locale, msg } from "../i18n";
import type { ClaudeAccountProfile } from "./claude-accounts";
import { sessionClaudeAccountId } from "./session-filter";
import type { AgentSession } from "../types/session";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Past this, a reset shows as a date: a weekday would be ambiguous. */
const WEEKDAY_HORIZON_MS = 6 * DAY;
/** A narrower window (one model, one pool) earns a place on screen here. */
const EXTRA_ALERT_PERCENT = 75;

/** How each agent is called, and how its login is renewed by hand. */
export const USAGE_PROVIDERS: Record<UsageProvider, { name: string; login: string }> = {
  claude: { name: "Claude", login: "/login" },
  codex: { name: "Codex", login: "codex login" },
  cursor: { name: "Cursor", login: "cursor-agent login" },
};

/**
 * Whose usage the session spends. A Claude session runs on its profile — a
 * profile deleted from under it has no login left to read; a `claude` typed
 * in a Shell session on the shell's `~/.claude`. Inside WSL the logins are
 * the distribution's, out of reach. Agents without plan limits — a shell,
 * local models — have none to show.
 */
export function usageTarget(
  session: Pick<AgentSession, "agentProfileId" | "claudeAccountId" | "wslDistro"> | null,
  shownAgent: string | null,
  profiles: ClaudeAccountProfile[],
): UsageTarget | null {
  if (!session || !shownAgent || session.wslDistro) {
    return null;
  }
  if (shownAgent === "claude") {
    const profileId = sessionClaudeAccountId(session);
    if (profileId === null) {
      return { provider: "claude", profileId: "global" };
    }
    return profiles.some((profile) => profile.id === profileId)
      ? { provider: "claude", profileId }
      : null;
  }
  if (shownAgent === "codex" || shownAgent === "cursor") {
    return { provider: shownAgent };
  }
  return null;
}

export function usageTargetKey(target: UsageTarget): string {
  return target.provider === "claude" ? `claude:${target.profileId}` : target.provider;
}

/** The name on the panel: the Claude profile, else the agent. */
export function usageAccountName(
  target: UsageTarget,
  profiles: ClaudeAccountProfile[],
): string {
  if (target.provider !== "claude") {
    return USAGE_PROVIDERS[target.provider].name;
  }
  if (target.profileId === "global") {
    return "~/.claude";
  }
  return (
    profiles.find((profile) => profile.id === target.profileId)?.name ??
    msg.core.sessionFilter.removedProfile
  );
}

/** "5h", "7d", "API" — the row's label. */
export function windowShortLabel(window: UsageWindow): string {
  const texts = msg.sidebar.usage;
  if (window.kind === "session") return texts.fiveHourShort;
  if (window.kind === "week") return texts.weekShort;
  return window.label ?? texts.cycleShort;
}

/** "Sessão (5 h)", "Semana · Fable", "Ciclo de cobrança · API". */
export function windowName(window: UsageWindow): string {
  const texts = msg.sidebar.usage;
  const base =
    window.kind === "session" ? texts.fiveHour : window.kind === "week" ? texts.week : texts.cycle;
  return window.label ? texts.narrowed(base, window.label) : base;
}

/**
 * The window as it stands now. Once its reset time has passed it started
 * over — nothing used, and no reset time until the next read says one.
 */
export function currentWindow(window: UsageWindow, now: number): UsageWindow {
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return { ...window, percent: 0, resetsAt: null };
  }
  return window;
}

/** How much of the window has gone by, 0-1: the pace to compare usage with.
 * Null while no window is open or its length is unknown. */
export function elapsedShare(window: UsageWindow, now: number): number | null {
  if (window.resetsAt === null || !window.windowMs) {
    return null;
  }
  return Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / window.windowMs));
}

/** The narrower windows close to their limit: most of the time the plan's
 * main windows are what binds, but a model or a pool can run out first. */
export function extraAlerts(usage: AgentUsage, now: number): UsageWindow[] {
  return usage.extra
    .map((window) => currentWindow(window, now))
    .filter((window) => window.percent >= EXTRA_ALERT_PERCENT);
}

/** The next moment one of the windows starts over, if any. */
export function nextReset(usage: AgentUsage, now: number): number | null {
  let next: number | null = null;
  for (const window of [...usage.windows, ...usage.extra]) {
    const at = window.resetsAt;
    if (at !== null && at > now && (next === null || at < next)) {
      next = at;
    }
  }
  return next;
}

/** Reset times come a hair off the hour (16:59:59.896): shown to the minute. */
function toMinute(at: number): number {
  return Math.round(at / MINUTE) * MINUTE;
}

function splitDuration(ms: number): { days: number; hours: number; minutes: number } {
  // Rounded up: a countdown never shows zero while there is time left.
  const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE));
  const totalHours = Math.floor(totalMinutes / 60);
  return {
    days: Math.floor(totalHours / 24),
    hours: totalHours % 24,
    minutes: totalMinutes % 60,
  };
}

/** "45 min", "2h 14m", "3d 4h" — for the narrow reset column. */
export function formatDurationShort(ms: number): string {
  const { days, hours, minutes } = splitDuration(ms);
  if (days > 0) {
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes} min`;
}

/** "45 min", "2 h 14 min", "3 d 4 h" — for the tooltip. */
export function formatDurationLong(ms: number): string {
  const { days, hours, minutes } = splitDuration(ms);
  if (days > 0) {
    return hours ? `${days} d ${hours} h` : `${days} d`;
  }
  if (hours > 0) {
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  return `${minutes} min`;
}

function weekdayShort(at: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at).replace(/\.$/u, "");
}

/** "14h" / "14:30" in Portuguese, "2 PM" / "2:30 PM" in English. */
function clockShort(at: number): string {
  const date = new Date(at);
  const minutes = date.getMinutes();
  if (locale === "pt-BR") {
    const hours = String(date.getHours()).padStart(2, "0");
    return minutes ? `${hours}:${String(minutes).padStart(2, "0")}` : `${hours}h`;
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    ...(minutes ? { minute: "2-digit" } : {}),
  }).format(date);
}

/** "09:00" in Portuguese, "9:00 AM" in English. */
function clockLong(at: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: locale === "pt-BR" ? "2-digit" : "numeric",
    minute: "2-digit",
  }).format(at);
}

/** "25/10" in Portuguese, "Oct 25" in English. */
function dateShort(at: number): string {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: locale === "pt-BR" ? "2-digit" : "short",
  }).format(at);
}

/**
 * When the window starts over, for the row: a countdown within the day
 * ("2h 14m"), the weekday within the week ("sáb 14h"), the date beyond it
 * ("25/10"), "—" with no window open.
 */
export function formatResetShort(resetsAt: number | null, now: number): string {
  if (resetsAt === null) {
    return "—";
  }
  const at = toMinute(resetsAt);
  const left = at - now;
  if (left <= 0) {
    return msg.sidebar.usage.now;
  }
  if (left < DAY) {
    return formatDurationShort(left);
  }
  if (left < WEEKDAY_HORIZON_MS) {
    return `${weekdayShort(at)} ${clockShort(at)}`;
  }
  return dateShort(at);
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "hoje às 16:00 (em 2 h 14 min)", "sáb., 04/10 às 14:00 (em 5 d 3 h)". */
export function formatResetLong(resetsAt: number, now: number): string {
  const texts = msg.sidebar.usage;
  const at = toMinute(resetsAt);
  const left = at - now;
  if (left <= 0) {
    return texts.now;
  }
  const clock = clockLong(at);
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const when =
    days === 0
      ? texts.today(clock)
      : days === 1
        ? texts.tomorrow(clock)
        : texts.onDay(
            new Intl.DateTimeFormat(locale, {
              weekday: "short",
              day: "2-digit",
              month: "2-digit",
            }).format(at),
            clock,
          );
  return `${when} (${texts.inDuration(formatDurationLong(left))})`;
}

/** "agora há pouco", "há 3 min", "há 2 h". */
export function formatAge(fetchedAt: number, now: number): string {
  const age = now - fetchedAt;
  if (age < MINUTE) {
    return msg.sidebar.usage.justNow;
  }
  const minutes = Math.floor(age / MINUTE);
  const duration =
    minutes < 60
      ? `${minutes} min`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)} h`
        : `${Math.floor(minutes / (24 * 60))} d`;
  return msg.sidebar.usage.ago(duration);
}

function windowLine(window: UsageWindow, now: number): string {
  const texts = msg.sidebar.usage;
  const current = currentWindow(window, now);
  const reset =
    current.resetsAt === null
      ? texts.noWindow
      : texts.resets(formatResetLong(current.resetsAt, now));
  const limit = current.percent >= 100 ? ` — ${texts.limitReached}` : "";
  return `${windowName(window)}: ${texts.used(current.percent)}${limit} · ${reset}`;
}

/** Everything about the usage, one fact per line, for the tooltip. */
export function describeUsage(usage: AgentUsage, name: string, now: number): string {
  const texts = msg.sidebar.usage;
  const provider = USAGE_PROVIDERS[usage.provider];
  const problem = usage.problem
    ? texts.problem[usage.problem](provider.name, provider.login)
    : null;
  const lines = [usage.plan ? `${name} — ${usage.plan}` : name];

  if (usage.status === "signed-out") {
    lines.push(texts.signedOut(provider.login));
    return lines.join("\n");
  }
  if (usage.status === "unavailable") {
    lines.push(texts.unavailable);
    if (problem) lines.push(problem);
    return lines.join("\n");
  }

  const windows = [...usage.windows, ...usage.extra];
  lines.push(...windows.map((window) => windowLine(window, now)));
  if (usage.fetchedAt !== undefined) {
    lines.push(
      texts.updated(formatAge(usage.fetchedAt, now)) +
        (usage.status === "stale" ? ` (${texts.stale})` : ""),
    );
  }
  if (usage.status === "stale" && problem) {
    lines.push(problem);
  }
  if (windows.some((window) => window.windowMs && window.resetsAt !== null)) {
    lines.push(texts.paceHint);
  }
  return lines.join("\n");
}
