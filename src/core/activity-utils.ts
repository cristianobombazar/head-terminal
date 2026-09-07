import { ACTIVITY_PRIORITY, type PaneActivity } from "../types/activity";
import { collectPaneIds } from "./session-layout";
import type { PaneRuntime } from "./session-manager";
import type { AgentSession } from "../types/session";

export function aggregatePaneActivity(
  paneRuntime: Record<string, PaneRuntime>,
  paneIds: string[],
): PaneActivity {
  if (paneIds.length === 0) {
    return "starting";
  }

  let best: PaneActivity = "exited";

  for (const paneId of paneIds) {
    const activity = paneRuntime[paneId]?.activity ?? "starting";
    if (ACTIVITY_PRIORITY[activity] > ACTIVITY_PRIORITY[best]) {
      best = activity;
    }
  }

  return best;
}

export function getSessionActivity(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): PaneActivity {
  const paneIds = collectPaneIds(session.layout);
  return aggregatePaneActivity(paneRuntime, paneIds);
}

/**
 * When the session's aggregated activity started. Only panes that share the
 * winning activity count: the sidebar used to take the newest timestamp of
 * any pane, so "Executando há 3s" could be timed by a sibling pane that had
 * just gone idle while the working one had been at it for minutes.
 */
export function getSessionActivitySince(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): number | undefined {
  const paneIds = collectPaneIds(session.layout);
  const activity = aggregatePaneActivity(paneRuntime, paneIds);
  let since = 0;
  for (const paneId of paneIds) {
    const runtime = paneRuntime[paneId];
    if (runtime?.activity === activity && runtime.activitySince > since) {
      since = runtime.activitySince;
    }
  }
  return since || undefined;
}

export function countWorkingSessions(
  sessions: AgentSession[],
  paneRuntime: Record<string, PaneRuntime>,
): number {
  return sessions.filter(
    (session) => getSessionActivity(session, paneRuntime) === "working",
  ).length;
}
