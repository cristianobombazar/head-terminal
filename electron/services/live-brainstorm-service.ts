import { spawn as nodeSpawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BrainstormAgent,
  LiveHistoryMessage,
  LiveDelegationInput,
  LiveDelegationResult,
  LiveSessionAnswer,
  LiveSessionInput,
} from "../types/api";
import { readAgentConversation, type AgentConversation } from "./agent-conversation-reader";
import { resolveAgentSessionRoots } from "./agent-sessions-service";
import { runCommand } from "./command-runner";
import { killWindowsProcessTree } from "./windows-shell";

/**
 * Voice brainstorm. GPT-Live holds the spoken conversation and hands code
 * questions back to the app ("client delegation"). The session is opened here
 * so the API key never reaches the renderer, and the delegated work runs here
 * as the pane's own agent CLI — same account, same folder, same model — with
 * the same free hand the user gave that pane.
 */

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const LIVE_MODEL = "gpt-live-1";
/** GPT-Live's natural Brazilian Portuguese voices are `bossa` and `tempo`. */
const LIVE_VOICE = "bossa";
/**
 * GPT-Live takes at most 500 tokens per append. Portuguese runs close to three
 * characters a token, so this leaves room for the sentence around the summary.
 */
const SPOKEN_SUMMARY_MAX_CHARS = 1_000;
/** Keeps Cursor's argv prompt well under Windows' 32 767-character command line. */
const TRANSCRIPT_MAX_CHARS = 16_000;
const OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;
const PROGRESS_MAX_CHARS = 160;
const MAX_ATTACHMENTS = 8;
/** How long a cancelled POSIX agent gets to exit on SIGTERM before SIGKILL. */
const POSIX_KILL_GRACE_MS = 3_000;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp)$/iu;
/** `session.input` takes 128 messages and 8 192 tokens; Portuguese runs ~3 chars a token. */
const HISTORY_MAX_MESSAGES = 120;
const HISTORY_MAX_CHARS = 18_000;
/**
 * The pane's own agent conversation shares the `session.input` budget with the
 * voice history; the voice history wins because it is what the user just said.
 */
const PANE_CONVERSATION_MAX_CHARS = 12_000;
/** Less than this and the excerpt says nothing useful; leave it out. */
const PANE_CONVERSATION_MIN_CHARS = 600;
const PANE_MESSAGE_MAX_CHARS = 2_400;
/** A model name as Claude's settings.json spells it: `opus`, `opus[1m]`, `claude-fable-5-1`. */
const CLAUDE_MODEL_PATTERN = /^[\w.-]+(?:\[\w+\])?$/u;

/** Conversation ids the CLIs print: UUIDs, sometimes without dashes. */
export const AGENT_SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/u;

export const AGENT_LABELS: Record<BrainstormAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent",
};

/**
 * The user asked for the brainstorm's agent to work exactly like the pane it
 * came from: no approval prompts, so it can edit and run commands headless.
 */
const CLAUDE_PERMISSION_ARGS = ["--permission-mode", "bypassPermissions"];
const CODEX_PERMISSION_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];
const CURSOR_PERMISSION_ARGS = ["--force", "--trust"];
/** Only what `cmd.exe` passes through untouched may reach an agent started from a `.cmd` shim. */
const SHELL_SAFE_ARG = /^[\w.,:=\[\]-]+$/u;
const CURSOR_VERSION_DIR =
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/u;

export interface LiveSecretReader {
  get(key: "openai-api-key"): Promise<string | null>;
}

interface AgentReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

interface AgentWritable {
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface AgentProcess {
  readonly pid?: number;
  readonly stdin: AgentWritable | null;
  readonly stdout: AgentReadable | null;
  readonly stderr: AgentReadable | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnAgent = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    windowsHide: true;
    /** POSIX: the agent leads its own process group, so cancelling it can
     * take its children (node, ripgrep, whatever it ran) along. */
    detached: boolean;
  },
) => AgentProcess;

