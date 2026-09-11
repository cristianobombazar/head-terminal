import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseClaudeConversation,
  parseCodexConversation,
  readAgentConversation,
} from "../../electron/services/agent-conversation-reader";
import type { AgentSessionRoots } from "../../electron/services/agent-sessions-service";

let home: string;
let roots: AgentSessionRoots;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ht-conversation-"));
  roots = {
    claudeProjectsRoot: path.join(home, ".claude", "projects"),
    codexRoot: path.join(home, ".codex"),
    cursorProjectsRoot: path.join(home, ".cursor", "projects"),
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record));

describe("parseClaudeConversation", () => {
  it("keeps what the user and the assistant wrote, merged per turn, and the CLI's title", () => {
    const conversation = parseClaudeConversation(
      lines([
        { type: "mode", mode: "normal" },
        {
          type: "user",
          isMeta: true,
          message: { content: "<local-command-caveat>ignore me</local-command-caveat>" },
        },
        {
          type: "user",
          message: {
            content:
              "<system-reminder>Codebase instructions…</system-reminder>Veja o bug do upload de voz",
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Vou olhar o serviço." }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
        },
        { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "O upload manda multipart; o bug está no mime." }] },
        },
        { type: "ai-title", aiTitle: "Bug no upload de voz" },
        { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
        { type: "user", message: { content: [{ type: "text", text: "Corrige então" }] } },
      ]),
    );

    expect(conversation.title).toBe("Bug no upload de voz");
    expect(conversation.messages).toEqual([
      { role: "user", text: "Veja o bug do upload de voz" },
      { role: "assistant", text: "Vou olhar o serviço.\nO upload manda multipart; o bug está no mime." },
      { role: "user", text: "Corrige então" },
    ]);
  });
});

describe("parseCodexConversation", () => {
  it("reads user and assistant messages and skips the CLI's injected prompts", () => {
    const conversation = parseCodexConversation(
      lines([
        { type: "session_meta", payload: { id: "abc", cwd: "/p" } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
        },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explica o fluxo de login" }] },
        },
        { type: "response_item", payload: { type: "reasoning", summary: [] } },
        { type: "response_item", payload: { type: "function_call", name: "shell" } },
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "O login usa OAuth com PKCE." }] },
        },
      ]),
    );

    expect(conversation).toEqual({
      title: null,
      messages: [
        { role: "user", text: "Explica o fluxo de login" },
        { role: "assistant", text: "O login usa OAuth com PKCE." },
      ],
    });
  });
});

describe("readAgentConversation", () => {
  it("finds a Claude transcript under the pane's profile and cwd", async () => {
    const configDir = path.join(home, ".head-terminal", "claude-profiles", "default");
    const cwd = "C:\\Users\\dev\\my.app";
    const dir = path.join(configDir, "projects", "C--Users-dev-my-app");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl"),
      lines([
        { type: "user", message: { content: "oi" } },
        { type: "assistant", message: { content: [{ type: "text", text: "olá" }] } },
      ]).join("\n"),
    );

    await expect(
      readAgentConversation(
        { agent: "claude", sessionId: "11111111-2222-3333-4444-555555555555", cwd, claudeConfigDir: configDir },
        roots,
      ),
    ).resolves.toEqual({
      title: null,
      messages: [
        { role: "user", text: "oi" },
        { role: "assistant", text: "olá" },
      ],
    });
    // Another id, or a conversation that has not been written yet: nothing, no error.
    await expect(
      readAgentConversation(
        { agent: "claude", sessionId: "99999999-2222-3333-4444-555555555555", cwd, claudeConfigDir: configDir },
        roots,
      ),
    ).resolves.toBeNull();
  });

  it("finds a Codex rollout by the id in its file name", async () => {
    const day = path.join(roots.codexRoot, "sessions", "2026", "09", "10");
    await mkdir(day, { recursive: true });
    await writeFile(
      path.join(day, "rollout-2026-09-10T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
      lines([
        { type: "session_meta", payload: { id: "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: "/p" } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "roda os testes" }] },
        },
      ]).join("\n"),
    );

    await expect(
      readAgentConversation(
        { agent: "codex", sessionId: "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: "/p" },
        roots,
      ),
    ).resolves.toEqual({ title: null, messages: [{ role: "user", text: "roda os testes" }] });
  });
});
