// Text for the new-session dialog. `ptBR` is the source; `en` must have the
// very same keys (the type enforces it). Text with a value in it is a function.
const ptBR = {
  title: "Nova sessão",
  subtitle: "Escolha onde e com qual agent você quer trabalhar.",
  closeAria: "Fechar",
  directory: "Diretório",
  directoryPlaceholder: "C:\\Users\\projeto",
  browse: "Procurar…",
  directoryUnreachable: "Não foi possível acessar o diretório",
  directoryNotFound: "Diretório não encontrado",
  worktreeFailed: (error: string) => `Falha ao criar worktree: ${error}`,
  worktree: "Worktree isolado",
  worktreeRecommended: "Worktree isolado (recomendado)",
  worktreeBusy: (occupants: number) =>
    `Esta árvore já está aberta em ${occupants} terminal(is) — dois agents nela brigam pelo mesmo git. Cria uma branch agent-N em pasta irmã, com os arquivos ignorados (.env e afins) copiados.`,
  worktreeFree:
    "Ninguém mais está nesta árvore, então a sessão abre o repositório direto. Marque para trabalhar numa branch agent-N à parte mesmo assim.",
  agent: "Agent",
  installing: "Instalando…",
  notInstalled: "Não instalado",
  installingMissing: "Instalando CLIs que faltam…",
  notInstalledList: (agents: string) => `Não instalado: ${agents}`,
  installNow: "Instalar agora",
  localModel: "Modelo local",
  otherModel: "Outro modelo",
  thinkingOff: "Thinking desligado",
  thinkingOffHint:
    "Inicia com --think=false para o modelo responder em vez de raciocinar até estourar o contexto.",
  modelRemembered: "O modelo fica lembrado para a próxima sessão.",
  noModels:
    "Nenhum modelo listado — confira se o serviço do ollama está no ar ou digite o nome.",
  ggufModel: "Modelo nesta máquina",
  ggufFile: "Arquivo GGUF",
  ggufDownloadHint: (file: string, repo?: string) =>
    `O GGUF não vai no git — só o caminho nesta máquina. Arquivo típico: ${file}${repo ? ` (${repo})` : ""}.`,
  ornithHardware:
    "MoE: experts na RAM (--cpu-moe), contexto 16k. O tweet (--n-cpu-moe 24, 170k) estoura VRAM nesta placa. Não copie estes flags para outra GPU.",
  qwenHardware:
    "27B denso: a placa já está cheia (~6,3 GB). ~4 tok/s com metade das camadas na CPU. Thinking off, mlock. Não use este fit em outra quantidade de VRAM.",
  whereToOpen: "Onde abrir",
  searchingWsl: "Procurando distribuições WSL…",
  choiceRemembered: "A escolha fica lembrada para a próxima sessão.",
  noWsl: "Nenhuma distribuição WSL encontrada — só PowerShell.",
  claudeProfile: "Perfil Claude",
  claudeDefaultProfile: "Perfil inicial (isolado)",
  claudeIsolatedProfile: "Ambiente isolado",
  profileRemembered: "O perfil fica lembrado para a próxima sessão.",
  cancel: "Cancelar",
  creating: "Criando…",
  create: "Criar sessão",
};

const en: typeof ptBR = {
  title: "New session",
  subtitle: "Choose where and with which agent you want to work.",
  closeAria: "Close",
  directory: "Directory",
  directoryPlaceholder: "C:\\Users\\project",
  browse: "Browse…",
  directoryUnreachable: "Couldn't access the directory",
  directoryNotFound: "Directory not found",
  worktreeFailed: (error) => `Failed to create the worktree: ${error}`,
  worktree: "Isolated worktree",
  worktreeRecommended: "Isolated worktree (recommended)",
  worktreeBusy: (occupants) =>
    `This tree is already open in ${occupants === 1 ? "1 terminal" : `${occupants} terminals`} — two agents in it fight over the same git. Creates an agent-N branch in a sibling folder, with the ignored files (.env and the like) copied over.`,
  worktreeFree:
    "Nobody else is in this tree, so the session opens the repository directly. Check it to work on a separate agent-N branch anyway.",
  agent: "Agent",
  installing: "Installing…",
  notInstalled: "Not installed",
  installingMissing: "Installing missing CLIs…",
  notInstalledList: (agents) => `Not installed: ${agents}`,
  installNow: "Install now",
  localModel: "Local model",
  otherModel: "Other model",
  thinkingOff: "Thinking off",
  thinkingOffHint:
    "Starts with --think=false so the model answers instead of reasoning until it runs out of context.",
  modelRemembered: "The model is remembered for the next session.",
  noModels: "No models listed — check that the ollama service is up, or type the name.",
  ggufModel: "Model on this machine",
  ggufFile: "GGUF file",
  ggufDownloadHint: (file, repo) =>
    `The GGUF doesn't go into git — only its path on this machine. Typical file: ${file}${repo ? ` (${repo})` : ""}.`,
  ornithHardware:
    "MoE: experts in RAM (--cpu-moe), 16k context. The tweet's setup (--n-cpu-moe 24, 170k) overflows VRAM on this card. Don't copy these flags to another GPU.",
  qwenHardware:
    "Dense 27B: the card is already full (~6.3 GB). ~4 tok/s with half the layers on the CPU. Thinking off, mlock. Don't use this fit with a different amount of VRAM.",
  whereToOpen: "Where to open",
  searchingWsl: "Looking for WSL distributions…",
  choiceRemembered: "The choice is remembered for the next session.",
  noWsl: "No WSL distribution found — PowerShell only.",
  claudeProfile: "Claude profile",
  claudeDefaultProfile: "Starting profile (isolated)",
  claudeIsolatedProfile: "Isolated environment",
  profileRemembered: "The profile is remembered for the next session.",
  cancel: "Cancel",
  creating: "Creating…",
  create: "Create session",
};

export const createSession = { "pt-BR": ptBR, en };
