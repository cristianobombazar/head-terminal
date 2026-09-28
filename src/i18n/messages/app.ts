// Text for the app shell: window title, toolbar, command palette, session
// context menu, resource meter, boot screen, render-error screen and the
// shared confirm dialog. `ptBR` is the source; `en` must have the very same
// keys (the type enforces it). Text with a value in it is a function.
const ptBR = {
  bootFailed: "Falha ao iniciar o Head Terminal",
  sessionsLoadFailed: "Não foi possível carregar as sessões.",
  windowTitle: (status: string, base: string) => `● ${status} — ${base}`,
  closeWhileWorking: {
    title: "Fechar Head Terminal",
    message: (count: number) => `${count} agent(s) executando ou aguardando você.`,
    detail: "Fechar mesmo assim? Os processos em execução serão encerrados.",
    confirm: "Fechar",
    cancel: "Cancelar",
  },
  closeSaveFailed: {
    title: "Falha ao salvar workspace",
    message: "Não foi possível persistir o estado mais recente.",
    detail: "Deseja fechar mesmo assim?",
    confirm: "Fechar sem salvar",
    cancel: "Cancelar",
  },
  toolbar: {
    waiting: (count: number) => `${count} aguardando`,
    waitingHint: (count: number) =>
      `${count} ${count === 1 ? "terminal espera" : "terminais esperam"} sua resposta — clique para ir ao primeiro`,
    done: (count: number) => `${count} ${count === 1 ? "concluído" : "concluídos"}`,
    doneHint: (count: number) =>
      `${count} ${count === 1 ? "terminal terminou" : "terminais terminaram"} enquanto você não estava olhando — clique para ir ao primeiro`,
    working: (count: number) => `${count} executando`,
    workingHint: (count: number) =>
      `${count} ${count === 1 ? "terminal executando" : "terminais executando"}`,
    commandPaletteHint: (shortcut: string) => `Paleta de comandos (${shortcut})`,
    commandPalette: "Paleta de comandos",
    commands: "Comandos",
    settings: "Configurações",
  },
  palette: {
    ariaLabel: "Paleta de comandos",
    placeholder: "Digite um comando…",
    empty: "Nenhum comando encontrado",
  },
  sessionMenu: {
    rename: "Renomear",
    pin: "Fixar",
    unpin: "Desafixar",
    changeFolder: "Alterar pasta…",
    isolate: "Isolar em worktree…",
    duplicate: "Duplicar",
    close: "Fechar sessão",
  },
  meter: {
    cpu: "CPU",
    memory: "Memória",
    disk: (label: string) => `Disco ${label}`,
  },
  boot: {
    starting: "Iniciando sessões…",
    slow: "A inicialização está demorando…",
    retry: "Tentar novamente",
    copyDiagnostic: "Copiar diagnóstico",
    diagnosticCopied: "Diagnóstico copiado",
    exportDiagnostic: "Exportar diagnóstico",
    savedToLogs: "Salvo em logs/",
  },
  renderError: {
    title: "Head Terminal — erro de renderização",
    retry: "Tentar novamente",
    components: "Componentes:",
  },
  confirmDialog: {
    cancel: "Cancelar",
    confirm: "OK",
  },
};

const en: typeof ptBR = {
  bootFailed: "Head Terminal failed to start",
  sessionsLoadFailed: "Couldn't load the sessions.",
  windowTitle: (status, base) => `● ${status} — ${base}`,
  closeWhileWorking: {
    title: "Close Head Terminal",
    message: (count) =>
      count === 1
        ? "1 agent is running or waiting for you."
        : `${count} agents are running or waiting for you.`,
    detail: "Close anyway? Running processes will be terminated.",
    confirm: "Close",
    cancel: "Cancel",
  },
  closeSaveFailed: {
    title: "Couldn't save the workspace",
    message: "The latest state could not be saved.",
    detail: "Close anyway?",
    confirm: "Close without saving",
    cancel: "Cancel",
  },
  toolbar: {
    waiting: (count) => `${count} waiting`,
    waitingHint: (count) =>
      count === 1
        ? "1 terminal is waiting for your answer — click to go to it"
        : `${count} terminals are waiting for your answer — click to go to the first`,
    done: (count) => `${count} done`,
    doneHint: (count) =>
      count === 1
        ? "1 terminal finished while you weren't looking — click to go to it"
        : `${count} terminals finished while you weren't looking — click to go to the first`,
    working: (count) => `${count} running`,
    workingHint: (count) => (count === 1 ? "1 terminal running" : `${count} terminals running`),
    commandPaletteHint: (shortcut) => `Command palette (${shortcut})`,
    commandPalette: "Command palette",
    commands: "Commands",
    settings: "Settings",
  },
  palette: {
    ariaLabel: "Command palette",
    placeholder: "Type a command…",
    empty: "No commands found",
  },
  sessionMenu: {
    rename: "Rename",
    pin: "Pin",
    unpin: "Unpin",
    changeFolder: "Change folder…",
    isolate: "Isolate in worktree…",
    duplicate: "Duplicate",
    close: "Close session",
  },
  meter: {
    cpu: "CPU",
    memory: "Memory",
    disk: (label) => `Disk ${label}`,
  },
  boot: {
    starting: "Starting sessions…",
    slow: "Startup is taking a while…",
    retry: "Try again",
    copyDiagnostic: "Copy diagnostics",
    diagnosticCopied: "Diagnostics copied",
    exportDiagnostic: "Export diagnostics",
    savedToLogs: "Saved to logs/",
  },
  renderError: {
    title: "Head Terminal — rendering error",
    retry: "Try again",
    components: "Components:",
  },
  confirmDialog: {
    cancel: "Cancel",
    confirm: "OK",
  },
};

export const app = { "pt-BR": ptBR, en };