export interface LiveBrainstormServiceOptions {
  secrets: LiveSecretReader;
  fetch?: typeof fetch;
  spawn?: SpawnAgent;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** `where.exe` lookup, injected so tests never search the real PATH. */
  resolveWindowsCommand?: (name: string) => Promise<string[]>;
  killTree?: (pid: number) => Promise<void>;
  /** Signals a POSIX process group. Injected so tests never signal a real one. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  sessionTimeoutMs?: number;
  delegationTimeoutMs?: number;
}

interface AgentRun {
  command: string;
  args: string[];
  /** Prompt piped on stdin; absent when the CLI takes it as an argument. */
  stdin?: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export interface AgentReply {
  text: string;
  sessionId: string | null;
  error: string | null;
  costUsd?: number | null;
}

interface ClaudeSettings {
  model?: unknown;
}

interface RunningDelegation {
  ownerId: number;
  child: AgentProcess;
  cancelled: boolean;
}

/** Cancelled or timed out: the user moved on, so there is nothing to retry. */
class DelegationStopped extends Error {}

type Resume = LiveDelegationInput["resume"];
type ProgressListener = (event: LiveDelegationProgressEvent) => void;

/** What a running agent tells about itself, one streamed line at a time. */
export interface LiveDelegationProgressEvent {
  /** A step worth showing, such as "lendo voice-service.ts". */
  text?: string;
  /** The agent conversation this run writes to, as soon as the CLI says. */
  agentSessionId?: string;
}

function timer(ms: number, callback: () => void): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function whereExe(name: string): Promise<string[]> {
  return runCommand("where.exe", [name], { timeoutMs: 5_000, maxBuffer: 64 * 1024 }).then(
    ({ stdout }) => stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
    () => [],
  );
}

function isFile(target: string): Promise<boolean> {
  return stat(target).then((info) => info.isFile(), () => false);
}

function cursorVersionKey(name: string): number[] {
  const match = CURSOR_VERSION_DIR.exec(name);
  return match ? match.slice(1, 7).map((part) => Number(part ?? 0)) : [];
}

/** Newest first, the order cursor-agent.ps1 picks its version directory in. */
function compareCursorVersions(left: string, right: string): number {
  const a = cursorVersionKey(left);
  const b = cursorVersionKey(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function shorten(value: string, max: number): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/**
 * The live prompt, in the shape the GPT-Live prompting guide asks for: role and
 * pace first, the policy labels kept verbatim, then short delegation rules.
 * Written in Portuguese so the model speaks Portuguese.
 */
export function buildLiveInstructions(cwd: string, agent: BrainstormAgent | null): string {
  const folder = path.basename(cwd) || cwd;
  const base = [
    "Você é um parceiro de brainstorm por voz dentro do Head Terminal, um terminal de desenvolvimento.",
    "Fale português do Brasil, em ritmo tranquilo e frases curtas, como um colega de equipe experiente. Seja direto e natural, sem animação exagerada. Termos técnicos em inglês ficam em inglês.",
    "Faça perguntas quando algo estiver vago, levante prós e contras e proponha alternativas. Não leia listas longas em voz alta.",
    `O usuário está trabalhando no projeto da pasta "${folder}" (${cwd}).`,
    "",
    "Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.",
    "",
    "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
    "",
  ];
  if (!agent) {
    return [
      ...base,
      "Você não tem acesso aos arquivos e este terminal não roda um agente de código. Se o usuário pedir para olhar o código, explique isso em uma frase e siga a conversa com o que ele contar.",
    ].join("\n");
  }

  const label = AGENT_LABELS[agent];
  return [
    ...base,
    "Delegation policy:",
    "Backend tools:",
    `- Código: o ${label} roda nesta pasta com permissão total, com o mesmo modelo e a mesma conta do terminal. Ele lê e busca no código, confirma se um bug existe e onde está, explica como algo está implementado, e também implementa: altera arquivos, roda comandos e testes quando o usuário pede.`,
    "- Internet: o backend pesquisa e lê páginas na web para novidades, documentação e comparações de ferramentas.",
    "- Imagens: o usuário pode anexar uma captura de tela na tela do app; só o backend enxerga a imagem.",
    "",
    "Delegate to the backend when:",
    "- O usuário pede para olhar, verificar, analisar ou procurar algo no código ou na pasta.",
    "- O usuário relata um bug ou comportamento estranho do projeto e a resposta depende de como o código está de fato.",
    "- O usuário quer saber quais arquivos uma ideia ou funcionalidade nova afetaria.",
    "- O usuário pede para implementar, corrigir, rodar, testar ou alterar algo no projeto.",
    "- O usuário pergunta sobre algo da internet: uma novidade, um lançamento, uma documentação ou uma comparação.",
    "- O usuário anexou uma imagem e a pergunta é sobre ela.",
    "- Uma correção do usuário muda uma análise já pedida.",
    "",
    "Do not delegate to the backend when:",
    "- É discussão de ideias, prós e contras ou opinião que não depende do código nem de fatos externos.",
    "- O usuário está só pensando em voz alta ou quer que você repita um resultado já dado.",
    "- Você precisa de um esclarecimento curto para entender o pedido.",
    "",
    "Delegate before giving an answer that depends on backend work.",
    "Do not guess the result while waiting.",
    "",
    `Ao delegar, avise em uma frase curta que vai pedir para o ${label} verificar e continue a conversa enquanto isso. A análise leva de alguns segundos a alguns minutos; se o usuário perguntar, diga o que o backend já informou que está fazendo.`,
    "Quando o resultado chegar, resuma em poucas frases e pergunte o que o usuário quer fazer a seguir. Os detalhes completos aparecem na tela dele, então não leia caminhos de arquivo nem trechos de código.",
    "Enquanto o backend trabalha, a voz pode ser pausada pelo app para não gastar; ela volta sozinha com o resultado. Se for pausar, o app avisa você por instrução.",
  ].join("\n");
}

/** The newest messages that fit the budget, oldest first. */
function selectHistory(history: readonly LiveHistoryMessage[]): LiveHistoryMessage[] {
  const kept: LiveHistoryMessage[] = [];
  let chars = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const text = message.text.trim();
    if (!text) continue;
    if (kept.length >= HISTORY_MAX_MESSAGES || chars + text.length > HISTORY_MAX_CHARS) break;
    kept.unshift({ role: message.role, text });
    chars += text.length;
  }
  return kept;
}

/** A pause-and-resume seeds the new session with what was said before it. */
export function buildHistoryMessages(
  history: readonly LiveHistoryMessage[],
): Array<Record<string, unknown>> {
  return selectHistory(history).map((message) =>
    message.role === "assistant"
      ? { type: "message", role: "assistant", content: [{ type: "output_text", text: message.text }] }
      : { type: "message", role: "user", content: [{ type: "input_text", text: message.text }] },
  );
}

/**
 * The pane's conversation as one developer note: the newest messages that fit,
 * each side labelled, so the voice knows what the user and the agent were
 * working on before F10 — without mistaking any of it for something said aloud.
 */
export function buildPaneConversationNote(
  conversation: AgentConversation,
  agent: BrainstormAgent,
  maxChars: number,
): string | null {
  const label = AGENT_LABELS[agent];
  const lines: string[] = [];
  let chars = 0;
  let omitted = 0;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    const text = message.text.trim();
    if (!text) continue;
    const clipped =
      text.length > PANE_MESSAGE_MAX_CHARS ? `${text.slice(0, PANE_MESSAGE_MAX_CHARS - 1)}…` : text;
    const line = `${message.role === "user" ? "Usuário" : label}: ${clipped}`;
    if (chars + line.length > maxChars) {
      omitted = index + 1;
      break;
    }
    lines.unshift(line);
    chars += line.length + 1;
  }
  if (lines.length === 0) return null;
  const title = conversation.title ? ` sobre "${conversation.title}"` : "";
  const head = [
    `Contexto: antes de abrir a voz, o usuário já estava conversando com o ${label} neste terminal${title}. A conversa segue abaixo, do mais antigo ao mais recente; ela é o assunto que o usuário quer discutir agora.`,
    omitted > 0
      ? `É só o trecho final (${omitted} ${omitted === 1 ? "mensagem anterior ficou" : "mensagens anteriores ficaram"} de fora); o ${label} tem a conversa inteira e pode ser consultado sobre ela.`
      : null,
    "Nada disso foi dito em voz alta: não leia a conversa nem a repita; use-a para entender do que se trata e continuar de onde parou. Se o usuário pedir um resumo, resuma em poucas frases.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  return `${head}\n\n${lines.join("\n")}`;
}

/** The home folder or a drive root is not a project: an analysis there crawls everything. */
export function isBroadFolder(cwd: string, homeDir: string): boolean {
  const resolved = path.resolve(cwd);
  return resolved === path.resolve(homeDir) || path.dirname(resolved) === resolved;
}

export const BROAD_FOLDER_WARNING =
  "Este terminal está na pasta pessoal, não em um projeto. Diga por voz \"abre a pasta <nome>\" ou abra um terminal na pasta do projeto.";

/** Startup history: facts about the project the model would otherwise have to ask for. */
export function buildSessionInput(
  cwd: string,
  agent: BrainstormAgent | null,
  branch: string | null | undefined,
  options: {
    broadFolder?: boolean;
    history?: readonly LiveHistoryMessage[];
    resumeNote?: string | null;
    /** The pane's own agent conversation, when it had one before F10. */
    paneConversation?: AgentConversation | null;
  } = {},
): Array<Record<string, unknown>> {
  const folder = path.basename(cwd) || cwd;
  const resuming = Boolean(options.resumeNote);
  const history = selectHistory(options.history ?? []);
  const historyChars = history.reduce((sum, message) => sum + message.text.length, 0);
  const paneNote =
    options.paneConversation && agent
      ? buildPaneConversationNote(
          options.paneConversation,
          agent,
          Math.min(PANE_CONVERSATION_MAX_CHARS, HISTORY_MAX_CHARS - historyChars),
        )
      : null;
  const paneNoteFits = paneNote !== null && paneNote.length >= PANE_CONVERSATION_MIN_CHARS;
  const facts = [
    options.broadFolder
      ? `Contexto do app: o terminal está na pasta pessoal do usuário ("${cwd}"), que não é um projeto. Antes de delegar uma análise de código, pergunte qual projeto ele quer e peça para ele dizer "abre a pasta <nome>", ou para abrir um terminal na pasta certa.`
      : `Contexto do app: o usuário está no projeto "${folder}".`,
    branch ? `Branch git atual: ${branch}.` : null,
    agent
      ? `O terminal roda o ${AGENT_LABELS[agent]}, que é o backend que analisa o código.`
      : "O terminal não roda um agente de código.",
    `Data de hoje: ${new Date().toISOString().slice(0, 10)}.`,
    resuming
      ? "A conversa por voz abaixo aconteceu antes de a voz ser pausada; esta sessão a continua."
      : "O usuário ainda não disse nada por voz; espere ele falar.",
  ].filter((fact): fact is string => fact !== null);
  const input: Array<Record<string, unknown>> = [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: facts.join(" ") }],
    },
  ];
  if (paneNoteFits) {
    input.push({ type: "message", role: "developer", content: [{ type: "input_text", text: paneNote }] });
  }
  input.push(...buildHistoryMessages(history));
  if (options.resumeNote) {
    input.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: options.resumeNote }],
    });
  }
  return input;
}

