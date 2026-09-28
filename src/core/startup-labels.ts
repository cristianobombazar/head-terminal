import { msg } from "../i18n";

const STAGE_LABELS: Record<string, string> = {
  get "js.main.begin"() {
    return msg.core.startup.loadingInterface;
  },
  get "js.react.root_created"() {
    return msg.core.startup.preparingReact;
  },
  get "js.react.render_committed"() {
    return msg.core.startup.rendering;
  },
  get "js.bootstrap.begin"() {
    return msg.core.startup.startingSessions;
  },
  get "js.bootstrap.cwd_ok"() {
    return msg.core.startup.defaultFolderLoaded;
  },
  get "js.bootstrap.workspace_ok"() {
    return msg.core.startup.sessionsRestored;
  },
  get "js.bootstrap.complete"() {
    return msg.core.startup.finishing;
  },
  get "js.app_shell.visible"() {
    return msg.core.startup.mountingShell;
  },
  get "js.session.spawn_scheduled"() {
    return msg.core.startup.preparingTerminal;
  },
  get "js.terminal.dom_opened"() {
    return msg.core.startup.openingTerminal;
  },
  get "js.terminal.fit_ok"() {
    return msg.core.startup.fittingTerminal;
  },
  get "js.pty.spawn_begin"() {
    return msg.core.startup.startingAgent;
  },
  get "js.pty.spawn_ok"() {
    return msg.core.startup.agentRunning;
  },
  get "js.pty.first_byte"() {
    return msg.core.startup.receivingOutput;
  },
  get "ui.ready"() {
    return msg.core.startup.ready;
  },
  get "watchdog.3s"() {
    return msg.core.startup.checkingStartup;
  },
};

export function humanizeCheckpoint(stage: string | null): string {
  if (!stage) {
    return msg.core.startup.starting;
  }
  return STAGE_LABELS[stage] ?? stage;
}
