import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_PROMPT_MARKER,
  BROAD_FOLDER_WARNING,
  buildPaneConversationNote,
  describeAgentEvent,
  LiveBrainstormService,
  parseAgentReply,
  splitAgentAnswer,
  type AgentProcess,
  type LiveBrainstormServiceOptions,
} from "../../electron/services/live-brainstorm-service";
import type { LiveDelegationInput } from "../../electron/types/api";

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Never exits on its own; only a kill ends it. */
  hang?: boolean;
}

class FakeAgent extends EventEmitter {
  pid = 4242;
  stdinText = "";
  readonly stdin = {
    write: (chunk: string) => {
      this.stdinText += chunk;
    },
    end: vi.fn(),
    on: vi.fn(),
  };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => {
    setTimeout(() => this.emit("close", null), 0);
    return true;
  });
}

interface Spawned {
  command: string;
  args: string[];
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean };
  agent: FakeAgent;
}

const CLAUDE_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "04bb555b-b7ca-41bd-823f-468ff79b7783",
});
const CLAUDE_TOOL = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", name: "Grep", input: { pattern: "FormData" } },
      { type: "tool_use", name: "Read", input: { file_path: "C:\\app\\electron\\voice-service.ts" } },
    ],
  },
});
const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  is_error: false,
  result: "RESUMO:\nO upload vai em multipart para a OpenAI.\nDETALHES:\n- `voice-service.ts` monta o FormData.",
  session_id: "04bb555b-b7ca-41bd-823f-468ff79b7783",
  total_cost_usd: 0.2183,
});
/** What `claude -p --output-format stream-json` prints: init, tool calls, then the result. */
const CLAUDE_OK = [CLAUDE_INIT, CLAUDE_TOOL, CLAUDE_RESULT].join("\n");