export interface AgentPromptInput {
  transcript: string;
  continuation?: boolean;
  attachments?: string[];
}

/**
 * First sentence of every delegated prompt. The CLIs name a conversation after
 * its opening message, so this is how the app tells a brainstorm run apart
 * from a conversation the user typed into a pane.
 */
export const AGENT_PROMPT_MARKER =
  "Brainstorm por voz do Head Terminal: análise em segundo plano.";
/** Line the agent adds to DETALHES when the user asked to work in another folder. */
const FOLDER_LINE = /^\s*PASTA:\s*(.+?)\s*$/imu;

export function buildAgentPrompt(input: AgentPromptInput | string): string {
  const options: AgentPromptInput = typeof input === "string" ? { transcript: input } : input;
  const recent = options.transcript.length > TRANSCRIPT_MAX_CHARS
    ? `…${options.transcript.slice(-TRANSCRIPT_MAX_CHARS)}`
    : options.transcript;
  const attachments = options.attachments ?? [];
  return [
    AGENT_PROMPT_MARKER,
    "",
    "## Contexto da conversa por voz",
    "Você foi acionado por um assistente de voz no meio de um brainstorm do usuário sobre o projeto desta pasta.",
    "A conversa abaixo é uma transcrição automática de voz: pode ter erros, frases incompletas e correções posteriores; nomes de arquivos e termos técnicos podem ter saído errados. Use o contexto mais recente.",
    options.continuation
      ? "Esta é a continuação da sua análise anterior; abaixo está só o que foi dito desde então."
      : "",
    "",
    "## Tarefa",
    "Atenda ao pedido mais recente do usuário na conversa. Você roda com a mesma permissão do terminal dele: pode alterar arquivos e rodar comandos quando o pedido for implementar, corrigir, rodar ou testar algo. Quando o pedido for só analisar, explicar ou opinar, não altere nada.",
    "- Bug relatado: confirme se existe de fato no código, aponte a causa e os arquivos; corrija só se o usuário pediu a correção.",
    "- Funcionalidade nova: se ele quer discutir, diga como o projeto está hoje, quais arquivos uma implementação tocaria e riscos; se ele pediu para implementar, implemente e rode o que valida a mudança.",
    "- Pergunta sobre algo externo (novidade, documentação, ferramenta): pesquise na web quando tiver a ferramenta e responda com fatos verificados e a data deles.",
    "- Pedido para trabalhar em outra pasta ou projeto (\"abre a pasta X\", \"vai no projeto Y\"): localize a pasta pelo nome, procurando até dois níveis abaixo da pasta atual e da pasta pessoal do usuário, e devolva o caminho absoluto em uma linha `PASTA: <caminho>` dentro de DETALHES. Não analise o conteúdo dela ainda; a próxima análise já roda lá.",
    "Se faltar um detalhe essencial para responder, diga qual em vez de adivinhar.",
    attachments.length > 0
      ? [
          "",
          "O usuário anexou estas imagens (capturas de tela); leia cada uma com a sua ferramenta de leitura de arquivos antes de responder:",
          ...attachments.map((file) => `- ${file}`),
        ].join("\n")
      : "",
    "",
    "<conversa>",
    recent.trim() || "(sem transcrição)",
    "</conversa>",
    "",
    "## Formato da resposta",
    "Responda em português do Brasil, exatamente neste formato:",
    "RESUMO:",
    "<2 a 4 frases curtas, para serem lidas em voz alta: os fatos, o que foi feito ou concluído, sem código, sem listas e sem caminhos de arquivo>",
    "DETALHES:",
    "<a análise completa em markdown, com os arquivos relevantes e trechos curtos quando ajudarem>",
  ]
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");
}

