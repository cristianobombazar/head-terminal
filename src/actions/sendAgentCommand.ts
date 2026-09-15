import { useSessionStore } from "../core/session-manager";
import { getTerminal } from "../core/terminal-registry";

function normalizeCommand(command: string): string {
  if (command.endsWith("\r") || command.endsWith("\n")) {
    return command.replace(/\n$/, "\r");
  }

  return `${command}\r`;
}

export function sendAgentCommand(command: string): void {
  const { ptyWriters, getTargetPaneIds } = useSessionStore.getState();
  const payload = normalizeCommand(command);
  const paneIds = getTargetPaneIds();

  for (const paneId of paneIds) {
    ptyWriters[paneId]?.(payload);
  }
}

/**
 * Dictated text is a paste, not typing. Writing it straight to the PTY hands
 * the agent a burst of hundreds of keystrokes at once, and a TUI that is busy
 * repainting drops the leading ones — long transcripts arrived cut mid-word,
 * keeping only their tail. `paste()` wraps the text in bracketed paste when
 * the agent asked for it, so it is consumed as one unit, exactly like Ctrl+V.
 */
export function sendTextToPane(paneId: string, text: string): void {
  const terminal = getTerminal(paneId)?.terminal;
  if (terminal) {
    terminal.paste(text);
    return;
  }

  const { ptyWriters } = useSessionStore.getState();
  ptyWriters[paneId]?.(text);
}
