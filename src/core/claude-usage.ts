import type {
  ClaudeAccountUsage,
  ClaudeUsageWindow,
} from "../../electron/types/api";
import { locale, msg } from "../i18n";
import type { ClaudeAccountProfile } from "./claude-accounts";
import { sessionClaudeAccountId } from "./session-filter";
import { collectPaneIds } from "./session-layout";
import type { AgentSession } from "../types/session";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const FIVE_HOUR_MS = 5 * HOUR;
export const WEEK_MS = 7 * DAY;

/**
 * The profiles some session runs on, in the order Settings lists them. A
 * profile deleted from under its sessions is left out: there is no login
 * left to read its usage with.
 */
export function claudeProfilesInUse(
  sessions: AgentSession[],
  profiles: ClaudeAccountProfile[],
): string[] {
  const inUse = new Set<string>();
  for (const session of sessions) {
    const id = sessionClaudeAccountId(session);
    if (id !== null) {
      inUse.add(id);
    }
  }
  return profiles.filter((profile) => inUse.has(profile.id)).map((profile) => profile.id);
}

/** The profile each Claude pane runs on: a turn that ends there spends
 * that account's limits, so it is the one read again. */
export function claudePaneProfiles(sessions: AgentSession[]): Map<string, string> {
  const panes = new Map<string, string>();
  for (const session of sessions) {
    const id = sessionClaudeAccountId(session);
    if (id === null) {
      continue;
    }
    for (const paneId of collectPaneIds(session.layout)) {
      panes.set(paneId, id);
    }
  }
  return panes;
}

/** "Tailwind · N Suite" — every profile signed in to the account. */
export function accountName(
  profileIds: string[],
  profiles: ClaudeAccountProfile[],
): string {
  return profileIds
    .map(
      (id) =>
        profiles.find((profile) => profile.id === id)?.name ??
        msg.core.sessionFilter.removedProfile,
    )
    .join(" · ");
}

/**
 * The window as it stands now. Once its reset time has passed it started
 * over — nothing used, and no reset time until the next read says one.
 */
export function currentWindow(
  window: ClaudeUsageWindow | null,
  now: number,
): ClaudeUsageWindow | null {
  if (window && window.resetsAt !== null && window.resetsAt <= now) {
    return { percent: 0, resetsAt: null };
  }
  return window;
}

/** A model's own weekly window gets a place on screen from here on. */
const SCOPED_ALERT_PERCENT = 75;

/**
 * The model-scoped weekly windows ("Fable") close to their limit. Below
 * that they stay in the tooltip: the all-models week is what usually binds,
 * but a model can run out first.
 */
export function scopedAlerts(
  entry: ClaudeAccountUsage,
  now: number,
): Array<{ label: string; percent: number }> {
  return entry.scoped.flatMap((window) => {
    const percent = currentWindow(window, now)?.percent ?? 0;
    return percent >= SCOPED_ALERT_PERCENT ? [{ label: window.label, percent }] : [];
  });
}

/** How much of the window has gone by, 0-1: the pace to compare usage with.
 * Null while no window is open. */
export function elapsedShare(
  window: ClaudeUsageWindow | null,
  windowMs: number,
  now: number,
): number | null {
  if (!window || window.resetsAt === null) {
    return null;
  }
  return Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / windowMs));
}

/** The next moment one of these accounts' windows starts over, if any. */
export function nextReset(entries: ClaudeAccountUsage[], now: number): number | null {
  let next: number | null = null;
  for (const entry of entries) {
    for (const window of [entry.fiveHour, entry.sevenDay, ...entry.scoped]) {
      const at = window?.resetsAt;
      if (at != null && at > now && (next === null || at < next)) {
        next = at;
      }
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
  return new Intl.DateTimeFormat(locale, { weekday: "short" })
    .format(at)
    .replace(/\.$/u, "");
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

/**
 * When the window starts over, for the row: a countdown within the day
 * ("2h 14m"), the weekday beyond it ("sáb 14h"), "—" with no window open.
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
  return `${weekdayShort(at)} ${clockShort(at)}`;
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

function windowLine(label: string, window: ClaudeUsageWindow | null, now: number): string | null {
  const texts = msg.sidebar.usage;
  const current = currentWindow(window, now);
  if (!current) {
    return null;
  }
  const reset =
    current.resetsAt === null
      ? texts.noWindow
      : texts.resets(formatResetLong(current.resetsAt, now));
  const limit = current.percent >= 100 ? ` — ${texts.limitReached}` : "";
  return `${label}: ${texts.used(current.percent)}${limit} · ${reset}`;
}

/** Everything about one account, one fact per line, for its tooltip. */
export function describeAccountUsage(
  entry: ClaudeAccountUsage,
  name: string,
  now: number,
): string {
  const texts = msg.sidebar.usage;
  const lines = [entry.plan ? `${name} — ${entry.plan}` : name];

  if (entry.status === "signed-out") {
    lines.push(texts.signedOut);
    return lines.join("\n");
  }
  if (entry.status === "unavailable") {
    lines.push(texts.unavailable);
    if (entry.problem) {
      lines.push(texts.problem[entry.problem]);
    }
    return lines.join("\n");
  }

  for (const line of [
    windowLine(texts.fiveHour, entry.fiveHour, now),
    windowLine(texts.week, entry.sevenDay, now),
    ...entry.scoped.map((window) =>
      windowLine(texts.scoped(window.label), window, now),
    ),
  ]) {
    if (line) {
      lines.push(line);
    }
  }
  if (entry.fetchedAt !== undefined) {
    lines.push(
      `${texts.updated(formatAge(entry.fetchedAt, now))}` +
        (entry.status === "stale" ? ` (${texts.stale})` : ""),
    );
  }
  if (entry.status === "stale" && entry.problem) {
    lines.push(texts.problem[entry.problem]);
  }
  lines.push(texts.paceHint);
  return lines.join("\n");
}
