import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  type ClaudeAccountProfile,
} from "./claude-accounts";
import type { AgentSession } from "../types/session";
import { msg } from "../i18n";

export interface ClaudeAccountFilterOption {
  id: string;
  label: string;
}

/**
 * The Claude profile a session runs on, or `null` for a session that isn't
 * Claude and so has none. A Claude session without `claudeAccountId` runs on
 * the default profile.
 */
export function sessionClaudeAccountId(session: AgentSession): string | null {
  if (session.agentProfileId !== "claude") {
    return null;
  }
  return session.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT_ID;
}

/**
 * One option per Claude profile some session runs on, in the order the
 * profiles are listed in Settings. A profile deleted from under its sessions
 * still gets one, so those sessions can be found.
 */
export function claudeAccountFilterOptions(
  sessions: AgentSession[],
  profiles: ClaudeAccountProfile[],
): ClaudeAccountFilterOption[] {
  const inUse = new Set<string>();
  for (const session of sessions) {
    const id = sessionClaudeAccountId(session);
    if (id !== null) {
      inUse.add(id);
    }
  }

  const options = profiles
    .filter((profile) => inUse.has(profile.id))
    .map((profile) => ({ id: profile.id, label: profile.name }));
  for (const id of inUse) {
    if (!options.some((option) => option.id === id)) {
      options.push({ id, label: msg.core.sessionFilter.removedProfile });
    }
  }
  return options;
}

/** The sessions on one Claude profile; `null` keeps every session. */
export function filterSessionsByClaudeAccount(
  sessions: AgentSession[],
  accountId: string | null,
): AgentSession[] {
  if (accountId === null) {
    return sessions;
  }
  return sessions.filter((session) => sessionClaudeAccountId(session) === accountId);
}
