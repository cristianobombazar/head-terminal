import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";

import { formatSessionStatusLine } from "../../core/activity-duration";
import {
  getClaudeAccountProfile,
  loadClaudeAccountProfiles,
} from "../../core/claude-accounts";
import {
  getSessionActivity,
  getSessionActivitySince,
  getSessionShownAgent,
} from "../../core/activity-utils";
import { flipAnimate } from "../../core/flip-animate";
import { restorePaneWithMotion } from "../../core/pane-minimize";
import { samePath } from "../../core/path-utils";
import {
  claudeAccountFilterOptions,
  filterSessionsByClaudeAccount,
} from "../../core/session-filter";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { formatShortcut } from "../../core/shortcuts";
import { msg } from "../../i18n";
import { useLocale } from "../../i18n/react";
import {
  closeSessionWithWorktreeReview,
  isolateSessionInWorktree,
} from "../../core/worktree";
import { duplicateSessionIsolated } from "../../actions/duplicateSession";
import {
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from "../../core/ui-preferences";
import {
  ACTIVITY_LABEL,
  NEEDS_ATTENTION,
  type PaneActivity,
} from "../../types/activity";
import type { AgentSession } from "../../types/session";
import {
  IconActivity,
  IconAgentClaude,
  IconAgentCodex,
  IconAgentOllama,
  IconAgentOrnith,
  IconAgentQwen,
  IconAgentCursor,
  IconAgentShell,
  IconClose,
  IconPencil,
  IconPlus,
  IconSidebarCollapse,
  IconSidebarExpand,
} from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { SessionContextMenu } from "./SessionContextMenu";
import { SystemResourceMeter } from "./SystemResourceMeter";

interface SessionSidebarProps {
  sessions: AgentSession[];
  onCreateSession: () => void;
  renameSessionId: string | null;
  onRenameComplete: () => void;
  onRenameRequest: (sessionId: string) => void;
}

const AGENT_ICON: Record<string, ComponentType<{ size?: number }>> = {
  antigravity: IconActivity,
  cursor: IconAgentCursor,
  claude: IconAgentClaude,
  codex: IconAgentCodex,
  ollama: IconAgentOllama,
  ornith: IconAgentOrnith,
  qwen27: IconAgentQwen,
  shell: IconAgentShell,
};

function AgentIcon({
  agentProfileId,
  size,
}: {
  agentProfileId: string;
  size?: number;
}) {
  const Icon = AGENT_ICON[agentProfileId] ?? IconAgentShell;
  return <Icon size={size} />;
}

const ATTENTION_ACTIVITIES: ReadonlySet<PaneActivity> = new Set([
  "working",
  "waiting_input",
  "error",
  "agent_fallback",
]);

function SessionStatusLine({
  activity,
  activitySince,
}: {
  activity: PaneActivity;
  activitySince: number | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activitySince || !ATTENTION_ACTIVITIES.has(activity)) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity, activitySince]);

  return <span>{formatSessionStatusLine(activity, activitySince, now)}</span>;
}

function filterChipClass(active: boolean): string {
  return active
    ? "session-sidebar__filter-chip session-sidebar__filter-chip--active"
    : "session-sidebar__filter-chip";
}

function paneDotsKey(
  paneIds: string[],
  paneRuntime: Record<string, { activity?: PaneActivity } | undefined>,
): string {
  return paneIds
    .map((paneId) => paneRuntime[paneId]?.activity ?? "starting")
    .join("|");
}

