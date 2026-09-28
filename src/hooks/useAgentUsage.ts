import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentUsage, UsageTarget } from "../../electron/types/api";
import { nextReset, usageTargetKey } from "../core/agent-usage";

/** How often main is asked; it only goes to the network every few minutes. */
const POLL_INTERVAL_MS = 60_000;
/** Usage endpoints catch up a few seconds after a turn ends. */
const TURN_SETTLE_MS = 5_000;
/** A window that just started over is read again a moment after. */
const RESET_GRACE_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A refresh answered from memory would only flash the spinner. */
const MIN_SPIN_MS = 600;

/** The last answer per target: coming back to a session shows its numbers
 * at once, while the fresh read is on its way. */
const lastUsage = new Map<string, AgentUsage | null>();

type Read = (refresh: boolean, manual?: boolean) => void;

export interface AgentUsageState {
  /** Null until the first answer, and when the agent has no plan limits. */
  usage: AgentUsage | null;
  /** A refresh the user asked for is running. */
  refreshing: boolean;
  refresh(): void;
}

/**
 * Plan limits of whoever `target` runs on, kept current: read again when
 * the session changes, asked every minute while the window is visible,
 * again a few seconds after the session's agent stops working (`busy` turns
 * false), and when a window starts over. Main decides when that actually
 * reaches the network — at most once every 45 s per account on request.
 */
export function useAgentUsage(
  target: UsageTarget | null,
  sessionId: string | null,
  busy: boolean,
): AgentUsageState {
  const key = target ? usageTargetKey(target) : null;
  const [answer, setAnswer] = useState<{ key: string; usage: AgentUsage | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const readRef = useRef<Read | null>(null);
  const settle = useRef<number | null>(null);

  useEffect(() => {
    const current = targetRef.current;
    // Without the preload's side (tests, a stale renderer) there is nothing
    // to show — never a broken sidebar.
    const api = window.headTerminal?.usage;
    if (!key || !current || !api) {
      readRef.current = null;
      setAnswer(null);
      return;
    }
    setAnswer(lastUsage.has(key) ? { key, usage: lastUsage.get(key) ?? null } : null);

    let cancelled = false;
    let inFlight = false;
    let queued: { refresh: boolean; manual: boolean } | null = null;
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
        queued = {
          refresh: (queued?.refresh ?? false) || refresh,
          manual: (queued?.manual ?? false) || manual,
        };
        return;
      }
      inFlight = true;
      api
        .get(current, refresh)
        .then((usage) => {
          lastUsage.set(key, usage);
          if (!cancelled) setAnswer({ key, usage });
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
            read(next.refresh, next.manual);
          }
        });
    };
    readRef.current = read;

    // Coming to this account from another session: numbers as of now.
    read(true);

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => read(false), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        read(false);
        start();
      }
    };

    if (!document.hidden) {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      readRef.current = null;
      // A turn that ended in the session left behind is not this one's.
      if (settle.current !== null) {
        window.clearTimeout(settle.current);
        settle.current = null;
      }
      setRefreshing(false);
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [key, sessionId]);

  // The agent just finished working: that turn spent the limits. Counted
  // from the first turn that ended — a new one starting meanwhile does not
  // push the read back, or an agent that keeps going would never get one.
  const previous = useRef({ sessionId, busy });
  useEffect(() => {
    // Another session is other terminals: its idleness ends no turn here.
    const ended = previous.current.sessionId === sessionId && previous.current.busy && !busy;
    previous.current = { sessionId, busy };
    if (!ended || settle.current !== null) return;
    settle.current = window.setTimeout(() => {
      settle.current = null;
      readRef.current?.(true);
    }, TURN_SETTLE_MS);
  }, [sessionId, busy]);

  const usage = answer && answer.key === key ? answer.usage : null;

  useEffect(() => {
    if (!usage) return;
    const now = Date.now();
    const at = nextReset(usage, now);
    if (at === null) return;
    const timer = window.setTimeout(
      () => readRef.current?.(true),
      Math.min(MAX_TIMEOUT_MS, at - now + RESET_GRACE_MS),
    );
    return () => window.clearTimeout(timer);
  }, [usage]);

  const refresh = useCallback(() => readRef.current?.(true, true), []);

  return { usage, refreshing, refresh };
}
