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

export const AGENT_COMMANDS: ToolbarCommand[] = [
  {
    id: "clear",
    label: "Clear",
    command: "/clear",
    shortcut: CLEAR_SHORTCUT,
    description: "Limpa o contexto do agent (Shift+clique no botão reinicia o PTY)",
  },
  {
    id: "compact",
    label: "Compact",
    command: "/compact",
    description: "Compacta o contexto do agent",
  },
  {
    id: "context",
    label: "Context",
    command: "/context",
    description: "Mostra o contexto atual do agent",
  },
  {
    id: "help",
    label: "Help",
    command: "/help",
    description: "Lista comandos disponíveis",
  },
];

export const PALETTE_ACTIONS: ToolbarCommand[] = [
  ...AGENT_COMMANDS,
  {
    id: "split-vertical",
    label: "Split vertical",
    command: "__split_vertical__",
    shortcut: "Ctrl+\\",
    description: "Divide o terminal ativo verticalmente",
  },
  {
    id: "split-horizontal",
    label: "Split horizontal",
    command: "__split_horizontal__",
    shortcut: "Ctrl+Shift+\\",
    description: "Divide o terminal ativo horizontalmente",
  },
  {
    id: "toggle-maximize-pane",
    label: "Expandir terminal",
    command: "__toggle_maximize_pane__",
    shortcut: "Ctrl+Shift+Z",
    description:
      "Mostra só o terminal ativo na área da sessão, ou traz os outros de volta",
  },
  {
    id: "toggle-minimize-pane",
    label: "Minimizar terminal",
    command: "__toggle_minimize_pane__",
    shortcut: "Ctrl+Shift+M",
    description:
      "Tira o terminal ativo da tela sem parar o agent; o status dele fica num card da sessão até restaurar",
  },
  {
    id: "close-pane",
    label: "Fechar terminal",
    command: "__close_pane__",
    shortcut: "Ctrl+Shift+W",
    description: "Fecha o terminal ativo (requer mais de um terminal na sessão)",
  },
  {
    id: "export-diagnostic",
    label: "Exportar diagnóstico de inicialização",
    command: "__export_diagnostic__",
    description: "Salva logs de boot e estado da UI na pasta de logs do app (Diagnóstico mostra o caminho)",
  },
  {
    id: "ghost-diagnostic",
    label: "Diagnosticar caracteres fantasma",
    command: "__ghost_diagnostic__",
    description:
      "Lê as colunas iniciais do buffer do terminal ativo, força o redesenho do renderer e copia o relatório",
  },
  {
    id: "rename-session",
    label: "Renomear sessão",
    command: "__rename_session__",
    shortcut: "F2",
    description: "Renomeia a sessão ativa",
  },
  {
    id: "settings",
    label: "Configurações",
    command: "__settings__",
    description: "Configura a chave da API OpenAI para ditado e brainstorm por voz",
  },
  {
    id: "voice-input",
    label: "Gravar prompt por voz",
    command: "__voice_input__",
    shortcut: VOICE_SHORTCUT,
    description: "Inicia ou para a gravação de voz no terminal ativo",
  },
  {
    id: "voice-brainstorm",
    label: "Brainstorm por voz",
    command: "__voice_brainstorm__",
    shortcut: BRAINSTORM_SHORTCUT,
    description:
      "Conversa por voz sobre o terminal ativo, já por dentro da conversa que estava nele; aparece como uma bolinha no canto (clique abre o painel; F10 pausa e retoma a voz, F11 encerra). O agente do terminal analisa e executa com a permissão dele",
  },
];
