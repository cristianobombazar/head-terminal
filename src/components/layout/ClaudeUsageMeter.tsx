import { useEffect, useMemo, useState } from "react";

import type {
  ClaudeAccountUsage,
  ClaudeUsageWindow,
} from "../../../electron/types/api";
import type { ClaudeAccountProfile } from "../../core/claude-accounts";
import {
  accountName,
  claudePaneProfiles,
  claudeProfilesInUse,
  currentWindow,
  describeAccountUsage,
  elapsedShare,
  FIVE_HOUR_MS,
  formatResetShort,
  scopedAlerts,
  WEEK_MS,
} from "../../core/claude-usage";
import { formatPercent, resourceLoadColor } from "../../core/resource-usage";
import { useClaudeUsage } from "../../hooks/useClaudeUsage";
import { msg } from "../../i18n";
import { useLocale } from "../../i18n/react";
import type { AgentSession } from "../../types/session";
import { IconAgentClaude, IconRefresh } from "../ui/Icons";

interface ClaudeUsageMeterProps {
  sessions: AgentSession[];
  /** The sidebar already loaded them this render. */
  profiles: ClaudeAccountProfile[];
  collapsed: boolean;
  /** The sidebar's profile filter: with one picked, only its account shows. */
  accountFilter: string | null;
}

