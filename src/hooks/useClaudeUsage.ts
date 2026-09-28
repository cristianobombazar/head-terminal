import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaudeAccountUsage } from "../../electron/types/api";
import { subscribeAllAgentHookEvents } from "../core/agent-hooks-bridge";
import { nextReset } from "../core/claude-usage";

/** How often main is asked; it only goes to the network every few minutes. */
const POLL_INTERVAL_MS = 60_000;
/** The usage endpoint catches up a few seconds after a turn ends. */
const TURN_SETTLE_MS = 5_000;
/** A window that just started over is read again a moment after. */
const RESET_GRACE_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A refresh answered from memory would only flash the spinner. */
const MIN_SPIN_MS = 600;
/** A turn that ended — normally, or on a limit — just moved the numbers. */
const TURN_END_EVENTS = new Set(["Stop", "StopFailure"]);

type Read = (refresh: string[], manual?: boolean) => void;

export interface ClaudeUsageState {
  /** Null until the first answer. */
  entries: ClaudeAccountUsage[] | null;
  /** A refresh the user asked for is running. */
  refreshing: boolean;
  refresh(): void;
}

/**
 * Limits of the accounts behind these Claude profiles, kept current: asked
 * every minute while the window is visible, again a few seconds after a
 * turn ends in one of the account's panes, and when one of the windows
 * starts over. Main decides when that actually reaches the network.
 */
export function useClaudeUsage(
  profileIds: string[],
  paneProfiles: ReadonlyMap<string, string>,
): ClaudeUsageState {
  const [entries, setEntries] = useState<ClaudeAccountUsage[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const idsKey = profileIds.join("\n");
  const paneProfilesRef = useRef(paneProfiles);
  paneProfilesRef.current = paneProfiles;
  const readRef = useRef<Read | null>(null);

  useEffect(() => {
    const ids = idsKey ? idsKey.split("\n") : [];
    // Without the preload's side (tests, a stale renderer) there is nothing
    // to show — never a broken sidebar.
    const api = window.headTerminal?.claudeUsage;
    if (ids.length === 0 || !api) {
      readRef.current = null;
      setEntries([]);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let queued: { refresh: Set<string>; manual: boolean } | null = null;
    let timer: number | null = null;

    let spinStartedAt = 0;

    const read: Read = (refresh, manual = false) => {
      // The click shows at once, even when it has to wait its turn below.
      if (manual && spinStartedAt === 0) {
        spinStartedAt = Date.now();
        setRefreshing(true);
      }
      if (inFlight) {
        // One request at a time; what arrives meanwhile goes out right after.
        queued ??= { refresh: new Set(), manual: false };
        refresh.forEach((id) => queued?.refresh.add(id));
        queued.manual ||= manual;
        return;
      }
      inFlight = true;
      api
        .get(ids, refresh)
        .then((next) => {
          if (!cancelled) setEntries(next);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
          if (cancelled) return;
          if (manual) {
            const spun = Date.now() - spinStartedAt;
            spinStartedAt = 0;
            window.setTimeout(() => {
              if (!cancelled) setRefreshing(false);
            }, Math.max(0, MIN_SPIN_MS - spun));
          }
          if (queued) {
            const next = queued;
            queued = null;
            read([...next.refresh], next.manual);
          }
        });
    };
    readRef.current = read;

    const start = () => {
      if (timer !== null) return;
      read([]);
      timer = window.setInterval(() => read([]), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      readRef.current = null;
      setRefreshing(false);
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [idsKey]);

  useEffect(() => {
    const ended = new Set<string>();
    let settle: number | null = null;
    const unsubscribe = subscribeAllAgentHookEvents((event) => {
      if (!TURN_END_EVENTS.has(event.event)) return;
      const profileId = paneProfilesRef.current.get(event.paneId);
      if (!profileId) return;
      ended.add(profileId);
      // Counted from the first turn that ended, not the last: with panes
      // finishing turns all the time, a timer that restarted on each one
      // would never go off.
      if (settle !== null) return;
      settle = window.setTimeout(() => {
        settle = null;
        const refresh = [...ended];
        ended.clear();
        readRef.current?.(refresh);
      }, TURN_SETTLE_MS);
    });
    return () => {
      unsubscribe();
      if (settle !== null) window.clearTimeout(settle);
    };
  }, []);

  useEffect(() => {
    if (!entries) return;
    const now = Date.now();
    const at = nextReset(entries, now);
    if (at === null) return;
    const refresh = entries.flatMap((entry) => entry.profileIds);
    const timer = window.setTimeout(
      () => readRef.current?.(refresh),
      Math.min(MAX_TIMEOUT_MS, at - now + RESET_GRACE_MS),
    );
    return () => window.clearTimeout(timer);
  }, [entries]);

  const refresh = useCallback(() => {
    readRef.current?.(idsKey ? idsKey.split("\n") : [], true);
  }, [idsKey]);

  return { entries, refreshing, refresh };
}
