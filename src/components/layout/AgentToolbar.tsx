import { COMMAND_PALETTE_SHORTCUT } from "../../config/toolbar";
import { countWorkingSessions } from "../../core/activity-utils";
import { useSessionStore } from "../../core/session-manager";
import { msg } from "../../i18n";
import { IconCommand, IconSettings } from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";

interface AgentToolbarProps {
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

export function AgentToolbar({
  onOpenCommandPalette,
  onOpenSettings,
}: AgentToolbarProps) {
  // Narrow selector: a primitive, so activity ticks elsewhere in the store
  // don't re-render the toolbar.
  const workingCount = useSessionStore((state) =>
    countWorkingSessions(state.sessions, state.paneRuntime),
  );

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {workingCount > 0 && (
          <span className="agent-toolbar__global-status">
            <StatusDot activity="working" />
            <span>{msg.app.toolbar.working(workingCount)}</span>
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
