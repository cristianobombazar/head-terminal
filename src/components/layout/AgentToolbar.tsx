import { COMMAND_PALETTE_SHORTCUT } from "../../config/toolbar";
import { revealPane } from "../../core/pane-minimize";
import type { PaneStatusTone } from "../../core/activity-display";
import { msg } from "../../i18n";
import { IconCommand, IconSettings } from "../ui/Icons";
import {
  findFirstPaneInTone,
  StatusDot,
  useTerminalStatusCounts,
} from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";

interface AgentToolbarProps {
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

/** Brings the first terminal in that state to the front — the way to answer
 * "who is waiting for me?" with ten terminals over five sessions. Out of the
 * dock or from behind a zoomed sibling too, keyboard included. */
function jumpToFirstPane(tone: PaneStatusTone): void {
  const target = findFirstPaneInTone(tone);
  if (target) {
    revealPane(target.paneId);
  }
}

export function AgentToolbar({
  onOpenCommandPalette,
  onOpenSettings,
}: AgentToolbarProps) {
  // Counts come as one string from the store, so activity ticks elsewhere
  // don't re-render the toolbar.
  const counts = useTerminalStatusCounts();

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {counts.waiting > 0 && (
          <button
            type="button"
            className="agent-toolbar__global-status status-count status-count--waiting"
            title={msg.app.toolbar.waitingHint(counts.waiting)}
            onClick={() => jumpToFirstPane("waiting")}
          >
            <StatusDot tone="waiting" title={null} />
            <span>{msg.app.toolbar.waiting(counts.waiting)}</span>
          </button>
        )}
        {counts.done > 0 && (
          <button
            type="button"
            className="agent-toolbar__global-status status-count status-count--done"
            title={msg.app.toolbar.doneHint(counts.done)}
            onClick={() => jumpToFirstPane("done")}
          >
            <StatusDot tone="done" title={null} />
            <span>{msg.app.toolbar.done(counts.done)}</span>
          </button>
        )}
        {counts.working > 0 && (
          <span
            className="agent-toolbar__global-status status-count status-count--working"
            title={msg.app.toolbar.workingHint(counts.working)}
          >
            <StatusDot tone="working" title={null} />
            <span>{msg.app.toolbar.working(counts.working)}</span>
          </span>
        )}
      </div>

      <div className="agent-toolbar__actions">
        <Tooltip content={msg.app.toolbar.commandPaletteHint(COMMAND_PALETTE_SHORTCUT)} below>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            aria-label={msg.app.toolbar.commandPalette}
            onClick={onOpenCommandPalette}
          >
            <IconCommand />
            <span className="agent-toolbar__label">{msg.app.toolbar.commands}</span>
          </button>
        </Tooltip>

        <Tooltip content={msg.app.toolbar.settings} below>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            aria-label={msg.app.toolbar.settings}
            onClick={onOpenSettings}
          >
            <IconSettings />
            <span className="agent-toolbar__label">{msg.app.toolbar.settings}</span>
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
