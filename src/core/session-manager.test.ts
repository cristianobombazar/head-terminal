import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentSession } from "../types/session";
import { EMPTY_GIT_CONTEXT } from "../types/git-context";
import {
  collectPaneIds,
  findPaneNode,
  resolvePaneCwd,
} from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";

function session(id: string, pinned = false): AgentSession {
  return createEmptySession({
    id,
    title: id,
    cwd: "/tmp",
    agentProfileId: "shell",
    pinned,
  });
}

describe("useSessionStore session order", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("does not reorder sessions while hydrating, adding, or pinning", () => {
    const first = session("first");
    const second = session("second", true);
    const third = session("third");

    useSessionStore.getState().hydrateWorkspace([first, second], first.id, null);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);

    useSessionStore.getState().addSession(third);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);

    useSessionStore.getState().togglePinSession(third.id);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("useSessionStore restartPane continue flag", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("clears restoredPaneIds when restarting for a fresh conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);

    useSessionStore.getState().restartPane(paneId, {
      continueConversation: false,
    });

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBeUndefined();
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("keeps restoredPaneIds when restarting to continue the conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);

    useSessionStore.getState().restartPane(paneId, {
      continueConversation: true,
    });

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("leaves restoredPaneIds alone when options are omitted", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);

    useSessionStore.getState().restartPane(paneId);

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
  });
});

describe("useSessionStore hydrateWorkspace pane resume anchors", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("resumes an anchored pane precisely, even when it isn't the active pane", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    const otherPaneId = "some-other-pane";

    useSessionStore
      .getState()
      .hydrateWorkspace([first], first.id, otherPaneId, { [paneId]: "anchor-abc" });

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBe("anchor-abc");
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
  });

  it("only blanket-continues the active pane, and leaves other anchor-less panes fresh — the fix for panes colliding onto the same conversation on restart", () => {
    const first = session("first");
    useSessionStore.getState().addSession(first);
    // Both splits target the still-active original pane, so this ends up
    // with 3 panes total in one session (a common "3 terminals" layout).
    useSessionStore.getState().splitActivePane("vertical");
    useSessionStore.getState().splitActivePane("horizontal");
    const sessionWithPanes = useSessionStore.getState().sessions[0];
    const allPaneIds = collectPaneIds(sessionWithPanes.layout);
    expect(new Set(allPaneIds).size).toBe(3);
    const [paneA, paneB, paneC] = allPaneIds;

    // Simulate an app restart: only paneB (the active one) has no anchor
    // yet; paneA has a real anchor from a previous run; paneC has neither
    // an anchor nor focus.
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    useSessionStore
      .getState()
      .hydrateWorkspace([sessionWithPanes], sessionWithPanes.id, paneB, {
        [paneA]: "anchor-a",
      });

    const state = useSessionStore.getState();
    expect(state.paneResumeSessionIds[paneA]).toBe("anchor-a");
    expect(state.restoredPaneIds[paneA]).toBe(true);

    expect(state.paneResumeSessionIds[paneB]).toBeUndefined();
    expect(state.restoredPaneIds[paneB]).toBe(true);

    expect(state.paneResumeSessionIds[paneC]).toBeUndefined();
    expect(state.restoredPaneIds[paneC]).toBeUndefined();
  });
});

describe("useSessionStore notePaneResumeAnchor", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("records the auto-detected session id without forcing a restart", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    const restartKeyBefore = useSessionStore.getState().paneRestartKeys[paneId] ?? 0;

    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBe("detected-xyz");
    expect(useSessionStore.getState().paneRestartKeys[paneId] ?? 0).toBe(restartKeyBefore);
  });

  it("is a no-op for a pane that does not belong to any session", () => {
    const before = useSessionStore.getState();
    useSessionStore.getState().notePaneResumeAnchor("missing-pane", "detected-xyz");
    expect(useSessionStore.getState()).toBe(before);
  });

  it("clears the anchor when the CLI refuses to resume it, without restarting the pane", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");
    const restartKeyBefore = useSessionStore.getState().paneRestartKeys[paneId] ?? 0;

    useSessionStore.getState().clearPaneResumeAnchor(paneId);

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBeUndefined();
    expect(useSessionStore.getState().paneRestartKeys[paneId] ?? 0).toBe(restartKeyBefore);
  });

  it("drops the anchor when the pane is closed", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBeUndefined();
  });
});

