import { describe, expect, it } from "vitest";

import type { ClaudeAccountProfile } from "./claude-accounts";
import type { AgentSession } from "../types/session";
import {
  claudeAccountFilterOptions,
  filterSessionsByClaudeAccount,
  sessionClaudeAccountId,
} from "./session-filter";

function session(
  id: string,
  agentProfileId: string,
  claudeAccountId?: string,
): AgentSession {
  return {
    id,
    title: id,
    cwd: "/tmp",
    agentProfileId,
    claudeAccountId,
    layout: { kind: "pane", paneId: `${id}-p1` },
  };
}

const PROFILES: ClaudeAccountProfile[] = [
  { id: "default", name: "Main" },
  { id: "alt", name: "Alternative" },
  { id: "unused", name: "Unused" },
];

describe("sessionClaudeAccountId", () => {
  it("puts a Claude session without an account on the default profile", () => {
    expect(sessionClaudeAccountId(session("a", "claude"))).toBe("default");
    expect(sessionClaudeAccountId(session("b", "claude", "alt"))).toBe("alt");
  });

  it("gives other agents no profile, whatever they carry", () => {
    expect(sessionClaudeAccountId(session("c", "shell"))).toBeNull();
    expect(sessionClaudeAccountId(session("d", "codex", "alt"))).toBeNull();
  });
});

describe("claudeAccountFilterOptions", () => {
  it("lists only the profiles in use, in Settings order", () => {
    const sessions = [
      session("a", "claude", "alt"),
      session("b", "shell"),
      session("c", "claude"),
      session("d", "claude", "alt"),
    ];

    expect(claudeAccountFilterOptions(sessions, PROFILES)).toEqual([
      { id: "default", label: "Main" },
      { id: "alt", label: "Alternative" },
    ]);
  });

  it("keeps sessions on a deleted profile findable", () => {
    const sessions = [session("a", "claude"), session("b", "claude", "gone")];

    expect(claudeAccountFilterOptions(sessions, PROFILES)).toEqual([
      { id: "default", label: "Main" },
      { id: "gone", label: "Perfil removido" },
    ]);
  });

  it("has nothing to offer without Claude sessions", () => {
    expect(claudeAccountFilterOptions([session("a", "shell")], PROFILES)).toEqual([]);
  });
});

describe("filterSessionsByClaudeAccount", () => {
  const sessions = [
    session("a", "claude"),
    session("b", "claude", "alt"),
    session("c", "shell"),
    session("d", "claude", "default"),
  ];

  it("keeps every session without a filter", () => {
    expect(filterSessionsByClaudeAccount(sessions, null)).toBe(sessions);
  });

  it("keeps only the sessions on that profile, in their order", () => {
    expect(
      filterSessionsByClaudeAccount(sessions, "default").map((item) => item.id),
    ).toEqual(["a", "d"]);
    expect(
      filterSessionsByClaudeAccount(sessions, "alt").map((item) => item.id),
    ).toEqual(["b"]);
  });
});
