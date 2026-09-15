import { copyFile, mkdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  executeGit,
  parseStatusShort,
  pathExists,
  tryGit,
  validateCwd,
} from "./git-service";

// Vários agents no mesmo repositório brigam pelo mesmo working tree: index.lock,
// status misturado, commit de um entrando no outro. A saída é dar a cada
// sessão/terminal a sua própria árvore — `git worktree` — com branch, index e
// push independentes, apontando para o mesmo `.git` comum.

/** Onde um diretório está dentro de um repositório, árvore ligada inclusive. */
export interface RepoIdentity {
  /** Raiz da árvore em que o `cwd` está — o próprio worktree, se for um. */
  worktreeRoot: string;
  /** Raiz do repositório principal: o dono do `.git` compartilhado. */
  mainRepoRoot: string;
  isLinkedWorktree: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  mainRepoRoot: string;
  /** Arquivos ignorados pelo git (`.env` e afins) levados do repo principal. */
  copiedFiles: number;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  locked: boolean;
}

export interface WorktreeStatus {
  exists: boolean;
  path: string;
  branch: string | null;
  isDirty: boolean;
  /** Commits só desta branch: nem em outra branch local, nem num remote. */
  unpushedCommits: number;
  /** Nada a perder: árvore limpa e sem commit exclusivo. */
  safeToRemove: boolean;
}

export interface WorktreePlan {
  isRepo: boolean;
  mainRepoRoot: string | null;
  worktreeRoot: string | null;
  isLinkedWorktree: boolean;
  /** Quantas sessões/terminais já estão neste mesmo repositório. */
  occupants: number;
  /** Só quando o repo já está ocupado: a primeira sessão abre a árvore real. */
  recommended: boolean;
}

const MAX_WORKTREES = 100;
/** Uma criação por repositório de cada vez: entre escolher o `agent-N` livre e
 * rodar o `worktree add` há `await`s, e duas criações simultâneas escolheriam
 * o mesmo número — a segunda morreria no add. */
const creationQueue = new Map<string, Promise<unknown>>();

function enqueueCreation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = creationQueue.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // A fila só guarda a vez; o erro pertence a quem chamou, não ao próximo.
  creationQueue.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Cada arquivo ignorado copiado, e o total, param aqui: a ideia é levar
 * `.env` e `settings.local.json`, não um dump ou um binário esquecido. */
const MAX_COPIED_FILE_BYTES = 256 * 1024;
const MAX_COPIED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_COPIED_FILES = 200;
/** Teto para o plano não varrer uma lista enorme de terminais abertos. */
const MAX_PLAN_PROBES = 64;

/** Windows compara caminho sem ligar para caixa; o resto do mundo liga. */
export function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Caminhos aqui são sempre os que o git imprime: absolutos e com barra. */
function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? path : path.slice(0, index);
}

/** A raiz da árvore em que este diretório está — só isso, uma chamada de git.
 * É o que a contagem de ocupantes precisa, e é a parte cara de multiplicar. */
export async function resolveWorktreeRoot(cwd: string): Promise<string | null> {
  const result = await tryGit([
    "-C",
    validateCwd(cwd),
    "rev-parse",
    "--show-toplevel",
  ]);
  return result?.stdout || null;
}

export async function resolveRepoIdentity(
  cwd: string,
): Promise<RepoIdentity | null> {
  const result = await tryGit([
    "-C",
    validateCwd(cwd),
    "rev-parse",
    // Absoluto nos três: `--git-dir` e `--git-common-dir` saem relativos quando
    // o cwd já é a raiz, e aí não dá para comparar um com o outro.
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (!result) {
    return null;
  }

  const [worktreeRoot, gitDir, commonDir] = result.stdout.split(/\r?\n/u);
  if (!worktreeRoot || !gitDir || !commonDir) {
    return null;
  }

  // A pergunta canônica: numa árvore ligada o git dir é `<comum>/worktrees/<n>`,
  // e na principal ele é o próprio comum. Vale em submódulo e em
  // `--separate-git-dir`, onde o comum é `<super>/.git/modules/<nome>` e
  // comparar caminho com o working tree daria a resposta errada.
  const isLinkedWorktree = !samePath(gitDir, commonDir);

  // A árvore principal é a raiz atual quando não estamos numa ligada. Quando
  // estamos, o git a lista primeiro — mas em submódulo/`--separate-git-dir` ele
  // ele lista o próprio git dir no lugar dela, e dali sairia uma pasta criada
  // dentro do `.git`. Nesse caso a raiz atual serve de base.
  let mainRepoRoot = worktreeRoot;
  if (isLinkedWorktree) {
    const listedMain = (await listWorktrees(worktreeRoot)).find(
      (entry) => entry.isMain,
    )?.path;
    if (listedMain && !samePath(listedMain, commonDir)) {
      mainRepoRoot = listedMain;
    }
  }

  return { worktreeRoot, mainRepoRoot, isLinkedWorktree };
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const result = await tryGit([
    "-C",
    validateCwd(cwd),
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (!result) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
        // O git lista o repositório principal primeiro, sempre.
        isMain: entries.length === 0,
        locked: current.locked ?? false,
      });
    }
    current = null;
  };

  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }
  flush();

  return entries;
}

