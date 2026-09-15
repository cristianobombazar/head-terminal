import { memo, useEffect, useMemo, useRef } from "react";

import {
  collectPaneIds,
  collectPaneRects,
  collectSplitDividers, resolvePaneCwd } from "../../core/session-layout";
import { debounce } from "../../core/debounce";
import { fitPanes } from "../../core/pane-fit-registry";
import { useSessionStore } from "../../core/session-manager";
import { closePaneWithWorktreeReview } from "../../core/worktree";
import type { AgentSession } from "../../types/session";
import { TerminalStatusBar } from "../terminal/TerminalStatusBar";
import { LayoutDividers } from "./LayoutDividers";
import { TerminalPane } from "../terminal/TerminalPane";

interface SessionWorkspaceProps {
  session: AgentSession;
  isVisible: boolean;
  shouldSpawn: boolean;
  searchPaneId: string | null;
  onCloseSearch: () => void;
}

export const SessionWorkspace = memo(function SessionWorkspace({
  session,
  isVisible,
  shouldSpawn,
  searchPaneId,
  onCloseSearch,
}: SessionWorkspaceProps) {
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActivePaneId = useSessionStore((state) => state.setActivePaneId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const maximizedPaneId = useSessionStore(
    (state) => state.maximizedPaneIds[session.id] ?? null,
  );

  const canvasRef = useRef<HTMLDivElement>(null);

  const paneRects = useMemo(
    () => collectPaneRects(session.layout),
    [session.layout],
  );
  const paneRectById = useMemo(
    () => new Map(paneRects.map((rect) => [rect.paneId, rect])),
    [paneRects],
  );
  const dividers = useMemo(
    () => collectSplitDividers(session.layout),
    [session.layout],
  );
  const paneIds = useMemo(
    () => collectPaneIds(session.layout),
    [session.layout],
  );
  const zoomedPaneId =
    maximizedPaneId && paneIds.includes(maximizedPaneId) && paneIds.length > 1
      ? maximizedPaneId
      : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shouldSpawn) {
      return;
    }

    const debouncedFit = debounce(() => fitPanes(paneIds), 120);
    const resizeObserver = new ResizeObserver(() => {
      debouncedFit();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      debouncedFit.cancel();
    };
  }, [paneIds, shouldSpawn]);

  // Dragging a divider resizes the panes but not the canvas the observer
  // above watches, so nothing refit them: the terminal kept its old
  // cols/rows, drew past the pane edge and, on ConPTY, left stale cells
  // behind on every redraw. Every layout change (ratio, split, close) refits
  // once it settles — the timer resets on each pointer move, so the PTY sees
  // one resize per drag, not one per pixel.
  useEffect(() => {
    if (!shouldSpawn) {
      return;
    }
    const timer = window.setTimeout(() => fitPanes(paneIds), 120);
    return () => window.clearTimeout(timer);
  }, [session.layout, paneIds, shouldSpawn, zoomedPaneId]);

  const focusPane = (paneId: string) => {
    setActiveSessionId(session.id);
    setActivePaneId(paneId);
  };

  if (!shouldSpawn) {
    return null;
  }

  return (
    <section
      className={
        isVisible
          ? "session-workspace session-workspace--visible fade-in"
          : "session-workspace session-workspace--hidden"
      }
      aria-hidden={!isVisible}
    >
      <div ref={canvasRef} className="session-workspace__canvas">
        {paneIds.map((paneId, index) => {
          const isParked = zoomedPaneId !== null && paneId !== zoomedPaneId;
          // The zoomed pane spans the canvas; its siblings keep the rect
          // (and therefore the pty size) they had while parked off-screen.
          const rect =
            paneId === zoomedPaneId
              ? { paneId, top: 0, left: 0, width: 100, height: 100 }
              : paneRectById.get(paneId);
          const isActive =
            session.id === activeSessionId && paneId === activePaneId;

          return (
            <TerminalPane
              key={paneId}
              paneId={paneId}
              sessionId={session.id}
              cwd={resolvePaneCwd(session, paneId)}
              agentProfileId={session.agentProfileId}
              claudeAccountId={session.claudeAccountId}
              ollamaModel={session.ollamaModel}
              ollamaThinkOff={session.ollamaThinkOff}
              ggufPath={session.ggufPath}
              wslDistro={session.wslDistro}
              isVisible={isVisible && !isParked}
              shouldSpawn={shouldSpawn}
              isActive={isActive}
              isParked={isParked}
              isMaximized={paneId === zoomedPaneId}
              paneIndex={index}
              paneCount={paneIds.length}
              layoutStyle={
                rect
                  ? {
                      // Inset each card so splits read as floating windows
                      // with a black void between them (matches multi-agent cards).
                      top: `calc(${rect.top}% + (var(--pane-gap) / 2))`,
                      left: `calc(${rect.left}% + (var(--pane-gap) / 2))`,
                      width: `calc(${rect.width}% - var(--pane-gap))`,
                      height: `calc(${rect.height}% - var(--pane-gap))`,
                    }
                  : undefined
              }
              onFocus={() => focusPane(paneId)}
              onClose={() => void closePaneWithWorktreeReview(paneId)}
              searchOpen={searchPaneId === paneId}
              onCloseSearch={onCloseSearch}
            />
          );
        })}

        {zoomedPaneId === null && (
          <LayoutDividers sessionId={session.id} dividers={dividers} />
        )}
      </div>
      <TerminalStatusBar sessionId={session.id} />
    </section>
  );
});
