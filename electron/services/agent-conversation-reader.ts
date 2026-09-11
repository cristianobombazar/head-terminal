import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanTitleText,
  collectCodexRolloutFiles,
  encodeClaudeProjectDir,
  isEnoent,
  readCodexSessionMeta,
  resolveEncodedProjectDir,
  type AgentSessionRoots,
} from "./agent-sessions-service";

/**
 * What a pane's agent and its user said to each other, read back from the
 * CLI's own transcript so a voice brainstorm opened on that pane can pick the
 * conversation up instead of starting from zero. Tool calls, tool output,
 * thinking and the CLI's housekeeping records are left out: only the text
 * one side wrote for the other is a conversation.
 */

export type ConversationAgent = "claude" | "codex";

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentConversation {
  /** The CLI's own name for the conversation, when it recorded one. */
  title: string | null;
  /** Oldest first; consecutive records by one side are merged into one message. */
  messages: ConversationMessage[];
}

export interface ConversationLocator {
  agent: ConversationAgent;
  sessionId: string;
  cwd: string;
  /** Claude only: the pane's profile, whose `projects/` holds the transcript. */
  claudeConfigDir?: string;
}

/** Only the end of a long transcript is read; the conversation's tail is what matters. */
const TAIL_MAX_BYTES = 6 * 1024 * 1024;
const CODEX_MAX_CANDIDATE_FILES = 400;

// Blocks the CLI injects into the user's turn that were never said by anyone.
const STRIP_SYSTEM_BLOCK = /<(system-reminder|task-notification)>[\s\S]*?(?:<\/\1>|$)/gi;
// Codex's own preamble records wear the user role.
const CODEX_INJECTED_PROMPT =
  /^\s*(?:<(?:environment_context|user_instructions|permissions)|#\s*AGENTS\.md)/iu;
// The CLI's note for a turn the user cut short.
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/iu;

function cleanText(raw: string): string {
  return cleanTitleText(raw.replace(STRIP_SYSTEM_BLOCK, " "));
}

/** Every text block of a message, in order; strings count as one block. */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: unknown; text?: unknown };
    if (
      (block.type === "text" || block.type === "input_text" || block.type === "output_text")
      && typeof block.text === "string"
    ) {
      texts.push(block.text);
    }
  }
  return texts;
}

/** The last `maxBytes` of a file, split into whole lines (a cut first line is dropped). */
async function readTailLines(filePath: string, maxBytes: number): Promise<string[]> {
  const info = await stat(filePath);
  const size = info.size;
  const start = Math.max(0, size - maxBytes);
  const handle = await open(filePath, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split(/\r?\n/u);
  if (start > 0) lines.shift();
  return lines.filter((line) => line.trim());
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pushMessage(messages: ConversationMessage[], role: ConversationMessage["role"], text: string): void {
  const cleaned = cleanText(text);
  if (!cleaned || INTERRUPTED.test(cleaned)) return;
  const last = messages.at(-1);
  if (last && last.role === role) {
    last.text = `${last.text}\n${cleaned}`;
  } else {
    messages.push({ role, text: cleaned });
  }
}

// --- Claude: <configDir>/projects/<cwd-encoded>/<sessionId>.jsonl ---

async function resolveClaudeTranscript(
  locator: ConversationLocator,
  roots: AgentSessionRoots,
): Promise<string | null> {
  const root = locator.claudeConfigDir
    ? join(locator.claudeConfigDir, "projects")
    : roots.claudeProjectsRoot;
  const dir = await resolveEncodedProjectDir(root, locator.cwd, encodeClaudeProjectDir);
  if (!dir) return null;
  const filePath = join(dir, `${locator.sessionId}.jsonl`);
  try {
    await stat(filePath);
    return filePath;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** Reads a Claude Code transcript's text turns; exported for tests on the record shapes. */
export function parseClaudeConversation(lines: readonly string[]): AgentConversation {
  const messages: ConversationMessage[] = [];
  let title: string | null = null;
  for (const line of lines) {
    const record = parseLine(line) as {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      aiTitle?: unknown;
      message?: { content?: unknown };
    } | null;
    if (!record) continue;
    if (record.type === "ai-title") {
      if (typeof record.aiTitle === "string" && record.aiTitle.trim()) title = record.aiTitle.trim();
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    // Subagent traffic and the CLI's own notes are not the conversation.
    if (record.isSidechain === true || record.isMeta === true) continue;
    const texts = textBlocks(record.message?.content);
    if (texts.length === 0) continue;
    pushMessage(messages, record.type, texts.join("\n"));
  }
  return { title, messages };
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<sessionId>.jsonl ---

async function resolveCodexTranscript(
  locator: ConversationLocator,
  roots: AgentSessionRoots,
): Promise<string | null> {
  const files = await collectCodexRolloutFiles(roots.codexRoot, CODEX_MAX_CANDIDATE_FILES);
  const suffix = `-${locator.sessionId}.jsonl`.toLowerCase();
  const byName = files.find((file) => file.path.toLowerCase().endsWith(suffix));
  if (byName) return byName.path;
  // Older layouts name the file differently; the header still carries the id.
  for (const file of files) {
    const meta = await readCodexSessionMeta(file.path).catch(() => null);
    if (meta?.id === locator.sessionId) return file.path;
  }
  return null;
}

/** Reads a Codex rollout's text turns; exported for tests on the record shapes. */
export function parseCodexConversation(lines: readonly string[]): AgentConversation {
  const messages: ConversationMessage[] = [];
  for (const line of lines) {
    const record = parseLine(line) as {
      type?: unknown;
      payload?: { type?: unknown; role?: unknown; content?: unknown };
    } | null;
    if (!record || record.type !== "response_item") continue;
    const payload = record.payload;
    if (payload?.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const texts = textBlocks(payload.content);
    if (texts.length === 0) continue;
    const text = texts.join("\n");
    if (payload.role === "user" && CODEX_INJECTED_PROMPT.test(text)) continue;
    pushMessage(messages, payload.role, text);
  }
  return { title: null, messages };
}

/**
 * The pane's conversation, or null when the transcript is not on disk yet (a
 * `claude` sitting at an empty prompt has none) or the id is unknown.
 */
export async function readAgentConversation(
  locator: ConversationLocator,
  roots: AgentSessionRoots,
): Promise<AgentConversation | null> {
  const filePath =
    locator.agent === "claude"
      ? await resolveClaudeTranscript(locator, roots)
      : await resolveCodexTranscript(locator, roots);
  if (!filePath) return null;
  const lines = await readTailLines(filePath, TAIL_MAX_BYTES);
  const conversation =
    locator.agent === "claude" ? parseClaudeConversation(lines) : parseCodexConversation(lines);
  return conversation.messages.length > 0 ? conversation : null;
}