/** Countdowns move by the minute; half of that keeps them honest. */
const CLOCK_TICK_MS = 30_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function UsageRow({
  label,
  windowName,
  account,
  window,
  windowMs,
  now,
}: {
  label: string;
  windowName: string;
  account: string;
  window: ClaudeUsageWindow | null;
  windowMs: number;
  now: number;
}) {
  const current = currentWindow(window, now);
  if (!current) {
    return null;
  }
  const color = resourceLoadColor(current.percent);
  const pace = elapsedShare(current, windowMs, now);
  const reset = formatResetShort(current.resetsAt, now);
  return (
    <div
      className={
        current.percent >= 100
          ? "claude-usage__row claude-usage__row--limit"
          : "claude-usage__row"
      }
    >
      <span className="claude-usage__label">{label}</span>
      <div
        className="claude-usage__track"
        role="meter"
        aria-label={msg.sidebar.usage.meterAria(windowName, account)}
        aria-valuenow={current.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${msg.sidebar.usage.used(current.percent)}, ${reset}`}
      >
        <div
          className="claude-usage__fill"
          style={{ width: `${current.percent}%`, background: color }}
        />
        {/* Quanto da janela já passou: a barra à frente da marca está
            gastando mais rápido do que a janela anda. */}
        {pace !== null && (
          <div className="claude-usage__pace" style={{ left: `${pace * 100}%` }} />
        )}
      </div>
      <span className="claude-usage__value" style={{ color }}>
        {formatPercent(current.percent)}
      </span>
      <span className="claude-usage__reset">{reset}</span>
    </div>
  );
}

function AccountUsage({
  entry,
  name,
  now,
}: {
  entry: ClaudeAccountUsage;
  name: string;
  now: number;
}) {
  const texts = msg.sidebar.usage;
  const stale = entry.status === "stale";
  return (
    <div
      className={
        stale ? "claude-usage__account claude-usage__account--stale" : "claude-usage__account"
      }
      title={describeAccountUsage(entry, name, now)}
    >
      <div className="claude-usage__account-head">
        <span className="claude-usage__name">{name}</span>
        {stale && <span className="claude-usage__flag">{texts.stale}</span>}
        {scopedAlerts(entry, now).map(({ label, percent }) => (
          <span
            key={label}
            className="claude-usage__scoped"
            style={{ color: resourceLoadColor(percent) }}
          >
            {label} {formatPercent(percent)}
          </span>
        ))}
        {entry.plan && <span className="claude-usage__plan">{entry.plan}</span>}
      </div>
      {entry.status === "signed-out" || entry.status === "unavailable" ? (
        <div className="claude-usage__note">
          {entry.status === "signed-out" ? texts.signedOut : texts.unavailable}
        </div>
      ) : (
        <>
          <UsageRow
            label={texts.fiveHourShort}
            windowName={texts.fiveHour}
            account={name}
            window={entry.fiveHour}
            windowMs={FIVE_HOUR_MS}
            now={now}
          />
          <UsageRow
            label={texts.weekShort}
            windowName={texts.week}
            account={name}
            window={entry.sevenDay}
            windowMs={WEEK_MS}
            now={now}
          />
        </>
      )}
    </div>
  );
}

function CompactAccount({ entry, now }: { entry: ClaudeAccountUsage; now: number }) {
  // Sem números, nada de barras vazias — elas leriam como 0% usado.
  if (entry.status === "signed-out" || entry.status === "unavailable") {
    return <span className="claude-usage__compact-none">—</span>;
  }
  return (
    <div
      className={
        entry.status === "ok"
          ? "claude-usage__compact-account"
          : "claude-usage__compact-account claude-usage__compact-account--stale"
      }
    >
      {[entry.fiveHour, entry.sevenDay].map((window, index) => {
        const percent = currentWindow(window, now)?.percent ?? 0;
        return (
          <div key={index} className="claude-usage__compact-track">
            <div
              className="claude-usage__fill"
              style={{ width: `${percent}%`, background: resourceLoadColor(percent) }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Limites de 5 h e da semana de cada conta Claude das sessões da sidebar —
 * os números do `/usage`, uma conta por bloco (perfis logados na mesma
 * conta dividem um só), com quando cada janela recomeça.
 */
export function ClaudeUsageMeter({
  sessions,
  profiles,
  collapsed,
  accountFilter,
}: ClaudeUsageMeterProps) {
  useLocale();
  const inUse = claudeProfilesInUse(sessions, profiles);
  const idsKey = inUse.join("\n");
  // Stable while the set of profiles is: the hook restarts its polling on
  // a new array, and the session list re-renders far more often than that.
  const profileIds = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  const paneProfiles = useMemo(() => claudePaneProfiles(sessions), [sessions]);
  const { entries, refreshing, refresh } = useClaudeUsage(profileIds, paneProfiles);
  const now = useNow(Boolean(entries?.length));

  if (!entries) {
    return null;
  }
  const shown = entries
    .map((entry) => ({
      entry,
      // An answer from before a profile left the list may still name it.
      current: entry.profileIds.filter((id) => profileIds.includes(id)),
    }))
    .filter(
      ({ current }) =>
        current.length > 0 && (accountFilter === null || current.includes(accountFilter)),
    )
    .map(({ entry, current }) => ({ entry, name: accountName(current, profiles) }));
  if (shown.length === 0) {
    return null;
  }

  const texts = msg.sidebar.usage;

  if (collapsed) {
    const summary = shown
      .map(({ entry, name }) => describeAccountUsage(entry, name, now))
      .join("\n\n");
    return (
      <div
        className="claude-usage claude-usage--compact"
        title={summary}
        aria-label={summary}
        role="group"
      >
        <IconAgentClaude size={11} className="claude-usage__compact-icon" />
        {shown.map(({ entry }) => (
          <CompactAccount key={entry.key} entry={entry} now={now} />
        ))}
      </div>
    );
  }

  return (
    <section className="claude-usage" aria-label={texts.title}>
      <div className="claude-usage__header">
        <span className="claude-usage__title">
          <IconAgentClaude size={11} />
          {texts.title}
        </span>
        <button
          type="button"
          className={
            refreshing
              ? "claude-usage__refresh claude-usage__refresh--spinning"
              : "claude-usage__refresh"
          }
          title={texts.refresh}
          aria-label={texts.refresh}
          disabled={refreshing}
          onClick={refresh}
        >
          <IconRefresh size={11} />
        </button>
      </div>
      {shown.map(({ entry, name }) => (
        <AccountUsage key={entry.key} entry={entry} name={name} now={now} />
      ))}
    </section>
  );
}