describe("useSessionStore resumePane", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("records the picked session id, marks restored, and bumps the restart key", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);

    useSessionStore.getState().resumePane(paneId, "abc-123");

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBe("abc-123");
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("is a no-op for a pane that does not belong to any session", () => {
    const before = useSessionStore.getState();
    useSessionStore.getState().resumePane("missing-pane", "abc-123");
    expect(useSessionStore.getState()).toBe(before);
  });

  it("clears a picked resume id on the next plain restart", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().resumePane(paneId, "abc-123");

    useSessionStore.getState().restartPane(paneId, { continueConversation: true });

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBeUndefined();
  });

  it("drops the pane's resume id when the pane is closed", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().resumePane(paneId, "abc-123");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBeUndefined();
  });
});

describe("useSessionStore conversation labels", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("names a conversation by its CLI session id and clears it with an empty name", () => {
    useSessionStore.getState().setConversationLabel("abc-123", "  Refactor   do PDF  ");
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Refactor do PDF",
    );

    useSessionStore.getState().setConversationLabel("abc-123", "   ");
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBeUndefined();
  });

  it("renames the conversation a pane is already on", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");

    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("parks a name typed before the CLI session id is known and applies it on anchor", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);

    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBe(
      "Faturamento",
    );

    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("does not carry a parked name onto a conversation picked from the dropdown", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().resumePane(paneId, "other-999");

    expect(useSessionStore.getState().conversationLabels["other-999"]).toBeUndefined();
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("drops a parked name when the pane restarts into a fresh conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().restartPane(paneId, { continueConversation: false });

    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("keeps names of conversations whose panes are gone, since ids outlive panes", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
  });

  it("caches transcript titles without touching the user's names", () => {
    useSessionStore.getState().setConversationLabel("abc-123", "Faturamento");
    useSessionStore.getState().noteConversationTitles([
      { id: "abc-123", title: "primeira mensagem" },
      { id: "def-456", title: "outra conversa" },
    ]);

    expect(useSessionStore.getState().conversationTitles["abc-123"]).toBe(
      "primeira mensagem",
    );
    expect(useSessionStore.getState().conversationTitles["def-456"]).toBe(
      "outra conversa",
    );
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
  });
});

describe("useSessionStore git context merge", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("does not replace pane git context when only lastTouchedAt or source change", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...EMPTY_GIT_CONTEXT,
      repoRoot: "/repo",
      branch: "main",
      lastTouchedPath: "src/a.ts",
      lastTouchedAt: 10,
      source: "initial",
    });
    const before = useSessionStore.getState().paneGitContext[paneId];

    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...before,
      lastTouchedAt: 99,
      source: "poll",
    });

    expect(useSessionStore.getState().paneGitContext[paneId]).toBe(before);
  });

  it("updates lastTouchedPath without a git IPC payload", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...EMPTY_GIT_CONTEXT,
      repoRoot: "/repo",
      branch: "main",
    });

    useSessionStore.getState().mergePaneGitContext(paneId, {
      lastTouchedPath: "src/b.ts",
      lastTouchedAt: 50,
    });

    expect(useSessionStore.getState().paneGitContext[paneId]).toMatchObject({
      repoRoot: "/repo",
      branch: "main",
      lastTouchedPath: "src/b.ts",
    });
  });
});

