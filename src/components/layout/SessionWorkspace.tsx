import { memo, useEffect, useMemo, useRef } from "react";

import {
  collectPaneIds,
  collectPaneRects,
  collectVisiblePaneRects,
  collectVisibleSplitDividers,
  resolvePaneCwd,
} from "../../core/session-layout";
import { debounce } from "../../core/debounce";
import { fitPanes } from "../../core/pane-fit-registry";
import { useSessionStore } from "../../core/session-manager";
import { closePaneWithWorktreeReview } from "../../core/worktree";
import type { AgentSession } from "../../types/session";
import { MinimizedPaneDock } from "../terminal/MinimizedPaneDock";
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
  const paneIds = useMemo(
    () => collectPaneIds(session.layout),
    [session.layout],
  );
  const paneIndexById = useMemo(
    () => new Map(paneIds.map((paneId, index) => [paneId, index])),
    [paneIds],
  );

  // A string, so a card's own ticks (finishedAt, activity) don't re-render
  // the whole workspace — only a pane entering or leaving the dock does.
  const minimizedKey = useSessionStore((state) =>
    paneIds.filter((paneId) => state.minimizedPanes[paneId]).join("|"),
  );
  const minimizedPaneIds = useMemo(
    () => (minimizedKey ? minimizedKey.split("|") : []),
    [minimizedKey],
  );
  const minimizedSet = useMemo(
    () => new Set(minimizedPaneIds),
    [minimizedPaneIds],
  );
  const onScreenPaneIds = useMemo(
    () => paneIds.filter((paneId) => !minimizedSet.has(paneId)),
    [paneIds, minimizedSet],
  );
  const visibleRectById = useMemo(
    () =>
      new Map(
        collectVisiblePaneRects(session.layout, minimizedSet).map((rect) => [
          rect.paneId,
          rect,
        ]),
      ),
    [session.layout, minimizedSet],
  );
  const dividers = useMemo(
    () => collectVisibleSplitDividers(session.layout, minimizedSet),
    [session.layout, minimizedSet],
  );

  const zoomedPaneId =
    maximizedPaneId &&
    onScreenPaneIds.includes(maximizedPaneId) &&
    onScreenPaneIds.length > 1
      ? maximizedPaneId
      : null;

  // Only terminals on the canvas are fitted. A minimized one keeps the
  // cols/rows it had, so its agent never sees a resize for leaving the
  // screen; it is fitted again when it comes back.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shouldSpawn) {
      return;
    }

    const debouncedFit = debounce(() => fitPanes(onScreenPaneIds), 120);
    const resizeObserver = new ResizeObserver(() => {
      debouncedFit();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      debouncedFit.cancel();
    };
  }, [onScreenPaneIds, shouldSpawn]);

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
    const timer = window.setTimeout(() => fitPanes(onScreenPaneIds), 120);
    return () => window.clearTimeout(timer);
  }, [session.layout, onScreenPaneIds, shouldSpawn, zoomedPaneId]);

  const focusPane = (paneId: string) => {
    setActiveSessionId(session.id);
    setActivePaneId(paneId);
  };

  if (!shouldSpawn) {
    return null;
  }

  const allMinimized = onScreenPaneIds.length === 0;

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
          const isMinimized = minimizedSet.has(paneId);
          const isParked =
            isMinimized || (zoomedPaneId !== null && paneId !== zoomedPaneId);
          // The zoomed pane spans the canvas; its siblings keep the rect
          // (and therefore the pty size) they had while parked off-screen.
          // A minimized pane is parked with its box from the full layout —
          // it is not fitted, so that box never reaches its pty.
          const rect =
            paneId === zoomedPaneId
              ? { paneId, top: 0, left: 0, width: 100, height: 100 }
              : isMinimized
                ? paneRectById.get(paneId)
                : visibleRectById.get(paneId);
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
              isMinimized={isMinimized}
              isMaximized={paneId === zoomedPaneId}
              paneIndex={index}
              paneCount={paneIds.length}
              onScreenPaneCount={onScreenPaneIds.length}
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

        {allMinimized && (
          <MinimizedPaneDock
            session={session}
            paneIds={minimizedPaneIds}
            paneIndexById={paneIndexById}
            variant="stage"
          />
        )}
      </div>
      {!allMinimized && minimizedPaneIds.length > 0 && (
        <MinimizedPaneDock
          session={session}
          paneIds={minimizedPaneIds}
          paneIndexById={paneIndexById}
          variant="bar"
        />
      )}
      <TerminalStatusBar sessionId={session.id} />
    </section>
  );
});