function clampSpoken(value: string): string {
  const plain = value.replace(/[*`#_]/gu, "").replace(/\s+/gu, " ").trim();
  return plain.length > SPOKEN_SUMMARY_MAX_CHARS
    ? `${plain.slice(0, SPOKEN_SUMMARY_MAX_CHARS - 1)}…`
    : plain;
}

/** Splits the agent's answer into what GPT-Live says and what the panel shows. */
export function splitAgentAnswer(text: string): {
  summary: string;
  details: string;
  /** Folder the agent says the user asked to switch to, unverified. */
  folder: string | null;
} {
  const cleaned = text.trim();
  const folder = FOLDER_LINE.exec(cleaned)?.[1].replace(/^[`"']+|[`"']+$/gu, "") ?? null;
  const match = /RESUMO:\s*([\s\S]*?)\s*DETALHES:\s*([\s\S]*)$/iu.exec(cleaned);
  if (match) {
    return {
      summary: clampSpoken(match[1]),
      details: match[2].trim() || match[1].trim(),
      folder,
    };
  }
  // Cursor prefixes a "> Auto routed to ..." note; it is not the answer.
  const paragraph = cleaned
    .split(/\n\s*\n/u)
    .find((part) => part.trim() && !part.trim().startsWith(">"));
  return { summary: clampSpoken(paragraph ?? cleaned), details: cleaned, folder };
}

function lastMeaningfulLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    // Codex logs its own housekeeping to stderr with a timestamp prefix.
    .filter((line) => line && !/^\d{4}-\d{2}-\d{2}T\S+\s+(ERROR|WARN|INFO|DEBUG)\b/u.test(line));
  return lines.at(-1) ?? null;
}

/** Claude's and Cursor's final `result` line; in stream mode it is the last of many. */
function parseResultJson(stdout: string): AgentReply {
  const candidates = [stdout.trim(), ...stdout.split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    const line = candidate.trim();
    if (!line.startsWith("{")) continue;
    let data: {
      type?: unknown;
      result?: unknown;
      session_id?: unknown;
      is_error?: unknown;
      total_cost_usd?: unknown;
    };
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    // Stream mode also prints assistant and tool lines; only the result counts.
    if (!("result" in data) && !("is_error" in data) && data.type !== "result") continue;
    const text = typeof data.result === "string" ? data.result : "";
    const sessionId =
      typeof data.session_id === "string" && AGENT_SESSION_ID_PATTERN.test(data.session_id)
        ? data.session_id
        : null;
    const costUsd = typeof data.total_cost_usd === "number" ? data.total_cost_usd : null;
    return data.is_error === true
      ? { text: "", sessionId, error: text || "o agente reportou um erro", costUsd }
      : { text, sessionId, error: null, costUsd };
  }
  return { text: "", sessionId: null, error: null };
}

function parseCodexEvents(stdout: string): AgentReply {
  let text = "";
  let sessionId: string | null = null;
  let error: string | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    let event: {
      type?: unknown;
      thread_id?: unknown;
      message?: unknown;
      item?: { type?: unknown; text?: unknown };
      error?: { message?: unknown };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event.type === "thread.started"
      && typeof event.thread_id === "string"
      && AGENT_SESSION_ID_PATTERN.test(event.thread_id)
    ) {
      sessionId = event.thread_id;
    } else if (
      event.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string"
    ) {
      text = event.item.text;
    } else if (event.type === "error" && typeof event.message === "string") {
      error = event.message;
    } else if (event.type === "turn.failed" && typeof event.error?.message === "string") {
      error = event.error.message;
    }
  }
  return text ? { text, sessionId, error: null } : { text, sessionId, error };
}