describe("useSessionStore pane folders", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession() {
    const store = useSessionStore.getState();
    const created = createEmptySession({
      id: "s",
      title: "s",
      cwd: "C:\\Users\\m\\default",
      agentProfileId: "claude",
    });
    store.addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const session = useSessionStore.getState().sessions[0];
    const [, second] = collectPaneIds(session.layout);
    return { first, second };
  }

  it("moves one terminal to its own folder and restarts only that terminal", () => {
    const { first, second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys;

    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    const state = useSessionStore.getState();
    const session = state.sessions[0];
    expect(resolvePaneCwd(session, second)).toBe("D:\\repo");
    expect(resolvePaneCwd(session, first)).toBe("C:\\Users\\m\\default");
    expect(session.cwd).toBe("C:\\Users\\m\\default");
    expect(state.paneRestartKeys[second] ?? 0).toBe((before[second] ?? 0) + 1);
    expect(state.paneRestartKeys[first] ?? 0).toBe(before[first] ?? 0);
  });

  it("does nothing when the folder is already the pane's", () => {
    const { second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys[second] ?? 0;

    useSessionStore.getState().updatePaneCwd(second, "C:\\Users\\m\\default");
    useSessionStore.getState().updatePaneCwd(second, "   ");

    expect(useSessionStore.getState().paneRestartKeys[second] ?? 0).toBe(before);
  });

  it("puts a pane back on the session default instead of pinning a copy of it", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");
    useSessionStore.getState().updatePaneCwd(second, "C:\\Users\\m\\default");

    const session = useSessionStore.getState().sessions[0];
    expect(findPaneNode(session.layout, second)?.cwd).toBeUndefined();
  });

  it("splits inherit a pinned folder, and follow the session otherwise", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().splitActivePane("horizontal");
    let session = useSessionStore.getState().sessions[0];
    const pinnedChild = collectPaneIds(session.layout).find(
      (id) => id !== first && id !== second,
    )!;
    expect(resolvePaneCwd(session, pinnedChild)).toBe("D:\\repo");

    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("horizontal");
    session = useSessionStore.getState().sessions[0];
    const plainChild = collectPaneIds(session.layout).find(
      (id) => ![first, second, pinnedChild].includes(id),
    )!;
    expect(findPaneNode(session.layout, plainChild)?.cwd).toBeUndefined();
    expect(resolvePaneCwd(session, plainChild)).toBe("C:\\Users\\m\\default");
  });

  it("moving the session takes every pane along, pinned ones included", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    useSessionStore.getState().updateSessionCwd("s", "E:\\moved");

    const session = useSessionStore.getState().sessions[0];
    expect(resolvePaneCwd(session, first)).toBe("E:\\moved");
    expect(resolvePaneCwd(session, second)).toBe("E:\\moved");
    expect(findPaneNode(session.layout, second)?.cwd).toBeUndefined();
  });

  const worktree = {
    path: "D:\\repo-agent-1",
    branch: "agent-1",
    mainRepoRoot: "D:\\repo",
  };

  it("moves one terminal into its own worktree and restarts only it", () => {
    const { first, second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys;

    useSessionStore.getState().adoptPaneWorktree(second, worktree);

    const state = useSessionStore.getState();
    const session = state.sessions[0];
    expect(resolvePaneCwd(session, second)).toBe(worktree.path);
    expect(findPaneNode(session.layout, second)?.worktree).toEqual(worktree);
    expect(resolvePaneCwd(session, first)).toBe("C:\\Users\\m\\default");
    expect(state.paneRestartKeys[second] ?? 0).toBe((before[second] ?? 0) + 1);
    expect(state.paneRestartKeys[first] ?? 0).toBe(before[first] ?? 0);
  });

  it("takes the whole session into a worktree and brings every pane along", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\elsewhere");

    useSessionStore.getState().adoptSessionWorktree("s", worktree);

    const session = useSessionStore.getState().sessions[0];
    expect(session.cwd).toBe(worktree.path);
    expect(session.worktree).toEqual(worktree);
    expect(resolvePaneCwd(session, first)).toBe(worktree.path);
    expect(resolvePaneCwd(session, second)).toBe(worktree.path);
  });

  it("drops the worktree mark once the folder is moved by hand", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().adoptSessionWorktree("s", worktree);
    useSessionStore.getState().adoptPaneWorktree(second, worktree);

    // Sair da árvore isolada na mão: a sessão não responde mais por ela.
    useSessionStore.getState().updateSessionCwd("s", "E:\\moved");
    let session = useSessionStore.getState().sessions[0];
    expect(session.worktree).toBeUndefined();
    expect(findPaneNode(session.layout, second)?.worktree).toBeUndefined();

    useSessionStore.getState().adoptPaneWorktree(second, worktree);
    useSessionStore.getState().updatePaneCwd(second, "E:\\somewhere-else");
    session = useSessionStore.getState().sessions[0];
    expect(findPaneNode(session.layout, second)?.worktree).toBeUndefined();
  });

  it("keeps the mark when the session is pointed back at its own worktree", () => {
    withSplitSession();
    useSessionStore.getState().adoptSessionWorktree("s", worktree);

    useSessionStore.getState().updateSessionCwd("s", worktree.path);

    expect(useSessionStore.getState().sessions[0].worktree).toEqual(worktree);
  });
});

describe("useSessionStore maximized pane", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  it("toggles the zoom on the pane's own session", () => {
    const { sessionId, first, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(second);

    // Maximizing another pane moves the zoom instead of stacking one.
    useSessionStore.getState().toggleMaximizedPane(first);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(first);

    useSessionStore.getState().toggleMaximizedPane(first);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("ignores a session with a single terminal", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);

    useSessionStore.getState().toggleMaximizedPane(only);

    expect(useSessionStore.getState().maximizedPaneIds.solo).toBeUndefined();
  });

  it("drops the zoom when the maximized pane or its last sibling closes", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().closePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();

    // Closing the sibling leaves a lone terminal: the zoom would hide nothing.
    const split = withSplitSession("t");
    useSessionStore.getState().toggleMaximizedPane(split.second);
    useSessionStore.getState().closePane(split.first);
    expect(useSessionStore.getState().maximizedPaneIds.t).toBeUndefined();
  });

  it("drops the zoom when a new pane is split off", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().splitActivePane("horizontal");

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("forgets the zoom of a removed session", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().removeSession(sessionId);

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });
});

