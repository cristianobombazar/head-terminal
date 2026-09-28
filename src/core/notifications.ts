import { NEEDS_ATTENTION, type PaneActivity } from "../types/activity";
import { msg } from "../i18n";

const notifiedKeys = new Set<string>();

function notificationKey(sessionId: string, activity: PaneActivity): string {
  return `${sessionId}:${activity}`;
}

export async function notifySessionAttention(
  sessionTitle: string,
  activity: PaneActivity,
  sessionId: string,
): Promise<void> {
  if (!NEEDS_ATTENTION.has(activity)) {
    return;
  }

  if (document.hasFocus()) {
    return;
  }

  const key = notificationKey(sessionId, activity);
  if (notifiedKeys.has(key)) {
    return;
  }

  notifiedKeys.add(key);

  const body =
    activity === "error"
      ? msg.core.notifications.error(sessionTitle)
      : activity === "agent_fallback"
        ? msg.core.notifications.agentFallback(sessionTitle)
        : msg.core.notifications.attention(sessionTitle);

  await window.headTerminal.notifications.show({
    title: "Head Terminal",
    body,
    sessionId,
  });
}

export function clearSessionNotification(sessionId: string): void {
  for (const key of notifiedKeys) {
    if (key.startsWith(`${sessionId}:`)) {
      notifiedKeys.delete(key);
    }
  }
}