export function parseAgentReply(
  agent: BrainstormAgent,
  stdout: string,
  stderr: string,
  code: number | null,
): AgentReply {
  const reply = agent === "codex" ? parseCodexEvents(stdout) : parseResultJson(stdout);
  if (reply.error || reply.text.trim()) return reply;
  return {
    ...reply,
    error:
      lastMeaningfulLine(stderr)
      ?? (code === 0 ? "resposta vazia" : `saiu com código ${code ?? "desconhecido"}`),
  };
}

function describeClaudeTool(name: string, input: Record<string, unknown>): string | null {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Read":
      return str("file_path") ? `lendo ${path.basename(str("file_path"))}` : "lendo um arquivo";
    case "Grep":
      return str("pattern") ? `buscando "${str("pattern")}" no código` : "buscando no código";
    case "Glob":
      return str("pattern") ? `listando ${str("pattern")}` : "listando arquivos";
    case "WebSearch":
      return str("query") ? `pesquisando na web: ${str("query")}` : "pesquisando na web";
    case "WebFetch":
      return str("url") ? `abrindo ${str("url")}` : "abrindo uma página";
    default:
      return `usando ${name}`;
  }
}

/**
 * One line of an agent's streamed output, turned into a short progress note
 * for the panel and for GPT-Live's quiet context, or the id of the
 * conversation the run just opened. Null when it is neither.
 */
export function describeAgentEvent(
  agent: BrainstormAgent,
  line: string,
): LiveDelegationProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (agent === "claude" && event.type === "system" && event.subtype === "init") {
    return typeof event.session_id === "string" && AGENT_SESSION_ID_PATTERN.test(event.session_id)
      ? { agentSessionId: event.session_id }
      : null;
  }
  if (agent === "codex" && event.type === "thread.started") {
    return typeof event.thread_id === "string" && AGENT_SESSION_ID_PATTERN.test(event.thread_id)
      ? { agentSessionId: event.thread_id }
      : null;
  }

  if (agent === "claude" && event.type === "assistant") {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const steps = content
      .filter(
        (part): part is { type: string; name: string; input?: Record<string, unknown> } =>
          typeof part === "object"
          && part !== null
          && (part as { type?: unknown }).type === "tool_use"
          && typeof (part as { name?: unknown }).name === "string",
      )
      .map((part) => describeClaudeTool(part.name, part.input ?? {}))
      .filter((step): step is string => step !== null);
    return steps.length > 0 ? { text: shorten(steps.join(", "), PROGRESS_MAX_CHARS) } : null;
  }

  if (agent === "codex" && event.type === "item.started") {
    const item = event.item as { type?: unknown; command?: unknown; query?: unknown } | undefined;
    if (item?.type === "command_execution" && typeof item.command === "string") {
      return { text: shorten(`rodando ${item.command}`, PROGRESS_MAX_CHARS) };
    }
    if (item?.type === "web_search") {
      return {
        text:
          typeof item.query === "string"
            ? shorten(`pesquisando na web: ${item.query}`, PROGRESS_MAX_CHARS)
            : "pesquisando na web",
      };
    }
  }

  return null;
}

export class LiveBrainstormService {
  private readonly secrets: LiveSecretReader;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnAgent: SpawnAgent;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveWindowsCommand: (name: string) => Promise<string[]>;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sessionTimeoutMs: number;
  private readonly delegationTimeoutMs: number;
  private readonly running = new Map<string, RunningDelegation>();
  /** `where.exe` takes a moment; a CLI's location does not change mid-conversation. */
  private readonly commandLookups = new Map<string, Promise<string[]>>();

  constructor(options: LiveBrainstormServiceOptions) {
    if (!options?.secrets) throw new TypeError("LiveBrainstormService requires a secret reader");
    this.secrets = options.secrets;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.spawnAgent = options.spawn ?? (nodeSpawn as unknown as SpawnAgent);
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.resolveWindowsCommand = options.resolveWindowsCommand ?? whereExe;
    this.killTree = options.killTree ?? killWindowsProcessTree;
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 20_000;
    this.delegationTimeoutMs = options.delegationTimeoutMs ?? 5 * 60_000;
  }

