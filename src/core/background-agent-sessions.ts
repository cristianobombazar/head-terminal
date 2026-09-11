/**
 * Agent conversations the app runs headless (the voice brainstorm's
 * analyses) land in the same transcript folder as the pane's own, so the
 * pane's anchor watcher would adopt them as "the conversation this pane just
 * started". Ids are reserved here the moment the CLI reports them, and the
 * opening sentence of every headless prompt doubles as a marker for the
 * window before the id is known.
 */

const MAX_RESERVED = 200;
const reserved = new Set<string>();

/** Must match AGENT_PROMPT_MARKER in electron/services/live-brainstorm-service.ts. */
const BACKGROUND_TITLE_PREFIX = "Brainstorm por voz do Head Terminal";

export function reserveBackgroundAgentSession(sessionId: string): void {
  if (!sessionId) return;
  reserved.delete(sessionId);
  reserved.add(sessionId);
  if (reserved.size > MAX_RESERVED) {
    const oldest = reserved.values().next().value;
    if (oldest !== undefined) reserved.delete(oldest);
  }
}

export function isBackgroundAgentSession(sessionId: string): boolean {
  return reserved.has(sessionId);
}

/** A transcript whose opening message is the brainstorm's prompt. */
export function isBackgroundAgentTitle(title: string): boolean {
  return title.trimStart().startsWith(BACKGROUND_TITLE_PREFIX);
}