let home: string;
let project: string;
let profileDir: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ht-live-"));
  project = path.join(home, "project");
  profileDir = path.join(home, ".head-terminal", "claude-profiles", "default");
  await mkdir(project, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function createService(
  scripts: Script[],
  options: Partial<LiveBrainstormServiceOptions> = {},
): { service: LiveBrainstormService; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const spawn = vi.fn((command: string, args: string[], spawnOptions: Spawned["options"]) => {
    const agent = new FakeAgent();
    spawned.push({ command, args, options: spawnOptions, agent });
    const script = scripts[spawned.length - 1] ?? { stdout: CLAUDE_OK };
    if (!script.hang) {
      setTimeout(() => {
        if (script.stderr) agent.stderr.emit("data", Buffer.from(script.stderr));
        if (script.stdout) agent.stdout.emit("data", Buffer.from(script.stdout));
        agent.emit("close", script.code ?? 0);
      }, 0);
    }
    return agent as unknown as AgentProcess;
  });
  const service = new LiveBrainstormService({
    secrets: { get: async () => "sk-test" },
    spawn,
    platform: "linux",
    homeDir: home,
    env: { PATH: "/usr/bin" },
    resolveWindowsCommand: async () => [],
    killTree: vi.fn(async () => undefined),
    ...options,
  });
  return { service, spawned };
}

function claudeInput(overrides: Partial<LiveDelegationInput> = {}): LiveDelegationInput {
  return {
    delegationId: "item_1",
    agent: "claude",
    cwd: project,
    transcript: "Usuário: olha como o upload de voz funciona",
    claudeConfigDir: profileDir,
    ...overrides,
  };
}

describe("LiveBrainstormService.createSession", () => {
  it("opens a GPT-Live session with client delegation and returns the SDP answer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "answer" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const { service } = createService([], { fetch: fetchImpl });

    const answer = await service.createSession({
      sdp: "offer",
      cwd: project,
      agent: "claude",
      branch: "feat/voice-brainstorm",
    });

    expect(answer).toEqual({ sessionId: "live_1", sdp: "answer", warning: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.session.model).toBe("gpt-live-1");
    expect(body.session.delegation).toEqual({ type: "client" });
    // A Brazilian Portuguese voice, not the English default.
    expect(body.session.audio).toEqual({ output: { voice: "bossa" } });
    expect(body.session.instructions).toContain("Claude Code");
    expect(body.session.instructions).toContain('"project"');
    // The policy labels the prompting guide asks for, verbatim.
    expect(body.session.instructions).toContain("Delegation policy:");
    expect(body.session.instructions).toContain("Backend tools:");
    expect(body.session.instructions).toContain("Delegate to the backend when:");
    expect(body.session.instructions).toContain("Do not delegate to the backend when:");
    expect(body.session.instructions).toContain("Backchannel policy:");
    // Startup history carries the project facts.
    expect(body.session.input).toHaveLength(1);
    expect(body.session.input[0].role).toBe("developer");
    expect(body.session.input[0].content[0].text).toContain("feat/voice-brainstorm");
    expect(body.session.input[0].content[0].text).toContain('"project"');
    expect(body.transport).toEqual({ type: "webrtc", sdp: "offer" });
  });

  it("seeds a resumed session with the conversation before the pause and what happened meanwhile", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ transport: { sdp: "answer" } }), { status: 201 }),
    );
    const { service } = createService([], { fetch: fetchImpl });

    await service.createSession({
      sdp: "offer",
      cwd: project,
      agent: "claude",
      history: [
        { role: "user", text: "olha o bug do upload" },
        { role: "assistant", text: "Vou pedir para o Claude verificar." },
        { role: "user", text: "   " },
      ],
      resumeNote: "Enquanto a voz estava pausada, o Claude Code terminou. O bug existe.",
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.session.input.map((message: { role: string }) => message.role)).toEqual([
      "developer",
      "user",
      "assistant",
      "developer",
    ]);
    expect(body.session.input[1].content[0]).toEqual({ type: "input_text", text: "olha o bug do upload" });
    expect(body.session.input[2].content[0]).toEqual({
      type: "output_text",
      text: "Vou pedir para o Claude verificar.",
    });
    expect(body.session.input[3].content[0].text).toContain("O bug existe.");
    expect(body.session.input[0].content[0].text).toContain("antes de a voz ser pausada");
  });

  it("seeds the voice with the pane's own agent conversation, newest part first to go", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ transport: { sdp: "answer" } }), { status: 201 }),
    );
    const { service } = createService([], { fetch: fetchImpl });
    // The CLI flattens the cwd into one directory name (see encodeClaudeProjectDir).
    const dir = path.join(profileDir, "projects", project.replace(/[/\\.:]/g, "-"));
    await mkdir(dir, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    await writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "user", message: { content: "Veja o bug do upload de voz" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "O upload manda multipart; o bug está no mime." }] },
        }),
        JSON.stringify({ type: "ai-title", aiTitle: "Bug no upload de voz" }),
        JSON.stringify({ type: "user", message: { content: `Corrige então. ${"x".repeat(700)}` } }),
      ].join("\n"),
    );

    const answer = await service.createSession({
      sdp: "offer",
      cwd: project,
      agent: "claude",
      paneConversation: { agent: "claude", sessionId, claudeConfigDir: profileDir },
    });

    expect(answer.paneConversation).toEqual({ messages: 3, title: "Bug no upload de voz" });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.session.input.map((message: { role: string }) => message.role)).toEqual([
      "developer",
      "developer",
    ]);
    const note: string = body.session.input[1].content[0].text;
    expect(note).toContain('"Bug no upload de voz"');
    expect(note).toContain("Usuário: Veja o bug do upload de voz");
    expect(note).toContain("Claude Code: O upload manda multipart");
    expect(note).toContain("Nada disso foi dito em voz alta");
    expect(body.session.input[0].content[0].text).toContain("não disse nada por voz");
  });

  it("starts without the pane's conversation when its transcript or profile is not the app's", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ transport: { sdp: "answer" } }), { status: 201 }),
    );
    const { service } = createService([], { fetch: fetchImpl });

    const missing = await service.createSession({
      sdp: "offer",
      cwd: project,
      agent: "claude",
      paneConversation: {
        agent: "claude",
        sessionId: "11111111-2222-3333-4444-555555555555",
        claudeConfigDir: profileDir,
      },
    });
    expect(missing.paneConversation).toBeNull();

    const outside = await service.createSession({
      sdp: "offer",
      cwd: project,
      agent: "claude",
      paneConversation: {
        agent: "claude",
        sessionId: "11111111-2222-3333-4444-555555555555",
        claudeConfigDir: path.join(home, ".claude"),
      },
    });
    expect(outside.paneConversation).toBeNull();
    for (const call of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(call[1].body)).session.input).toHaveLength(1);
    }
  });

  it("warns when the terminal sits in the home folder instead of a project", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ transport: { sdp: "answer" } }), { status: 201 }),
    );
    const { service } = createService([], { fetch: fetchImpl });

    const answer = await service.createSession({ sdp: "offer", cwd: home, agent: "claude" });

    expect(answer.warning).toBe(BROAD_FOLDER_WARNING);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.session.input[0].content[0].text).toContain("pasta pessoal");
  });

  it("leaves delegation out when the pane has no agent that reads code", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ transport: { sdp: "answer" } }), { status: 201 }),
    );
    const { service } = createService([], { fetch: fetchImpl });

    await service.createSession({ sdp: "offer", cwd: project, agent: null });

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.session.delegation).toBeUndefined();
    expect(body.session.instructions).toContain("não roda um agente de código");
  });

  it("asks for the OpenAI key before calling anything", async () => {
    const fetchImpl = vi.fn();
    const { service } = createService([], {
      fetch: fetchImpl,
      secrets: { get: async () => "  " },
    });

    await expect(
      service.createSession({ sdp: "offer", cwd: project, agent: "claude" }),
    ).rejects.toThrow(/chave da OpenAI/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the API's own error message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "model not available" } }), { status: 403 }),
    );
    const { service } = createService([], { fetch: fetchImpl });

    await expect(
      service.createSession({ sdp: "offer", cwd: project, agent: "codex" }),
    ).rejects.toThrow(/model not available/);
  });
});