  /** Posts the renderer's SDP offer and returns OpenAI's answer. */
  async createSession(input: LiveSessionInput): Promise<LiveSessionAnswer> {
    const apiKey = (await this.secrets.get("openai-api-key"))?.trim() ?? "";
    if (!apiKey) {
      throw new Error("Configure sua chave da OpenAI nas Configurações.");
    }
    await this.assertDirectory(input.cwd);
    // The first delegation should not wait on a PATH search.
    if (input.agent) void this.prepare(input.agent);

    const broadFolder = isBroadFolder(input.cwd, this.homeDir);
    const paneConversation = input.paneConversation
      ? await this.readPaneConversation(input.cwd, input.paneConversation)
      : undefined;
    const session: Record<string, unknown> = {
      model: LIVE_MODEL,
      instructions: buildLiveInstructions(input.cwd, input.agent),
      input: buildSessionInput(input.cwd, input.agent, input.branch, {
        broadFolder,
        history: input.history ?? [],
        resumeNote: input.resumeNote ?? null,
        paneConversation: paneConversation ?? null,
      }),
      audio: { output: { voice: LIVE_VOICE } },
    };
    // Without an agent there is nothing to hand work to; the prompt says so.
    if (input.agent) session.delegation = { type: "client" };

    const abort = new AbortController();
    const timeout = timer(this.sessionTimeoutMs, () => abort.abort());
    let response: Response;
    try {
      response = await this.fetchImpl(LIVE_SESSIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp: input.sdp } }),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        throw new Error("A OpenAI demorou demais para abrir a conversa.");
      }
      throw new Error("Falha de rede ao contatar a OpenAI.", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => ({}))) as {
      session?: { id?: unknown };
      transport?: { sdp?: unknown };
      error?: { message?: unknown };
    };
    if (!response.ok) {
      const detail =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Erro HTTP ${response.status}`;
      throw new Error(`Não foi possível abrir a conversa por voz: ${detail}`);
    }
    if (typeof body.transport?.sdp !== "string" || !body.transport.sdp) {
      throw new Error("A OpenAI não devolveu a resposta de conexão (SDP).");
    }
    return {
      sessionId: typeof body.session?.id === "string" ? body.session.id : null,
      sdp: body.transport.sdp,
      warning: broadFolder ? BROAD_FOLDER_WARNING : null,
      ...(paneConversation === undefined
        ? {}
        : {
            paneConversation: paneConversation
              ? { messages: paneConversation.messages.length, title: paneConversation.title }
              : null,
          }),
    };
  }

  /**
   * The pane's agent conversation, read best-effort: a transcript that is not
   * there yet, or a profile outside the app's, just means the voice starts
   * without it.
   */
  private async readPaneConversation(
    cwd: string,
    locator: NonNullable<LiveSessionInput["paneConversation"]>,
  ): Promise<AgentConversation | null> {
    try {
      const claudeConfigDir =
        locator.agent === "claude" ? this.claudeConfigDir(locator.claudeConfigDir) : undefined;
      return await readAgentConversation(
        {
          agent: locator.agent,
          sessionId: locator.sessionId,
          cwd,
          ...(claudeConfigDir ? { claudeConfigDir } : {}),
        },
        resolveAgentSessionRoots({ home: this.homeDir }),
      );
    } catch (error) {
      console.error("Failed to read the pane's agent conversation", {
        agent: locator.agent,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /** Runs one delegated question through the pane's agent and splits its answer. */
  async delegate(
    ownerId: number,
    input: LiveDelegationInput,
    onProgress?: ProgressListener,
  ): Promise<LiveDelegationResult> {
    const label = AGENT_LABELS[input.agent];
    // Cursor has no fork: resuming the pane's chat would write into it.
    const resume = input.agent === "cursor" && input.resume?.fork ? undefined : input.resume;
    if (resume && !AGENT_SESSION_ID_PATTERN.test(resume.sessionId)) {
      throw new TypeError("Id de conversa do agente inválido.");
    }
    await this.assertDirectory(input.cwd);
    const attachments = await this.checkAttachments(input.attachments ?? []);

    const prompt = buildAgentPrompt({
      transcript: input.transcript,
      // Nothing to continue from when the resume is dropped or absent.
      continuation: Boolean(input.continuation && resume && !resume.fork),
      attachments,
    });
    let reply = await this.runOnce(ownerId, input, prompt, resume, onProgress);
    if (reply.error && resume) {
      // The conversation to continue can be gone (cleared, another account);
      // a fresh one still answers, only without the earlier context.
      onProgress?.({ text: "a conversa anterior não pôde ser retomada; recomeçando do zero" });
      const fresh = buildAgentPrompt({ transcript: input.transcript, attachments });
      reply = await this.runOnce(ownerId, input, fresh, undefined, onProgress);
    }
    if (reply.error) throw new Error(`${label}: ${reply.error}`);
    const { summary, details, folder } = splitAgentAnswer(reply.text);
    return {
      summary,
      details,
      agentSessionId: reply.sessionId,
      costUsd: reply.costUsd ?? null,
      folder: folder ? await this.existingFolder(folder, input.cwd) : null,
      model: input.agent === "claude" ? await this.claudeModel(input.claudeConfigDir) : null,
    };
  }

  /**
   * The pane runs a bare `claude`, so its model is whatever the profile's
   * settings.json says. Read it here so the delegation names the same one
   * explicitly instead of trusting the CLI's default resolution.
   */
  private async claudeModel(configDir: string | undefined): Promise<string | null> {
    if (!configDir) return null;
    try {
      const raw = await readFile(path.join(this.claudeConfigDir(configDir), "settings.json"), "utf8");
      const settings = JSON.parse(raw) as ClaudeSettings;
      return typeof settings.model === "string" && CLAUDE_MODEL_PATTERN.test(settings.model)
        ? settings.model
        : null;
    } catch {
      return null;
    }
  }

  /** The agent names a folder; only one that exists on disk changes anything. */
  private async existingFolder(candidate: string, cwd: string): Promise<string | null> {
    const resolved = path.resolve(cwd, candidate.trim());
    const info = await stat(resolved).catch(() => null);
    return info?.isDirectory() ? resolved : null;
  }

  async cancelDelegation(ownerId: number, delegationId: string): Promise<void> {
    const entry = this.running.get(delegationId);
    if (!entry || entry.ownerId !== ownerId) return;
    entry.cancelled = true;
    await this.terminate(entry.child);
  }

  /** Stops every analysis started by a renderer that is going away. */
  async cleanup(ownerId?: number): Promise<void> {
    const stops = [...this.running.entries()]
      .filter(([, entry]) => ownerId === undefined || entry.ownerId === ownerId)
      .map(([id, entry]) => this.cancelDelegation(entry.ownerId, id));
    await Promise.all(stops);
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  /** Resolves the agent's executable ahead of the first delegation. */
  private async prepare(agent: BrainstormAgent): Promise<void> {
    if (this.platform !== "win32") return;
    try {
      await this.lookup(agent === "cursor" ? "cursor-agent" : agent);
    } catch {
      // The delegation reports the real problem when it happens.
    }
  }

  private lookup(name: string): Promise<string[]> {
    let pending = this.commandLookups.get(name);
    if (!pending) {
      pending = this.resolveWindowsCommand(name).then((found) => {
        // An empty answer is worth asking again: the CLI may be installing.
        if (found.length === 0) this.commandLookups.delete(name);
        return found;
      });
      this.commandLookups.set(name, pending);
    }
    return pending;
  }

  /** Only images that exist reach the prompt; the agent reads them by path. */
  private async checkAttachments(paths: string[]): Promise<string[]> {
    if (paths.length > MAX_ATTACHMENTS) {
      throw new Error(`No máximo ${MAX_ATTACHMENTS} imagens por análise.`);
    }
    const kept: string[] = [];
    for (const candidate of paths) {
      const resolved = path.resolve(candidate);
      if (!IMAGE_FILE.test(resolved)) {
        throw new Error(`Anexo não é uma imagem: ${path.basename(resolved)}`);
      }
      if (!(await isFile(resolved))) {
        throw new Error(`Imagem anexada não foi encontrada: ${path.basename(resolved)}`);
      }
      kept.push(resolved);
    }
    return kept;
  }

  private async runOnce(
    ownerId: number,
    input: LiveDelegationInput,
    prompt: string,
    resume: Resume,
    onProgress: ProgressListener | undefined,
  ): Promise<AgentReply> {
    const run = await this.buildRun(input, prompt, resume);
    const onLine = onProgress
      ? (line: string) => {
          const step = describeAgentEvent(input.agent, line);
          if (step) onProgress(step);
        }
      : undefined;
    const { code, stdout, stderr } = await this.execute(
      input.delegationId,
      ownerId,
      run,
      input.cwd,
      AGENT_LABELS[input.agent],
      onLine,
    );
    return parseAgentReply(input.agent, stdout, stderr, code);
  }

  private async buildRun(
    input: LiveDelegationInput,
    prompt: string,
    resume: Resume,
  ): Promise<AgentRun> {
    const env = this.agentEnv();

    if (input.agent === "claude") {
      const configDir = this.claudeConfigDir(input.claudeConfigDir);
      // stream-json reports each tool call as it happens; --verbose is what
      // print mode requires for it. The final line is the same result object.
      const args = ["-p", "--output-format", "stream-json", "--verbose", ...CLAUDE_PERMISSION_ARGS];
      const model = await this.claudeModel(input.claudeConfigDir);
      if (model) args.push("--model", model);
      if (resume) {
        args.push("--resume", resume.sessionId);
        // A fork leaves the pane's own conversation exactly as it was.
        if (resume.fork) args.push("--fork-session");
      }
      const launch = await this.launch("claude", args);
      return { ...launch, args, stdin: prompt, env: { ...env, CLAUDE_CONFIG_DIR: configDir } };
    }

    if (input.agent === "codex") {
      const args = [
        "exec",
        ...CODEX_PERMISSION_ARGS,
        "--skip-git-repo-check",
        "--color",
        "never",
        "--json",
      ];
      if (resume) args.push(resume.fork ? "fork" : "resume", resume.sessionId);
      args.push("-");
      const launch = await this.launch("codex", args);
      return { ...launch, args, stdin: prompt, env };
    }

    // Cursor Agent reads its prompt from argv only, so it never goes through a shell.
    const args = ["-p", ...CURSOR_PERMISSION_ARGS, "--output-format", "json"];
    if (resume && !resume.fork) args.push("--resume", resume.sessionId);
    args.push(prompt);
    if (this.platform !== "win32") {
      return { command: "cursor-agent", args, env, shell: false };
    }
    const entry = await this.cursorEntryPoint();
    return {
      command: entry.node,
      args: [entry.script, ...args],
      env: { ...env, CURSOR_INVOKED_AS: "cursor-agent" },
      shell: false,
    };
  }

  private async launch(
    name: "claude" | "codex",
    args: string[],
  ): Promise<{ command: string; shell: boolean }> {
    if (this.platform !== "win32") return { command: name, shell: false };
    const found = await this.lookup(name);
    const exe = found.find((candidate) => /\.exe$/iu.test(candidate));
    if (exe) return { command: exe, shell: false };
    const script = found.find((candidate) => /\.(cmd|bat)$/iu.test(candidate));
    if (!script) throw new Error(`${name} não foi encontrado no PATH do Windows.`);
    // npm installs a .cmd shim, which only cmd.exe can start. The prompt goes
    // on stdin, so argv holds nothing but fixed flags and validated ids.
    if (!args.every((arg) => SHELL_SAFE_ARG.test(arg))) {
      throw new Error(`Argumentos inseguros para iniciar ${name} pelo cmd.exe.`);
    }
    return { command: `"${script}"`, shell: true };
  }

  /** Same lookup as the installer's cursor-agent.ps1, minus PowerShell. */
  private async cursorEntryPoint(): Promise<{ node: string; script: string }> {
    const found = await this.lookup("cursor-agent");
    const shim = found[0];
    if (!shim) throw new Error("cursor-agent não foi encontrado no PATH do Windows.");
    const base = path.dirname(shim);
    if (await isFile(path.join(base, "node.exe"))) {
      return { node: path.join(base, "node.exe"), script: path.join(base, "index.js") };
    }
    const versions = (await readdir(path.join(base, "versions")).catch(() => [] as string[]))
      .filter((name) => CURSOR_VERSION_DIR.test(name))
      .sort(compareCursorVersions);
    const newest = versions[0];
    if (!newest) throw new Error(`Nenhuma versão do Cursor Agent instalada em ${base}.`);
    const dir = path.join(base, "versions", newest);
    return { node: path.join(dir, "node.exe"), script: path.join(dir, "index.js") };
  }

  private agentEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, NO_COLOR: "1" };
    if (this.platform !== "win32") {
      // A desktop launch skips the login shell's rc files, which is where
      // ~/.local/bin (the CLIs' default install) usually joins PATH.
      const userBin = path.join(this.homeDir, ".local", "bin");
      env.PATH = env.PATH ? `${userBin}${path.delimiter}${env.PATH}` : userBin;
    }
    return env;
  }

  /** Exactly one level below the profiles root: a pane profile, never ~/.claude. */
  private claudeConfigDir(dir: string | undefined): string {
    if (!dir) throw new Error("O terminal não informou o perfil Claude.");
    const root = path.resolve(this.homeDir, ".head-terminal", "claude-profiles");
    const target = path.resolve(dir);
    const relative = path.relative(root, target);
    if (
      !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) {
      throw new Error("Perfil Claude fora de ~/.head-terminal/claude-profiles.");
    }
    return target;
  }

  private async assertDirectory(cwd: string): Promise<void> {
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`Pasta do terminal não encontrada: ${cwd}`);
    }
  }

  private execute(
    delegationId: string,
    ownerId: number,
    run: AgentRun,
    cwd: string,
    label: string,
    onLine?: (line: string) => void,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (this.running.has(delegationId)) {
      return Promise.reject(new Error("Essa análise já está em andamento."));
    }

    return new Promise((resolve, reject) => {
      let child: AgentProcess;
      try {
        child = this.spawnAgent(run.command, run.args, {
          cwd,
          env: run.env,
          shell: run.shell,
          windowsHide: true,
          detached: this.platform !== "win32",
        });
      } catch (error) {
        reject(new Error(`Não foi possível iniciar o ${label}: ${errorMessage(error)}`));
        return;
      }

      const entry: RunningDelegation = { ownerId, child, cancelled: false };
      this.running.set(delegationId, entry);
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let settled = false;
      // Streamed output arrives in arbitrary pieces; steps are whole lines.
      let partialLine = "";

      const settle = (outcome: { code: number | null } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.running.get(delegationId) === entry) this.running.delete(delegationId);
        if (outcome instanceof Error) {
          reject(outcome);
          return;
        }
        resolve({ code: outcome.code, stdout: Buffer.concat(chunks).toString("utf8"), stderr });
      };

      const timeout = timer(this.delegationTimeoutMs, () => {
        void this.terminate(child);
        const minutes = Math.max(1, Math.round(this.delegationTimeoutMs / 60_000));
        settle(new DelegationStopped(`O ${label} passou de ${minutes} min e foi interrompido.`));
      });

      child.stdout?.on("data", (chunk) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > OUTPUT_MAX_BYTES) {
          void this.terminate(child);
          settle(new DelegationStopped(`A resposta do ${label} ficou grande demais.`));
          return;
        }
        chunks.push(buffer);
        if (!onLine || settled) return;
        const text = partialLine + buffer.toString("utf8");
        const lines = text.split(/\r?\n/u);
        partialLine = lines.pop() ?? "";
        for (const line of lines) {
          try {
            onLine(line);
          } catch {
            // A progress listener must never take the analysis down with it.
          }
        }
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
      child.once("error", (error) =>
        settle(new Error(`Não foi possível iniciar o ${label}: ${error.message}`)),
      );
      child.once("close", (code) =>
        settle(entry.cancelled ? new DelegationStopped("Análise cancelada.") : { code }),
      );

      // EPIPE when the CLI exits before reading its prompt; `close` reports it.
      child.stdin?.on("error", () => undefined);
      if (run.stdin !== undefined) child.stdin?.write(run.stdin);
      child.stdin?.end();
    });
  }

  private async terminate(child: AgentProcess): Promise<void> {
    try {
      if (this.platform === "win32" && child.pid) {
        // The agent CLIs start their own children (ripgrep, node); kill the tree.
        await this.killTree(child.pid);
        return;
      }
      // POSIX: the agent was spawned detached, so its pid is its group. A
      // cancelled analysis must not leave a `claude` child still editing
      // files, nor orphan it at quit; the group gets SIGTERM now and SIGKILL
      // shortly after for anything that traps it.
      if (child.pid) {
        const pid = child.pid;
        this.signalGroup(pid, "SIGTERM");
        timer(POSIX_KILL_GRACE_MS, () => this.signalGroup(pid, "SIGKILL"));
      }
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killGroup(pid, signal);
    } catch {
      // ESRCH: the group already exited.
    }
  }
}
