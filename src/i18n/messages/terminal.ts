// Text for terminal panes, their header, menus and the notices written into
// the terminal. `ptBR` is the source; `en` must have the very same keys (the
// type enforces it). Text with a value in it is a function.
const ptBR = {
  pane: {
    ariaLabel: "Terminal do agent",
  },
  overlay: {
    reconnecting: (seconds: number, attempt: number) =>
      `Reconectando em ${seconds}s (tentativa ${attempt}/5)`,
    now: "Agora",
    cancel: "Cancelar",
    reconnectFailed: (attempts: number) => `Reconexão falhou após ${attempts} tentativas`,
    error: "O terminal encontrou um erro",
    exited: "Processo encerrado",
    restart: "Reiniciar",
  },
  header: {
    claudeInShell: "claude, iniciado neste terminal",
    conversationPlaceholder: "Nome da conversa",
    conversationHint: (name: string) =>
      `Conversa: ${name} — clique para renomear (vazio volta ao nome automático)`,
    folderHint: (cwd: string) => `Pasta: ${cwd} — clique para trocar (reinicia só este terminal)`,
    folderAria: (cwd: string) => `Pasta do terminal: ${cwd}`,
    isolateHint:
      "Isolar em worktree: branch agent-N em pasta irmã, com os arquivos ignorados copiados. Reinicia só este terminal.",
    isolateAria: "Isolar este terminal em um worktree",
    contextHint: (percent: number) => `Contexto restante do agent: ${percent}%`,
    context: (percent: number) => `ctx ${percent}%`,
    agentFallback: "Agent caiu — shell ativo",
    restartAgentHint:
      "Agent caiu — shell ativo. Nova conversa. Segure Shift para continuar a anterior.",
    restartAgent: "Reiniciar agent",
    restoreOthersHint: (shortcut: string) => `Restaurar os outros terminais (${shortcut})`,
    maximizeHint: (shortcut: string) =>
      `Expandir: só este terminal na área da sessão (${shortcut})`,
    restoreLayoutAria: "Restaurar layout da sessão",
    maximizeAria: (pane: string) => `Expandir ${pane}`,
    splitBelowHint: (shortcut: string) => `Dividir abaixo (${shortcut})`,
    splitVerticalAria: "Dividir verticalmente",
    splitBesideHint: (shortcut: string) => `Dividir ao lado (${shortcut})`,
    splitHorizontalAria: "Dividir horizontalmente",
    restartHint: "Reiniciar pane (Shift: continuar conversa)",
    restartAria: (pane: string) => `Reiniciar ${pane}`,
    minimizeHint: (shortcut: string) =>
      `Minimizar (${shortcut}): sai da tela e o agent segue rodando; o status fica num card da sessão`,
    minimizeAria: (pane: string) => `Minimizar ${pane}`,
    closeHint: "Fechar terminal",
    closeAria: (pane: string) => `Fechar ${pane}`,
  },
  resume: {
    triggerHint: "Histórico de conversas desta pasta",
    loading: "Carregando…",
    empty: "Nenhuma sessão anterior encontrada",
    renamePlaceholder: "Nome da conversa",
    startedAt: (stamp: string) => `Iniciada em ${stamp}`,
    lastActivity: (stamp: string) => `Última atividade ${stamp}`,
    current: "Conversa atual deste terminal",
    renameHint: "Renomear conversa (vazio volta ao nome automático)",
    renameAria: (name: string) => `Renomear ${name}`,
    justNow: "agora",
    minutesAgo: (minutes: number) => `${minutes} min atrás`,
    hoursAgo: (hours: number) => `${hours} h atrás`,
    daysAgo: (days: number) => `${days} d atrás`,
  },
  search: {
    placeholder: "Buscar no terminal…",
    previous: "Anterior (Shift+Enter)",
    next: "Próximo (Enter)",
    close: "Fechar (Esc)",
  },
  statusBar: {
    ariaLabel: "Contexto git da sessão",
  },
  voice: {
    stop: (shortcut: string) => `Parar gravação e transcrever (${shortcut})`,
    record: (shortcut: string) => `Gravar prompt por voz (${shortcut})`,
  },
  dock: {
    ariaLabel: "Terminais minimizados",
    titleOne: "Terminal minimizado",
    titleMany: (count: number) => `${count} terminais minimizados`,
    // Around the shortcut, which the dock shows as a <kbd>.
    hintOneBefore: "O agent segue rodando. Clique no card ou use ",
    hintOneAfter: " para restaurar.",
    hintManyBefore: "Os agents seguem rodando. Clique num card para restaurar — ",
    hintManyAfter: " traz o último.",
    cardHint: (pane: string, name: string, status: string) =>
      `${pane} · ${name} — ${status}. Clique para restaurar.`,
    cardAria: (pane: string, status: string) => `Restaurar ${pane} (${status})`,
  },
  notices: {
    resumeFailed: "── conversa anterior não pôde ser retomada, iniciando uma nova ──",
    restarted: (attempt: number) =>
      `── sessão reiniciada (tentativa ${attempt}) ─────────────────`,
    processExited: (code: number) => `[Processo encerrado com código ${code}]`,
    spawnFailed: "Falha ao iniciar o PTY",
    error: (message: string) => `[Erro] ${message}`,
  },
};