describe("useSessionStore minimized panes", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  it("minimizes a pane and hands the keyboard to one still on screen", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().setActivePaneId(second);

    useSessionStore.getState().minimizePane(second);

    const state = useSessionStore.getState();
    expect(state.minimizedPanes[second]).toBeDefined();
    expect(state.activePaneId).toBe(first);
  });

  it("keeps the last pane active when every pane is minimized", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);

    useSessionStore.getState().minimizePane(only);

    expect(useSessionStore.getState().minimizedPanes[only]).toBeDefined();
    expect(useSessionStore.getState().activePaneId).toBe(only);
  });

  it("restores a pane into its session and makes it the active one", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().addSession(session("other"));

    useSessionStore.getState().restorePane(second);

    const state = useSessionStore.getState();
    expect(state.minimizedPanes[second]).toBeUndefined();
    expect(state.activeSessionId).toBe(sessionId);
    expect(state.activePaneId).toBe(second);
    expect(state.minimizedPanes[first]).toBeUndefined();
  });

  it("ignores minimizing a pane twice or one that does not exist", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    const minimized = useSessionStore.getState().minimizedPanes;

    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().minimizePane("missing");

    expect(useSessionStore.getState().minimizedPanes).toBe(minimized);
  });

  it("remembers when a minimized agent stops working, until it works again", () => {
    const { second } = withSplitSession();
    const { updatePaneActivity } = useSessionStore.getState();
    updatePaneActivity(second, "working");
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().minimizedPanes[second].finishedAt).toBeUndefined();

    updatePaneActivity(second, "waiting_input");
    const finishedAt = useSessionStore.getState().minimizedPanes[second].finishedAt;
    expect(finishedAt).toBeTypeOf("number");

    updatePaneActivity(second, "idle");
    expect(useSessionStore.getState().minimizedPanes[second].finishedAt).toBe(finishedAt);

    updatePaneActivity(second, "working");
    expect(useSessionStore.getState().minimizedPanes[second].finishedAt).toBeUndefined();
  });

  it("does not track anything for panes on screen", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().updatePaneActivity(second, "working");
    useSessionStore.getState().updatePaneActivity(second, "idle");

    expect(useSessionStore.getState().minimizedPanes[second]).toBeUndefined();
  });

  it("drops the minimized state of a closed pane or removed session", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().closePane(second);
    expect(useSessionStore.getState().minimizedPanes[second]).toBeUndefined();

    useSessionStore.getState().minimizePane(first);
    useSessionStore.getState().removeSession(sessionId);
    expect(useSessionStore.getState().minimizedPanes[first]).toBeUndefined();
  });

  it("puts the keyboard on a pane on screen when a session is picked", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(first);
    useSessionStore.getState().addSession(session("other"));

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(second);
  });

  it("drops the zoom when the zoomed pane or the last pane left beside it is minimized", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();

    useSessionStore.getState().restorePane(second);
    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("does not zoom while only one pane is on screen", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);

    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().toggleMaximizedPane(second);

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("restoring a pane drops a zoom that would keep it hidden", () => {
    const created = session("three");
    useSessionStore.getState().addSession(created);
    const [a] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(a);
    useSessionStore.getState().splitActivePane("vertical");
    useSessionStore.getState().splitActivePane("horizontal");
    const [, zoomed, minimized] = collectPaneIds(
      useSessionStore.getState().sessions.find((item) => item.id === "three")!.layout,
    );
    useSessionStore.getState().minimizePane(minimized);
    useSessionStore.getState().toggleMaximizedPane(zoomed);
    expect(useSessionStore.getState().maximizedPaneIds.three).toBe(zoomed);

    useSessionStore.getState().restorePane(minimized);

    expect(useSessionStore.getState().maximizedPaneIds.three).toBeUndefined();
  });

  it("splitting a minimized active pane moves the keyboard to the new one", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);
    useSessionStore.getState().minimizePane(only);

    useSessionStore.getState().splitActivePane("vertical");

    const layout = useSessionStore.getState().sessions[0].layout;
    const [, added] = collectPaneIds(layout);
    expect(useSessionStore.getState().activePaneId).toBe(added);
    expect(useSessionStore.getState().minimizedPanes[only]).toBeDefined();
  });

  it("tracks an approval prompt per pane and clears it on restart", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().updatePaneApproval(second, true);
    expect(useSessionStore.getState().paneRuntime[second].awaitingApproval).toBe(true);

    useSessionStore.getState().restartPane(second);

    expect(useSessionStore.getState().paneRuntime[second].awaitingApproval).toBe(false);
  });
});