describe("LiveBrainstormService.delegate", () => {
  it("runs Claude read-only on the pane's account and splits the answer", async () => {
    const { service, spawned } = createService([{ stdout: CLAUDE_OK }]);

    const progress = vi.fn();
    const result = await service.delegate(7, claudeInput(), progress);

    expect(result).toEqual({
      summary: "O upload vai em multipart para a OpenAI.",
      details: "- `voice-service.ts` monta o FormData.",
      agentSessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783",
      costUsd: 0.2183,
      folder: null,
      model: "opus[1m]",
    });
    const [{ command, args, options, agent }] = spawned;
    expect(command).toBe("claude");
    // The pane's permissions and the pane's model, read from its profile.
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus[1m]",
    ]);
    expect(options.cwd).toBe(project);
    expect(options.shell).toBe(false);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
    // The prompt goes on stdin, never on the command line, and opens with the
    // marker that keeps the pane from adopting this transcript as its own.
    expect(agent.stdinText.startsWith(AGENT_PROMPT_MARKER)).toBe(true);
    expect(agent.stdinText).toContain("olha como o upload de voz funciona");
    expect(args.join(" ")).not.toContain("upload");
    // The session id arrives first, then each tool call as a readable step.
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { agentSessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783" },
      { text: 'buscando "FormData" no código, lendo voice-service.ts' },
    ]);
  });

  it("hands attached screenshots to the agent by path and refuses anything else", async () => {
    const shot = path.join(home, "shot.png");
    await writeFile(shot, "png");
    const { service, spawned } = createService([{ stdout: CLAUDE_OK }]);

    await service.delegate(7, claudeInput({ attachments: [shot] }));
    expect(spawned[0].agent.stdinText).toContain(shot);
    expect(spawned[0].agent.stdinText).toContain("anexou estas imagens");

    await expect(
      service.delegate(7, claudeInput({ delegationId: "item_2", attachments: [path.join(home, "notes.txt")] })),
    ).rejects.toThrow(/não é uma imagem/);
    await expect(
      service.delegate(7, claudeInput({ delegationId: "item_3", attachments: [path.join(home, "gone.png")] })),
    ).rejects.toThrow(/não foi encontrada/);
    expect(spawned).toHaveLength(1);
  });

  it("returns a folder the user asked to switch to only when it exists", async () => {
    const target = path.join(home, "lead-digital");
    await mkdir(target, { recursive: true });
    const found = JSON.stringify({
      type: "result",
      result: `RESUMO:\nAchei a pasta.\nDETALHES:\nPASTA: ${target}`,
      session_id: "04bb555b-b7ca-41bd-823f-468ff79b7783",
    });
    const missing = JSON.stringify({
      type: "result",
      result: `RESUMO:\nAchei.\nDETALHES:\nPASTA: ${path.join(home, "nope")}`,
    });
    const { service } = createService([{ stdout: found }, { stdout: missing }]);

    expect((await service.delegate(7, claudeInput())).folder).toBe(target);
    expect((await service.delegate(7, claudeInput({ delegationId: "item_2" }))).folder).toBeNull();
  });

  it("tells the agent it is continuing only when the brainstorm's own conversation resumes", async () => {
    const { service, spawned } = createService([{ stdout: CLAUDE_OK }, { stdout: CLAUDE_OK }]);

    await service.delegate(
      7,
      claudeInput({
        continuation: true,
        resume: { sessionId: "11111111-2222-3333-4444-555555555555", fork: true },
      }),
    );
    await service.delegate(
      7,
      claudeInput({
        delegationId: "item_2",
        continuation: true,
        resume: { sessionId: "11111111-2222-3333-4444-555555555555", fork: false },
      }),
    );

    expect(spawned[0].agent.stdinText).not.toContain("continuação da sua análise");
    expect(spawned[1].agent.stdinText).toContain("continuação da sua análise");
  });

  it("forks the pane's own conversation instead of writing into it", async () => {
    const { service, spawned } = createService([{ stdout: CLAUDE_OK }]);

    await service.delegate(
      7,
      claudeInput({ resume: { sessionId: "11111111-2222-3333-4444-555555555555", fork: true } }),
    );

    expect(spawned[0].args).toEqual(
      expect.arrayContaining([
        "--resume",
        "11111111-2222-3333-4444-555555555555",
        "--fork-session",
      ]),
    );
  });

  it("starts fresh when the conversation to continue is gone", async () => {
    const { service, spawned } = createService([
      { stdout: JSON.stringify({ is_error: true, result: "No conversation found" }), code: 1 },
      { stdout: CLAUDE_OK },
    ]);

    const result = await service.delegate(
      7,
      claudeInput({ resume: { sessionId: "11111111-2222-3333-4444-555555555555", fork: true } }),
    );

    expect(result.summary).toContain("multipart");
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).not.toContain("--resume");
  });

  it("looks a CLI up on the Windows PATH once per conversation", async () => {
    const resolveWindowsCommand = vi.fn(async () => ["C:\\bin\\claude.exe"]);
    const { service } = createService([{ stdout: CLAUDE_OK }, { stdout: CLAUDE_OK }], {
      platform: "win32",
      resolveWindowsCommand,
    });

    await service.delegate(7, claudeInput());
    await service.delegate(7, claudeInput({ delegationId: "item_2" }));

    expect(resolveWindowsCommand).toHaveBeenCalledTimes(1);
  });

  it("never runs Claude on a config dir outside the app's profiles", async () => {
    const { service, spawned } = createService([]);

    await expect(
      service.delegate(7, claudeInput({ claudeConfigDir: path.join(home, ".claude") })),
    ).rejects.toThrow(/claude-profiles/);
    await expect(
      service.delegate(7, claudeInput({ claudeConfigDir: undefined })),
    ).rejects.toThrow(/perfil Claude/);
    expect(spawned).toHaveLength(0);
  });

  it("leaves the model to the CLI when the profile does not name one", async () => {
    await rm(path.join(profileDir, "settings.json"));
    const { service, spawned } = createService([{ stdout: CLAUDE_OK }]);

    const result = await service.delegate(7, claudeInput());

    expect(spawned[0].args).not.toContain("--model");
    expect(result.model).toBeNull();
  });

  it("runs Codex with the pane's free hand and reads the JSONL events", async () => {
    const events = [
      { type: "thread.started", thread_id: "01a08d75-4a36-7bf1-bf1d-7c3e66ba3996" },
      { type: "item.completed", item: { type: "reasoning", text: "pensando" } },
      { type: "item.completed", item: { type: "agent_message", text: "RESUMO: Usa FormData.\nDETALHES:\nNo serviço." } },
      { type: "turn.completed" },
    ].map((event) => JSON.stringify(event)).join("\n");
    const { service, spawned } = createService([{ stdout: events }]);

    const result = await service.delegate(
      7,
      claudeInput({
        agent: "codex",
        claudeConfigDir: undefined,
        resume: { sessionId: "019a0000-0000-7000-8000-000000000001", fork: true },
      }),
    );

    expect(result).toEqual({
      summary: "Usa FormData.",
      details: "No serviço.",
      agentSessionId: "01a08d75-4a36-7bf1-bf1d-7c3e66ba3996",
      costUsd: null,
      folder: null,
      model: null,
    });
    expect(spawned[0].command).toBe("codex");
    expect(spawned[0].args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "fork",
      "019a0000-0000-7000-8000-000000000001",
      "-",
    ]);
    expect(spawned[0].options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("reports what Codex said when the turn fails", async () => {
    const events = [
      { type: "thread.started", thread_id: "01a08d75-4a36-7bf1-bf1d-7c3e66ba3996" },
      { type: "error", message: "You've hit your usage limit." },
      { type: "turn.failed", error: { message: "You've hit your usage limit." } },
    ].map((event) => JSON.stringify(event)).join("\n");
    const { service } = createService([{ stdout: events, code: 1 }]);

    await expect(
      service.delegate(7, claudeInput({ agent: "codex", claudeConfigDir: undefined })),
    ).rejects.toThrow("Codex: You've hit your usage limit.");
  });

  it("starts Cursor's own node on Windows, unrestricted, with the prompt as an argument", async () => {
    const base = path.join(home, "cursor-agent");
    await mkdir(path.join(base, "versions", "2026.1.5-abc123"), { recursive: true });
    await mkdir(path.join(base, "versions", "2026.3.2-10-00-00-def456"), { recursive: true });
    await mkdir(path.join(base, "versions", "tmp"), { recursive: true });
    const { service, spawned } = createService(
      [{ stdout: JSON.stringify({ type: "result", result: "Porta 4321.", session_id: "1f40756d-f41e-46c0-aac3-1f606c01ab79" }) }],
      {
        platform: "win32",
        resolveWindowsCommand: async (name) =>
          name === "cursor-agent" ? [path.join(base, "cursor-agent.cmd")] : [],
      },
    );

    const result = await service.delegate(
      7,
      claudeInput({
        agent: "cursor",
        claudeConfigDir: undefined,
        // A fork would have to resume the pane's chat: it is dropped.
        resume: { sessionId: "1f40756d-f41e-46c0-aac3-1f606c01ab79", fork: true },
      }),
    );

    expect(result.summary).toBe("Porta 4321.");
    const newest = path.join(base, "versions", "2026.3.2-10-00-00-def456");
    const [{ command, args, options, agent }] = spawned;
    expect(command).toBe(path.join(newest, "node.exe"));
    expect(args.slice(0, 6)).toEqual([
      path.join(newest, "index.js"),
      "-p",
      "--force",
      "--trust",
      "--output-format",
      "json",
    ]);
    expect(args).not.toContain("--resume");
    expect(args.at(-1)).toContain("olha como o upload de voz funciona");
    expect(options.shell).toBe(false);
    expect(options.env.CURSOR_INVOKED_AS).toBe("cursor-agent");
    expect(agent.stdinText).toBe("");
  });

  it("prefers the native executable on Windows and only shells out to a .cmd shim with fixed flags", async () => {
    const exe = createService([{ stdout: CLAUDE_OK }], {
      platform: "win32",
      resolveWindowsCommand: async () => ["C:\\bin\\claude", "C:\\bin\\claude.exe"],
    });
    await exe.service.delegate(7, claudeInput());
    expect(exe.spawned[0].command).toBe("C:\\bin\\claude.exe");
    expect(exe.spawned[0].options.shell).toBe(false);

    const shim = createService([{ stdout: CLAUDE_OK }], {
      platform: "win32",
      resolveWindowsCommand: async () => ["C:\\npm global\\claude.cmd"],
    });
    await shim.service.delegate(7, claudeInput());
    expect(shim.spawned[0].command).toBe('"C:\\npm global\\claude.cmd"');
    expect(shim.spawned[0].options.shell).toBe(true);
  });

  it("cancels a running analysis for its owner only", async () => {
    const { service, spawned } = createService([{ hang: true }]);

    const pending = service.delegate(7, claudeInput());
    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    await service.cancelDelegation(8, "item_1");
    expect(spawned[0].agent.kill).not.toHaveBeenCalled();

    await service.cleanup(7);
    await expect(pending).rejects.toThrow("Análise cancelada.");
    expect(spawned[0].agent.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("interrupts an analysis that runs past the limit", async () => {
    const { service, spawned } = createService([{ hang: true }], { delegationTimeoutMs: 20 });

    await expect(service.delegate(7, claudeInput())).rejects.toThrow(/interrompido/);
    expect(spawned[0].agent.kill).toHaveBeenCalled();
  });

  it("refuses a folder that does not exist", async () => {
    const { service, spawned } = createService([]);

    await expect(
      service.delegate(7, claudeInput({ cwd: path.join(home, "missing") })),
    ).rejects.toThrow(/Pasta do terminal/);
    expect(spawned).toHaveLength(0);
  });
});

describe("buildPaneConversationNote", () => {
  it("keeps the newest messages that fit and says how many were left out", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `mensagem ${index} ${"y".repeat(300)}`,
    }));
    const note = buildPaneConversationNote({ title: null, messages }, "codex", 1_000);

    expect(note).not.toBeNull();
    // Each line runs ~320 chars: three fit the budget, the older three do not.
    expect(note).toContain("Codex: mensagem 5");
    expect(note).toContain("Usuário: mensagem 4");
    expect(note).toContain("Codex: mensagem 3");
    expect(note).not.toContain("mensagem 2");
    expect(note).toContain("3 mensagens anteriores ficaram de fora");
    expect(buildPaneConversationNote({ title: null, messages: [] }, "codex", 1_000)).toBeNull();
  });
});