interface SessionListItemProps {
  session: AgentSession;
  claudeAccountName?: string;
  sessionIndex: number;
  isActive: boolean;
  collapsed: boolean;
  forceRename: boolean;
  onSelect: () => void;
  onSelectPane: (paneId: string) => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onRenameComplete: () => void;
  onContextMenu: (event: React.MouseEvent, session: AgentSession) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  claudeAccountName,
  sessionIndex,
  isActive,
  collapsed,
  forceRename,
  onSelect,
  onSelectPane,
  onRename,
  onRemove,
  onRenameComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: SessionListItemProps) {
  useLocale();
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneIds = collectPaneIds(session.layout);
  const activity = useSessionStore((state) =>
    getSessionActivity(session, state.paneRuntime),
  );
  const activitySince = useSessionStore((state) =>
    getSessionActivitySince(session, state.paneRuntime),
  );
  const dotsKey = useSessionStore((state) =>
    paneDotsKey(paneIds, state.paneRuntime),
  );
  const paneActivities = dotsKey.split("|") as PaneActivity[];
  const minimizedKey = useSessionStore((state) =>
    paneIds.map((paneId) => (state.minimizedPanes[paneId] ? "1" : "0")).join(""),
  );
  const shownAgent = useSessionStore((state) =>
    getSessionShownAgent(session, state.paneRuntime),
  );
  // `claude` typed in a shell runs on the terminal's own ~/.claude, not on
  // one of the app's profiles: the chip says which one it really is.
  const claudeInShell = shownAgent !== session.agentProfileId;
  const accountLabel = claudeInShell ? "~/.claude" : claudeAccountName;

  useEffect(() => {
    if (forceRename) {
      setIsEditing(true);
    }
  }, [forceRename]);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(session.title);
    }
  }, [isEditing, session.title]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    if (nextTitle && nextTitle !== session.title) {
      onRename(nextTitle);
    } else {
      setDraftTitle(session.title);
    }
    setIsEditing(false);
    onRenameComplete();
  };

  if (collapsed) {
    const ringClass = ATTENTION_ACTIVITIES.has(activity)
      ? ` session-sidebar__compact-item--ring-${activity}`
      : "";
    return (
      <li
        data-session-id={session.id}
        draggable
        onDragStart={() => onDragStart(sessionIndex)}
        onDragOver={(event) => onDragOver(event, sessionIndex)}
        onDragEnd={onDragEnd}
        onDrop={() => onDrop(sessionIndex)}
      >
        <button
          type="button"
          className={
            (isActive
              ? "session-sidebar__compact-item session-sidebar__compact-item--active"
              : "session-sidebar__compact-item") + ringClass
          }
          title={`${session.title}${accountLabel ? ` — ${accountLabel}` : ""} — ${ACTIVITY_LABEL[activity]}`}
          aria-label={session.title}
          onClick={onSelect}
          onContextMenu={(event) => onContextMenu(event, session)}
        >
          <AgentIcon agentProfileId={shownAgent} size={16} />
        </button>
      </li>
    );
  }

  return (
    <li
      data-session-id={session.id}
      draggable
      onDragStart={() => onDragStart(sessionIndex)}
      onDragOver={(event) => onDragOver(event, sessionIndex)}
      onDragEnd={onDragEnd}
      onDrop={() => onDrop(sessionIndex)}
    >
      <div
        className={
          (isActive
            ? "session-sidebar__item session-sidebar__item--active"
            : "session-sidebar__item") +
          ""
        }
        onContextMenu={(event) => onContextMenu(event, session)}
      >
        <div
          role="button"
          tabIndex={0}
          className="session-sidebar__select"
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
        >
          <div className="session-sidebar__title-row">
            <StatusDot activity={activity} />
            {session.pinned && (
              <span className="session-sidebar__pin" title={msg.sidebar.pinned}>
                📌
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                className="session-sidebar__rename-input"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraftTitle(session.title);
                    setIsEditing(false);
                    onRenameComplete();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className="session-sidebar__title"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsEditing(true);
                }}
              >
                {session.title}
              </span>
            )}
            <span
              className="session-sidebar__agent-chip"
              title={claudeInShell ? msg.sidebar.claudeInShell : session.agentProfileId}
            >
              <AgentIcon agentProfileId={shownAgent} size={12} />
            </span>
            {accountLabel && (
              <span
                className="session-sidebar__account-chip"
                title={
                  claudeInShell
                    ? msg.sidebar.claudeInShellAccount
                    : msg.sidebar.claudeProfile(accountLabel)
                }
              >
                {accountLabel}
              </span>
            )}
          </div>

          <span
            className={
              NEEDS_ATTENTION.has(activity) || activity === "working"
                ? `session-sidebar__status session-sidebar__status--${activity}`
                : "session-sidebar__status"
            }
          >
            <span className="session-sidebar__pane-dots" aria-hidden>
              {paneActivities.map((paneActivity, index) => {
                const minimized = minimizedKey[index] === "1";
                return (
                  <button
                    key={paneIds[index]}
                    type="button"
                    className={
                      `session-sidebar__pane-dot session-sidebar__pane-dot--${paneActivity}` +
                      (minimized ? " session-sidebar__pane-dot--minimized" : "")
                    }
                    title={
                      msg.sidebar.paneDot(index + 1, ACTIVITY_LABEL[paneActivity]) +
                      (minimized ? msg.sidebar.paneDotMinimized : "")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (minimized) {
                        restorePaneWithMotion(paneIds[index]);
                      } else {
                        onSelectPane(paneIds[index]);
                      }
                    }}
                  />
                );
              })}
            </span>
            <SessionStatusLine activity={activity} activitySince={activitySince} />
          </span>
        </div>

        {!isEditing && (
          <div className="session-sidebar__actions">
            <button
              type="button"
              className="session-sidebar__action session-sidebar__action--rename"
              title={msg.sidebar.rename}
              aria-label={msg.sidebar.renameAria(session.title)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsEditing(true);
              }}
            >
              <IconPencil />
            </button>
            <button
              type="button"
              className="session-sidebar__action session-sidebar__action--remove"
              title={msg.sidebar.close}
              aria-label={msg.sidebar.closeAria(session.title)}
              onClick={(event) => {
                // Um clique só: a confirmação fica no diálogo que o fechamento abre.
                event.stopPropagation();
                onRemove();
              }}
            >
              <IconClose />
            </button>
          </div>
        )}
      </div>
    </li>
  );
});