/** Leva para a árvore nova os arquivos que o git ignora e o projeto precisa.
 *
 * `git worktree add` entrega só o que está versionado, então o agent cairia
 * numa cópia sem `.env`, sem `settings.local.json`, sem credencial nenhuma — e
 * não roda nada. `ls-files --directory` colapsa diretório ignorado inteiro
 * (`node_modules/`, `dist/`) numa entrada só, descartada aqui: o que sobra são
 * exatamente os arquivos soltos de configuração. */
async function copyIgnoredConfigFiles(
  sourceRoot: string,
  targetRoot: string,
): Promise<number> {
  // `-z` não é detalhe: sem ele o git entrega nome não-ASCII entre aspas e com
  // escape octal (`".claude/configuração.json"` vira `"...configura\303\247..."`),
  // o `stat` desse literal falha, o `catch` engole e o arquivo não seria
  // copiado — com a contagem mentindo que foi.
  const result = await tryGit([
    "-C",
    sourceRoot,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (!result?.stdout) {
    return 0;
  }

  let copied = 0;
  let totalBytes = 0;

  for (const relative of result.stdout.split("\0")) {
    if (!relative || relative.endsWith("/")) {
      continue;
    }
    if (copied >= MAX_COPIED_FILES || totalBytes >= MAX_COPIED_TOTAL_BYTES) {
      break;
    }

    const from = `${sourceRoot}/${relative}`;
    const to = `${targetRoot}/${relative}`;
    try {
      const info = await stat(from);
      if (!info.isFile() || info.size > MAX_COPIED_FILE_BYTES) {
        continue;
      }
      await mkdir(parentPath(to), { recursive: true });
      // COPYFILE_EXCL: nada que a árvore nova já tenha é sobrescrito.
      await copyFile(from, to, fsConstants.COPYFILE_EXCL);
      copied += 1;
      totalBytes += info.size;
    } catch {
      // Sumiu, sem permissão ou já existe no destino: o worktree continua
      // valendo, e a UI mostra quantos arquivos foram de fato.
    }
  }

  return copied;
}

/** Cria o worktree irmão `<repo>-agent-N` na branch `agent-N`. */
export async function createSessionWorktree(
  cwd: string,
  options: { copyIgnored?: boolean } = {},
): Promise<WorktreeInfo> {
  const identity = await resolveRepoIdentity(cwd);
  if (!identity) {
    throw new Error("O diretório não é um repositório git");
  }

  // Sempre a partir do repositório principal: um worktree criado de dentro de
  // outro worktree ficaria com nome `<repo>-agent-1-agent-2`.
  const { mainRepoRoot } = identity;

  return enqueueCreation(mainRepoRoot, async () => {
    for (let n = 1; n < MAX_WORKTREES; n += 1) {
      const branch = `agent-${n}`;
      const path = `${mainRepoRoot}-${branch}`;
      const branchExists = await tryGit([
        "-C",
        mainRepoRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);

      if ((await pathExists(path)) || branchExists !== null) {
        continue;
      }

      await executeGit([
        "-C",
        mainRepoRoot,
        "worktree",
        "add",
        path,
        "-b",
        branch,
      ]);

      const copiedFiles =
        options.copyIgnored === false
          ? 0
          : await copyIgnoredConfigFiles(mainRepoRoot, path);

      return { path, branch, mainRepoRoot, copiedFiles };
    }

    throw new Error("Limite de worktrees atingido");
  });
}

export async function getWorktreeStatus(path: string): Promise<WorktreeStatus> {
  const validated = validateCwd(path);
  if (!(await pathExists(validated))) {
    return {
      exists: false,
      path: validated,
      branch: null,
      isDirty: false,
      unpushedCommits: 0,
      safeToRemove: true,
    };
  }

  const statusResult = await tryGit([
    "-C",
    validated,
    "status",
    "--porcelain=v1",
    "-b",
  ]);
  const { branch, isDirty } = parseStatusShort(statusResult?.stdout ?? "");

  // Commits fora de qualquer remote e de qualquer outra branch local: é o que
  // se perderia de verdade ao apagar a árvore junto com a branch. `--exclude`
  // vale para o `--branches` seguinte, então a ordem dos argumentos importa.
  const revListArgs = [
    "-C",
    validated,
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--remotes",
  ];
  if (branch) {
    revListArgs.push(`--exclude=${branch}`);
  }
  revListArgs.push("--branches");

  const unpushedResult = await tryGit(revListArgs);
  const unpushedCommits = Number.parseInt(unpushedResult?.stdout ?? "", 10) || 0;

  return {
    exists: true,
    path: validated,
    branch,
    isDirty,
    unpushedCommits,
    safeToRemove: !isDirty && unpushedCommits === 0,
  };
}

/** Desfaz o worktree e, por padrão, a branch que veio junto com ele. */
export async function removeSessionWorktree(input: {
  path: string;
  /** A branch que o app criou. Ela só é apagada se o worktree ainda
   * estiver nela: trocar de branch lá dentro passa a ser trabalho do usuário, e
   * apagar o que ele criou seria estrago. */
  branch?: string;
  force?: boolean;
  deleteBranch?: boolean;
}): Promise<void> {
  const path = validateCwd(input.path);
  const identity = await resolveRepoIdentity(path);
  if (!identity) {
    throw new Error("O diretório não é um worktree git");
  }
  if (!identity.isLinkedWorktree) {
    throw new Error("Este diretório é o repositório principal, não um worktree");
  }

  const { mainRepoRoot } = identity;
  const status = await getWorktreeStatus(path);

  await executeGit([
    "-C",
    mainRepoRoot,
    "worktree",
    "remove",
    ...(input.force ? ["--force"] : []),
    path,
  ]);

  const branchMatches =
    input.branch === undefined || input.branch === status.branch;
  if (input.deleteBranch !== false && status.branch && branchMatches) {
    // `-D` porque a branch do agent quase nunca foi mesclada; quem chegou aqui
    // já passou pelo aviso de trabalho não publicado.
    await tryGit(["-C", mainRepoRoot, "branch", "-D", status.branch]);
  }

  await tryGit(["-C", mainRepoRoot, "worktree", "prune"]);
}

/** Decide se uma sessão nova neste diretório deve abrir em worktree próprio:
 * só quando o repositório já está ocupado por outra sessão ou terminal. */
export async function planSessionWorktree(input: {
  cwd: string;
  occupiedCwds?: readonly string[];
}): Promise<WorktreePlan> {
  const identity = await resolveRepoIdentity(input.cwd);
  if (!identity) {
    return {
      isRepo: false,
      mainRepoRoot: null,
      worktreeRoot: null,
      isLinkedWorktree: false,
      occupants: 0,
      recommended: false,
    };
  }

  // Um `git` por pasta distinta, mas a contagem é por terminal: a mesma pasta
  // aberta em três lugares são três agents brigando, não um.
  const candidates = (input.occupiedCwds ?? []).slice(0, MAX_PLAN_PROBES);
  const distinct = [...new Set(candidates)];
  const rootByCwd = new Map<string, string | null>();
  await Promise.all(
    distinct.map(async (candidate) => {
      const other = await resolveRepoIdentity(candidate).catch(() => null);
      rootByCwd.set(candidate, other?.worktreeRoot ?? null);
    }),
  );

  // A árvore é que conta, não o repositório: duas sessões em worktrees
  // diferentes do mesmo `.git` não se atrapalham — o problema é duas na mesma
  // árvore. Um subdiretório do repo resolve para a mesma raiz e também conta.
  const occupants = candidates.filter((candidate) => {
    const root = rootByCwd.get(candidate);
    return root !== null && root !== undefined && samePath(root, identity.worktreeRoot);
  }).length;

  return {
    isRepo: true,
    mainRepoRoot: identity.mainRepoRoot,
    worktreeRoot: identity.worktreeRoot,
    isLinkedWorktree: identity.isLinkedWorktree,
    occupants,
    recommended: occupants > 0,
  };
}