describe("agent answers", () => {
  it("falls back to the first real paragraph when the format was ignored", () => {
    expect(
      splitAgentAnswer("> Auto routed to Cursor Grok\n\nA porta é **4321**.\n\nMais contexto."),
    ).toEqual({
      summary: "A porta é 4321.",
      details: "> Auto routed to Cursor Grok\n\nA porta é **4321**.\n\nMais contexto.",
      folder: null,
    });
  });

  it("keeps the spoken summary within one GPT-Live append", () => {
    const { summary } = splitAgentAnswer(`RESUMO: ${"a".repeat(3_000)}\nDETALHES: x`);
    expect(summary.length).toBeLessThanOrEqual(1_000);
  });

  it("reads the folder line out of the details", () => {
    expect(
      splitAgentAnswer("RESUMO: Achei.\nDETALHES:\nA pasta fica em:\nPASTA: `C:\\dev\\lead`\nFim."),
    ).toMatchObject({ folder: "C:\\dev\\lead" });
  });

  it("turns streamed CLI events into steps and ignores the rest", () => {
    expect(describeAgentEvent("claude", CLAUDE_INIT)).toEqual({
      agentSessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783",
    });
    expect(describeAgentEvent("claude", CLAUDE_RESULT)).toBeNull();
    expect(
      describeAgentEvent(
        "claude",
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "gpt-live-1" } }] },
        }),
      ),
    ).toEqual({ text: "pesquisando na web: gpt-live-1" });
    expect(
      describeAgentEvent(
        "codex",
        JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "rg FormData" } }),
      ),
    ).toEqual({ text: "rodando rg FormData" });
    expect(
      describeAgentEvent("codex", JSON.stringify({ type: "thread.started", thread_id: "01a08d75-4a36-7bf1-bf1d-7c3e66ba3996" })),
    ).toEqual({ agentSessionId: "01a08d75-4a36-7bf1-bf1d-7c3e66ba3996" });
    expect(describeAgentEvent("claude", "not json")).toBeNull();
  });

  it("explains an empty answer with stderr, minus Codex's housekeeping logs", () => {
    expect(
      parseAgentReply(
        "codex",
        "",
        "2026-09-10T22:34:29Z ERROR codex_skills_extension: noise\nError: thread/resume failed",
        1,
      ).error,
    ).toBe("Error: thread/resume failed");
    expect(parseAgentReply("claude", "", "", 2).error).toBe("saiu com código 2");
  });
});