export function SessionSidebar({
  sessions,
  onCreateSession,
  renameSessionId,
  onRenameComplete,
  onRenameRequest,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const [width, setWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    session: AgentSession;
    x: number;
    y: number;
  } | null>(null);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const accountOptions = claudeAccountFilterOptions(
    sessions,
    loadClaudeAccountProfiles(),
  );
  // O filtro só vale enquanto os chips estão na tela: recolhido, ou com um
  // perfil só, a lista nunca esconde sessões sem mostrar por quê.
  const showAccountFilter = !collapsed && accountOptions.length > 1;
  const activeAccountFilter =
    showAccountFilter && accountOptions.some((option) => option.id === accountFilter)
      ? accountFilter
      : null;
  const visibleSessions = filterSessionsByClaudeAccount(sessions, activeAccountFilter);
  // A ordem é sempre a do store (pin + drag manual) — sem reordenação
  // automática; quem precisa de atenção sinaliza pela cor do status, não por posição.
  const listRef = useRef<HTMLUListElement | null>(null);
  const listTops = useRef<Map<string, number>>(new Map());
  // Sem deps, isso rodava (getBoundingClientRect em cada sessão = reflow
  // síncrono) em TODO re-render do sidebar, inclusive os disparados por
  // activity/context ping — não só quando a ordem muda de fato.
  const sessionOrderKey = visibleSessions.map((session) => session.id).join(",");
  useLayoutEffect(() => {
    if (listRef.current) {
      listTops.current = flipAnimate(listRef.current, listTops.current);
    }
  }, [sessionOrderKey]);

  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const setActivePaneId = useSessionStore((state) => state.setActivePaneId);
  const renameSession = useSessionStore((state) => state.renameSession);
  const updateSessionCwd = useSessionStore((state) => state.updateSessionCwd);
  const reorderSessions = useSessionStore((state) => state.reorderSessions);
  const togglePinSession = useSessionStore((state) => state.togglePinSession);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      saveSidebarCollapsed(next);
      return next;
    });
  };

  const resizeTarget = (event: React.PointerEvent): number | null => {
    const start = resizeStart.current;
    return start ? clampSidebarWidth(start.width + event.clientX - start.x) : null;
  };

  const finishResize = (finalWidth: number) => {
    resizeStart.current = null;
    setResizing(false);
    setWidth(finalWidth);
    saveSidebarWidth(finalWidth);
  };

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Capturado, o arraste fica com a alça mesmo passando sobre um terminal,
    // que senão mandaria o movimento ao agent como relatório de mouse.
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width };
    setResizing(true);
  };

  const focusSessionPane = (sessionId: string, paneId: string) => {
    setActiveSessionId(sessionId);
    setActivePaneId(paneId);
  };

  const handleContextMenu = (
    event: React.MouseEvent,
    session: AgentSession,
  ) => {
    event.preventDefault();
    setContextMenu({ session, x: event.clientX, y: event.clientY });
  };

  const handleDrop = useCallback(
    (toIndex: number) => {
      if (dragFrom === null || dragFrom === toIndex) {
        return;
      }
      reorderSessions(dragFrom, toIndex);
      setDragFrom(null);
    },
    [dragFrom, reorderSessions],
  );

  const dismissContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <aside
      className={
        (collapsed
          ? "session-sidebar session-sidebar--collapsed"
          : "session-sidebar") +
        (resizing ? " session-sidebar--resizing" : "")
      }
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      aria-label={msg.sidebar.ariaLabel}
    >
      <div className="session-sidebar__header">
        {!collapsed && (
          <span className="session-sidebar__header-title">
            {msg.sidebar.title}
            {/* Quantas sessões há — as que estão executando já aparecem na
                barra do topo. Com filtro, quantas dele sobraram na lista. */}
            {sessions.length > 0 && (
              <span
                className="session-sidebar__count-badge"
                title={
                  visibleSessions.length === sessions.length
                    ? msg.sidebar.count(sessions.length)
                    : msg.sidebar.countFiltered(visibleSessions.length, sessions.length)
                }
              >
                {visibleSessions.length === sessions.length
                  ? sessions.length
                  : `${visibleSessions.length}/${sessions.length}`}
              </span>
            )}
          </span>
        )}

        <div className="session-sidebar__header-actions">
          {!collapsed && (
            <button
              type="button"
              className="session-sidebar__new"
              title={msg.sidebar.newSessionHint(formatShortcut("Ctrl+Shift+N"))}
              onClick={onCreateSession}
            >
              <IconPlus size={12} />
              <span>{msg.sidebar.newSession}</span>
            </button>
          )}

          <button
            type="button"
            className="session-sidebar__toggle"
            title={collapsed ? msg.sidebar.expand : msg.sidebar.collapse}
            aria-label={collapsed ? msg.sidebar.expand : msg.sidebar.collapse}
            onClick={toggleCollapsed}
          >
            {collapsed ? <IconSidebarExpand /> : <IconSidebarCollapse />}
          </button>
        </div>
      </div>

      {showAccountFilter && (
        <div
          className="session-sidebar__filter"
          role="group"
          aria-label={msg.sidebar.profileFilterAria}
        >
          <button
            type="button"
            className={filterChipClass(activeAccountFilter === null)}
            aria-pressed={activeAccountFilter === null}
            onClick={() => setAccountFilter(null)}
          >
            {msg.sidebar.profileFilterAll}
          </button>
          {accountOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={filterChipClass(activeAccountFilter === option.id)}
              aria-pressed={activeAccountFilter === option.id}
              title={msg.sidebar.profileFilterOnly(option.label)}
              onClick={() =>
                setAccountFilter((current) => (current === option.id ? null : option.id))
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      <ul className="session-sidebar__list" ref={listRef}>
        {visibleSessions.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            claudeAccountName={
              session.agentProfileId === "claude"
                ? getClaudeAccountProfile(session.claudeAccountId)?.name
                : undefined
            }
            // Índice no store, não na lista filtrada: é nele que o drag reordena.
            sessionIndex={sessions.indexOf(session)}
            collapsed={collapsed}
            isActive={session.id === activeSessionId}
            forceRename={renameSessionId === session.id}
            onSelect={() => setActiveSessionId(session.id)}
            onSelectPane={(paneId) => focusSessionPane(session.id, paneId)}
            onRename={(title) => renameSession(session.id, title)}
            onRemove={() => void closeSessionWithWorktreeReview(session.id)}
            onRenameComplete={onRenameComplete}
            onContextMenu={handleContextMenu}
            onDragStart={setDragFrom}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(event, index) => {
              event.preventDefault();
              if (dragFrom !== null && dragFrom !== index) {
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={handleDrop}
          />
        ))}
      </ul>

      <div className="session-sidebar__footer">
        {collapsed && (
          <button
            type="button"
            className="session-sidebar__compact-new"
            title={msg.sidebar.newSessionHint(formatShortcut("Ctrl+Shift+N"))}
            aria-label={msg.sidebar.newSessionAria}
            onClick={onCreateSession}
          >
            <IconPlus size={16} />
          </button>
        )}
        <SystemResourceMeter collapsed={collapsed} />
      </div>

      {!collapsed && (
        <div
          className="session-sidebar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={msg.sidebar.resizeAria}
          title={msg.sidebar.resizeHint}
          onPointerDown={onResizePointerDown}
          onPointerMove={(event) => {
            const next = resizeTarget(event);
            if (next !== null) {
              setWidth(next);
            }
          }}
          onPointerUp={(event) => {
            const next = resizeTarget(event);
            if (next !== null) {
              finishResize(next);
            }
          }}
          onLostPointerCapture={() => {
            // Cancelado pelo sistema, sem pointerup: fica a última largura.
            if (resizeStart.current) {
              finishResize(width);
            }
          }}
          onDoubleClick={() => finishResize(SIDEBAR_WIDTH_DEFAULT)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          pinned={Boolean(contextMenu.session.pinned)}
          onDismiss={dismissContextMenu}
          onRename={() => {
            onRenameRequest(contextMenu.session.id);
            setContextMenu(null);
          }}
          onTogglePin={() => {
            togglePinSession(contextMenu.session.id);
            setContextMenu(null);
          }}
          onChangeFolder={() => {
            const { session } = contextMenu;
            setContextMenu(null);
            void window.headTerminal.system
              .selectDirectory(session.cwd)
              .then((selected) => {
                if (typeof selected !== "string" || !selected || samePath(selected, session.cwd)) {
                  return;
                }
                if (
                  window.confirm(msg.sidebar.changeFolderConfirm)
                ) {
                  updateSessionCwd(session.id, selected);
                }
              })
              .catch(() => undefined);
          }}
          onIsolate={
            contextMenu.session.worktree
              ? undefined
              : () => {
                  const { session } = contextMenu;
                  setContextMenu(null);
                  void isolateSessionInWorktree(session.id);
                }
          }
          onDuplicate={() => {
            const { session } = contextMenu;
            setContextMenu(null);
            // Duplicar é o caminho mais curto para dois agents na mesma pasta:
            // a original já está na árvore, então a cópia ganha a sua.
            void duplicateSessionIsolated(session);
          }}
          onClose={() => {
            void closeSessionWithWorktreeReview(contextMenu.session.id);
            setContextMenu(null);
          }}
        />
      )}
    </aside>
  );
}
