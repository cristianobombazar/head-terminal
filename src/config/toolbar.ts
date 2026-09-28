import { msg } from "../i18n";

export const CLEAR_SHORTCUT = "Ctrl+Shift+L";
export const HARD_CLEAR_SHORTCUT = "Ctrl+Shift+Alt+L";
export const COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+P";
export const VOICE_SHORTCUT = "F9";
export const BRAINSTORM_SHORTCUT = "F10";
export const BRAINSTORM_END_SHORTCUT = "F11";

export interface ToolbarCommand {
  id: string;
  label: string;
  command: string;
  shortcut?: string;
  description?: string;
}

// Labels are getters: read when shown, so a language switch shows up in place.
export const AGENT_COMMANDS: ToolbarCommand[] = [
  {
    id: "clear",
    label: "Clear",
    command: "/clear",
    shortcut: CLEAR_SHORTCUT,
    get description() {
      return msg.core.toolbar.clearDescription;
    },
  },
  {
    id: "compact",
    label: "Compact",
    command: "/compact",
    get description() {
      return msg.core.toolbar.compactDescription;
    },
  },
  {
    id: "context",
    label: "Context",
    command: "/context",
    get description() {
      return msg.core.toolbar.contextDescription;
    },
  },
  {
    id: "help",
    label: "Help",
    command: "/help",
    get description() {
      return msg.core.toolbar.helpDescription;
    },
  },
];

export const PALETTE_ACTIONS: ToolbarCommand[] = [
  ...AGENT_COMMANDS,
  {
    id: "split-vertical",
    label: "Split vertical",
    command: "__split_vertical__",
    shortcut: "Ctrl+\\",
    get description() {
      return msg.core.toolbar.splitVerticalDescription;
    },
  },
  {
    id: "split-horizontal",
    label: "Split horizontal",
    command: "__split_horizontal__",
    shortcut: "Ctrl+Shift+\\",
    get description() {
      return msg.core.toolbar.splitHorizontalDescription;
    },
  },
  {
    id: "toggle-maximize-pane",
    get label() {
      return msg.core.toolbar.maximizePane;
    },
    command: "__toggle_maximize_pane__",
    shortcut: "Ctrl+Shift+Z",
    get description() {
      return msg.core.toolbar.maximizePaneDescription;
    },
  },
  {
    id: "toggle-minimize-pane",
    get label() {
      return msg.core.toolbar.minimizePane;
    },
    command: "__toggle_minimize_pane__",
    shortcut: "Ctrl+Shift+M",
    get description() {
      return msg.core.toolbar.minimizePaneDescription;
    },
  },
  {
    id: "close-pane",
    get label() {
      return msg.core.toolbar.closePane;
    },
    command: "__close_pane__",
    shortcut: "Ctrl+Shift+W",
    get description() {
      return msg.core.toolbar.closePaneDescription;
    },
  },
  {
    id: "export-diagnostic",
    get label() {
      return msg.core.toolbar.exportDiagnostic;
    },
    command: "__export_diagnostic__",
    get description() {
      return msg.core.toolbar.exportDiagnosticDescription;
    },
  },
  {
    id: "ghost-diagnostic",
    get label() {
      return msg.core.toolbar.ghostDiagnostic;
    },
    command: "__ghost_diagnostic__",
    get description() {
      return msg.core.toolbar.ghostDiagnosticDescription;
    },
  },
  {
    id: "rename-session",
    get label() {
      return msg.core.toolbar.renameSession;
    },
    command: "__rename_session__",
    shortcut: "F2",
    get description() {
      return msg.core.toolbar.renameSessionDescription;
    },
  },
  {
    id: "settings",
    get label() {
      return msg.core.toolbar.settings;
    },
    command: "__settings__",
    get description() {
      return msg.core.toolbar.settingsDescription;
    },
  },
  {
    id: "voice-input",
    get label() {
      return msg.core.toolbar.voiceInput;
    },
    command: "__voice_input__",
    shortcut: VOICE_SHORTCUT,
    get description() {
      return msg.core.toolbar.voiceInputDescription;
    },
  },
  {
    id: "voice-brainstorm",
    get label() {
      return msg.core.toolbar.voiceBrainstorm;
    },
    command: "__voice_brainstorm__",
    shortcut: BRAINSTORM_SHORTCUT,
    get description() {
      return msg.core.toolbar.voiceBrainstormDescription;
    },
  },
];
