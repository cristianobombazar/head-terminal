import { useEffect, useMemo, useState, type ComponentType } from "react";

import type {
  AgentUsage,
  UsageProvider,
  UsageWindow,
} from "../../../electron/types/api";
import { getSessionShownAgent } from "../../core/activity-utils";
import {
  currentWindow,
  describeUsage,
  elapsedShare,
  extraAlerts,
  formatResetShort,
  USAGE_PROVIDERS,
  usageAccountName,
  usageTarget,
  windowName,
  windowShortLabel,
} from "../../core/agent-usage";
import type { ClaudeAccountProfile } from "../../core/claude-accounts";
import { formatPercent, resourceLoadColor } from "../../core/resource-usage";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { useAgentUsage } from "../../hooks/useAgentUsage";
import { msg } from "../../i18n";
import { useLocale } from "../../i18n/react";
import type { AgentSession } from "../../types/session";
import {
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconRefresh,
} from "../ui/Icons";

interface UsageMeterProps {
  /** The session on screen: the panel shows what its agent spends. */
  session: AgentSession | null;
  /** The sidebar already loaded them this render. */
  profiles: ClaudeAccountProfile[];
  collapsed: boolean;
}

const PROVIDER_ICON: Record<UsageProvider, ComponentType<{ size?: number; className?: string }>> =
  {
    claude: IconAgentClaude,
    codex: IconAgentCodex,
    cursor: IconAgentCursor,
  };

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

function UsageRow({ window, account, now }: { window: UsageWindow; account: string; now: number }) {
  const current = currentWindow(window, now);
  const color = resourceLoadColor(current.percent);
  const pace = elapsedShare(current, now);
  const reset = formatResetShort(current.resetsAt, now);
  return (
    <div
      className={
        current.percent >= 100 ? "usage-meter__row usage-meter__row--limit" : "usage-meter__row"
      }
    >
      <span className="usage-meter__label">{windowShortLabel(window)}</span>
      <div
        className="usage-meter__track"
        role="meter"
        aria-label={msg.sidebar.usage.meterAria(windowName(window), account)}
        aria-valuenow={current.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${msg.sidebar.usage.used(current.percent)}, ${reset}`}
      >
        <div
          className="usage-meter__fill"
          style={{ width: `${current.percent}%`, background: color }}
        />
        {/* Quanto da janela já passou: a barra à frente da marca está
            gastando mais rápido do que a janela anda. */}
        {pace !== null && (
          <div className="usage-meter__pace" style={{ left: `${pace * 100}%` }} />
        )}
      </div>
      <span className="usage-meter__value" style={{ color }}>
        {formatPercent(current.percent)}
      </span>
      <span className="usage-meter__reset">{reset}</span>
    </div>
  );
}

function hasNumbers(usage: AgentUsage): boolean {
  return usage.status === "ok" || usage.status === "stale";
}

/**
 * Limites do plano do agent da sessão aberta — 5 h e semana do Claude e do
 * Codex, o ciclo mensal do Cursor — com quando cada janela recomeça. Some
 * para agents sem plano (shell, modelos locais).
 */
export function UsageMeter({ session, profiles, collapsed }: UsageMeterProps) {
  useLocale();
  const paneIds = useMemo(() => (session ? collectPaneIds(session.layout) : []), [session]);
  const shownAgent = useSessionStore((state) =>
    session ? getSessionShownAgent(session, state.paneRuntime) : null,
  );
  // Busy while any of the session's terminals is working: the end of that
  // is when the numbers move.
  const busy = useSessionStore((state) =>
    paneIds.some((paneId) => state.paneRuntime[paneId]?.activity === "working"),
  );
  const target = usageTarget(session, shownAgent, profiles);
  const { usage, refreshing, refresh } = useAgentUsage(target, session?.id ?? null, busy);
  const now = useNow(usage !== null);

  if (!target || !usage) {
    return null;
  }

  const texts = msg.sidebar.usage;
  const name = usageAccountName(target, profiles);
  const details = describeUsage(usage, name, now);
  const Icon = PROVIDER_ICON[usage.provider];
  const stale = usage.status === "stale";

  if (collapsed) {
    return (
      <div
        className={
          stale
            ? "usage-meter usage-meter--compact usage-meter--stale"
            : "usage-meter usage-meter--compact"
        }
        title={details}
        aria-label={details}
        role="group"
      >
        <Icon size={11} className="usage-meter__compact-icon" />
        {hasNumbers(usage) && usage.windows.length > 0 ? (
          usage.windows.map((window, index) => {
            const percent = currentWindow(window, now).percent;
            return (
              <div key={index} className="usage-meter__compact-track">
                <div
                  className="usage-meter__fill"
                  style={{ width: `${percent}%`, background: resourceLoadColor(percent) }}
                />
              </div>
            );
          })
        ) : (
          // Sem números, nada de barras vazias — elas leriam como 0% usado.
          <span className="usage-meter__compact-none">—</span>
        )}
      </div>
    );
  }

  return (
    <section
      className={stale ? "usage-meter usage-meter--stale" : "usage-meter"}
      aria-label={texts.aria(name)}
    >
      <div className="usage-meter__head" title={details}>
        <Icon size={12} className="usage-meter__icon" />
        <span className="usage-meter__name">{name}</span>
        {usage.plan && <span className="usage-meter__plan">{usage.plan}</span>}
        {stale && <span className="usage-meter__flag">{texts.stale}</span>}
        {extraAlerts(usage, now).map((window, index) => (
          <span
            key={index}
            className="usage-meter__alert"
            style={{ color: resourceLoadColor(window.percent) }}
          >
            {window.label ?? windowShortLabel(window)} {formatPercent(window.percent)}
          </span>
        ))}
        <button
          type="button"
          className={
            refreshing
              ? "usage-meter__refresh usage-meter__refresh--spinning"
              : "usage-meter__refresh"
          }
          title={texts.refresh}
          aria-label={texts.refresh}
          disabled={refreshing}
          onClick={refresh}
        >
          <IconRefresh size={11} />
        </button>
      </div>
      {hasNumbers(usage) ? (
        <div className="usage-meter__rows" title={details}>
          {/* A posição é a identidade: duas janelas podem ter o mesmo nome. */}
          {usage.windows.map((window, index) => (
            <UsageRow key={index} window={window} account={name} now={now} />
          ))}
        </div>
      ) : (
        <div className="usage-meter__note" title={details}>
          {usage.status === "signed-out"
            ? texts.signedOut(USAGE_PROVIDERS[usage.provider].login)
            : texts.unavailable}
        </div>
      )}
    </section>
  );
}