const en: typeof ptBR = {
  pane: {
    ariaLabel: "Agent terminal",
  },
  overlay: {
    reconnecting: (seconds, attempt) => `Reconnecting in ${seconds}s (attempt ${attempt}/5)`,
    now: "Now",
    cancel: "Cancel",
    reconnectFailed: (attempts) =>
      `Reconnection failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`,
    error: "The terminal hit an error",
    exited: "Process exited",
    restart: "Restart",
  },
  header: {
    claudeInShell: "claude, started in this terminal",
    conversationPlaceholder: "Conversation name",
    conversationHint: (name) =>
      `Conversation: ${name} — click to rename (empty restores the automatic name)`,
    folderHint: (cwd) => `Folder: ${cwd} — click to change (restarts only this terminal)`,
    folderAria: (cwd) => `Terminal folder: ${cwd}`,
    isolateHint:
      "Isolate in a worktree: agent-N branch in a sibling folder, with ignored files copied. Restarts only this terminal.",
    isolateAria: "Isolate this terminal in a worktree",
    contextHint: (percent) => `Agent context left: ${percent}%`,
    context: (percent) => `ctx ${percent}%`,
    agentFallback: "Agent crashed — shell active",
    restartAgentHint:
      "Agent crashed — shell active. New conversation. Hold Shift to continue the previous one.",
    restartAgent: "Restart agent",
    restoreOthersHint: (shortcut) => `Restore the other terminals (${shortcut})`,
    maximizeHint: (shortcut) => `Expand: only this terminal in the session area (${shortcut})`,
    restoreLayoutAria: "Restore the session layout",
    maximizeAria: (pane) => `Expand ${pane}`,
    splitBelowHint: (shortcut) => `Split below (${shortcut})`,
    splitVerticalAria: "Split vertically",
    splitBesideHint: (shortcut) => `Split to the side (${shortcut})`,
    splitHorizontalAria: "Split horizontally",
    restartHint: "Restart pane (Shift: continue the conversation)",
    restartAria: (pane) => `Restart ${pane}`,
    minimizeHint: (shortcut) =>
      `Minimize (${shortcut}): leaves the screen while the agent keeps running; its status stays on a card in the session`,
    minimizeAria: (pane) => `Minimize ${pane}`,
    closeHint: "Close terminal",
    closeAria: (pane) => `Close ${pane}`,
  },
  resume: {
    triggerHint: "Conversation history for this folder",
    loading: "Loading…",
    empty: "No previous session found",
    renamePlaceholder: "Conversation name",
    startedAt: (stamp) => `Started at ${stamp}`,
    lastActivity: (stamp) => `Last activity at ${stamp}`,
    current: "This terminal's current conversation",
    renameHint: "Rename conversation (empty restores the automatic name)",
    renameAria: (name) => `Rename ${name}`,
    justNow: "now",
    minutesAgo: (minutes) => `${minutes} min ago`,
    hoursAgo: (hours) => `${hours} h ago`,
    daysAgo: (days) => `${days} d ago`,
  },
  search: {
    placeholder: "Search the terminal…",
    previous: "Previous (Shift+Enter)",
    next: "Next (Enter)",
    close: "Close (Esc)",
  },
  statusBar: {
    ariaLabel: "Session git context",
  },
  voice: {
    stop: (shortcut) => `Stop recording and transcribe (${shortcut})`,
    record: (shortcut) => `Record a voice prompt (${shortcut})`,
  },
  dock: {
    ariaLabel: "Minimized terminals",
    titleOne: "Minimized terminal",
    titleMany: (count) => `${count} minimized terminals`,
    hintOneBefore: "The agent keeps running. Click the card or use ",
    hintOneAfter: " to restore.",
    hintManyBefore: "The agents keep running. Click a card to restore — ",
    hintManyAfter: " brings back the last one.",
    cardHint: (pane, name, status) => `${pane} · ${name} — ${status}. Click to restore.`,
    cardAria: (pane, status) => `Restore ${pane} (${status})`,
  },
  notices: {
    resumeFailed: "── the previous conversation couldn't be resumed, starting a new one ──",
    restarted: (attempt) => `── session restarted (attempt ${attempt}) ─────────────────`,
    processExited: (code) => `[Process exited with code ${code}]`,
    spawnFailed: "Failed to start the PTY",
    error: (message) => `[Error] ${message}`,
  },
};

export const terminal = { "pt-BR": ptBR, en };
