import { create } from "zustand";

import type {
  BrainstormAgent,
  LiveDelegationProgress,
  LiveHistoryMessage,
  LivePaneConversation,
  LiveSessionAnswer,
} from "../../electron/types/api";
import { reserveBackgroundAgentSession } from "./background-agent-sessions";
import {
  appendTranscriptDelta,
  formatTranscript,
  lastUserText,
  transcriptEndMs,
  type BrainstormRole,
  type BrainstormTurn,
} from "./brainstorm-transcript";
import { resolveClaudeConfigDir } from "./claude-accounts";
import { pickGitContextForSession } from "./git-context-utils";
import { logEvent } from "./logger";
import { hasOpenAiApiKey } from "./openai-credentials";
import { basenamePath } from "./path-utils";
import { useSessionStore } from "./session-manager";
import { collectPaneIds, resolvePaneCwd } from "./session-layout";
import { beep } from "./voice-input";

/**
 * Voice brainstorm (F10). GPT-Live talks with the user over WebRTC; when a
 * request needs the project, it delegates and this module runs the pane's own
 * agent — same CLI, same account, same folder, same model, same permissions —
 * through the main process, streams the agent's steps back, then hands the
 * answer to GPT-Live to speak.
 *
 * The voice session bills by the second whether anyone talks or not, so while
 * the agent works the session is closed ("paused") and a new one is opened,
 * seeded with the conversation so far, when the result arrives or the user
 * asks for the voice back.
 */

export type BrainstormStatus =
  | "idle"
  | "connecting"
  | "live"
  | "paused"
  | "closing"
  | "ended"
  | "error";

export type BrainstormTaskStatus = "running" | "done" | "failed" | "cancelled";

export interface BrainstormTask {
  id: string;
  status: BrainstormTaskStatus;
  /** What the user asked, as transcribed. */
  request: string;
  /** The conversation excerpt the agent received. */
  transcriptSent: string;
  /** Images handed to the agent with this task. */
  attachments: string[];
  /** Steps the agent reported while working, oldest first. */
  steps: string[];
  summary?: string;
  details?: string;
  error?: string;
  costUsd?: number | null;
  model?: string | null;
  startedAt: number;
  finishedAt?: number;
}

/** What the voice was told of the pane's own agent conversation. */
export interface BrainstormPaneConversation {
  messages: number;
  title: string | null;
}

interface BrainstormState {
  status: BrainstormStatus;
  paneId: string | null;
  cwd: string | null;
  agent: BrainstormAgent | null;
  /** null while unknown or when the pane had no conversation to pick up. */
  paneConversation: BrainstormPaneConversation | null;
  turns: BrainstormTurn[];
  tasks: BrainstormTask[];
  /** Images waiting for the next analysis. */
  attachments: string[];
  muted: boolean;
  /** Close the voice session while the agent works; reopen with the result. */
  pauseWhileWorking: boolean;
  /** Billable seconds of voice so far, summed over the sessions of this brainstorm. */
  usageSeconds: number;
  /** Something about the folder worth reading before speaking. */
  warning: string | null;
  error: string | null;
}

const INITIAL_STATE: BrainstormState = {
  status: "idle",
  paneId: null,
  cwd: null,
  agent: null,
  paneConversation: null,
  turns: [],
  tasks: [],
  attachments: [],
  muted: false,
  pauseWhileWorking: true,
  usageSeconds: 0,
  warning: null,
  error: null,
};

export const useBrainstormStore = create<BrainstormState>(() => INITIAL_STATE);

const AGENT_LABELS: Record<BrainstormAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent",
};

export function brainstormAgentLabel(agent: BrainstormAgent | null): string {
  return agent ? AGENT_LABELS[agent] : "sem agente de código";
}

/** US$ per minute of an open GPT-Live session. */
export const LIVE_RATE_USD_PER_MINUTE = 0.05;

/**
 * The delegation arrives while the transcript of what triggered it is still
 * streaming in. Wait for the user's fragments to go quiet, but never long.
 */
const TRANSCRIPT_QUIET_MS = 500;
const TRANSCRIPT_QUIET_MAX_MS = 2_000;
const TRANSCRIPT_POLL_MS = 100;
/** Deltas arrive many times a second; one store update per frame is plenty. */
const DELTA_FLUSH_MS = 40;
const ICE_GATHERING_TIMEOUT_MS = 2_000;
const SESSION_START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 3_000;
/** Room for the model to say "vou pedir para o Claude verificar" before the pause. */
const PAUSE_GRACE_MS = 3_500;
const MAX_TURNS = 400;
const MAX_STEPS = 60;
const MAX_ATTACHMENTS = 8;
const SPOKEN_ERROR_MAX_CHARS = 400;
const RESUME_NOTE_MAX_CHARS = 3_000;
/** Quiet progress goes to GPT-Live at most this often. */
const PROGRESS_APPEND_MIN_MS = 5_000;
/** After this long the model says out loud that the analysis is still running. */
const SPOKEN_PROGRESS_AFTER_MS = 45_000;
const ERROR_FLASH_MS = 8_000;
/** An append the API rejects is resent once, shorter. */
const APPEND_RETRY_MIN_CHARS = 200;

type AppendType =
  | "session.commentary.append"
  | "session.thinking.append"
  | "session.instructions.append";

interface PendingAppend {
  type: AppendType;
  delegationId: string | null;
  content: string;
  retried: boolean;
}

/** One GPT-Live session: microphone, speaker and the event channel. */
interface LiveConnection {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  stream: MediaStream;
  audio: HTMLAudioElement;
  /** Wall-clock time the last user fragment arrived. */
  lastUserDeltaAt: number;
  pendingDeltas: Array<{ role: BrainstormRole; delta: string; startMs?: number; endMs?: number }>;
  deltaFlush: ReturnType<typeof setTimeout> | null;
  pendingAppends: Map<string, PendingAppend>;
  lastProgressAppendAt: number;
  /** Seconds this session has billed so far, per GPT-Live. */
  usageSeconds: number;
  /** Microphone and speaker levels for the orb; null until the audio graph exists. */
  meter: AudioMeter | null;
  closed: boolean;
  onSessionStarted?: () => void;
  onSessionClosed?: () => void;
}

/** One brainstorm: outlives its voice sessions, ends on F10 or the panel's X. */
interface Brainstorm {
  paneId: string;
  cwd: string;
  agent: BrainstormAgent | null;
  branch: string | null;
  claudeConfigDir?: string;
  /** The pane's own agent conversation; the first delegation forks it. */
  paneSessionId?: string;
  /** The brainstorm's own agent conversation, once a delegation made one. */
  agentSessionId: string | null;
  /** Timeline point the agent has already heard the conversation up to. */
  transcriptSentUpToMs: number | null;
  /** Delegations run one at a time, each resuming where the last one left off. */
  queue: Promise<void>;
  /** The delegation currently holding the agent; a new one supersedes it. */
  runningDelegationId: string | null;
  connection: LiveConnection | null;
  /** Spoken results that arrived while the voice was paused. */
  pendingResults: string[];
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /** Voice seconds billed by sessions that already closed. */
  closedUsageSeconds: number;
  ended: boolean;
}

interface PaneContext {
  cwd: string;
  agent: BrainstormAgent | null;
  claudeConfigDir?: string;
  paneSessionId?: string;
  branch: string | null;
}

interface ServerEvent {
  type?: unknown;
  delta?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  reason?: unknown;
  client_event_id?: unknown;
  delegation?: { id?: unknown; target?: unknown };
  usage?: { seconds?: unknown };
  error?: { code?: unknown; message?: unknown; client_event_id?: unknown };
}

let brainstorm: Brainstorm | null = null;
let eventCounter = 0;
let progressUnsubscribe: (() => void) | null = null;
let errorFlashTimer: ReturnType<typeof setTimeout> | null = null;

function nextEventId(): string {
  eventCounter += 1;
  return `ht_${Date.now().toString(36)}_${eventCounter}`;
}

/** `ipcRenderer.invoke` wraps every rejection in "Error invoking remote method ...". */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(status: BrainstormStatus): void {
  useBrainstormStore.setState({ status });
}

function updateTask(id: string, patch: Partial<BrainstormTask>): void {
  useBrainstormStore.setState((state) => ({
    tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
  }));
}

function taskById(id: string): BrainstormTask | undefined {
  return useBrainstormStore.getState().tasks.find((task) => task.id === id);
}

function runningTasks(): BrainstormTask[] {
  return useBrainstormStore.getState().tasks.filter((task) => task.status === "running");
}

function liveConnection(bs: Brainstorm): LiveConnection | null {
  const connection = bs.connection;
  return connection && !connection.closed && connection.channel.readyState === "open"
    ? connection
    : null;
}

function send(connection: LiveConnection, event: Record<string, unknown>): string | null {
  if (connection.closed || connection.channel.readyState !== "open") return null;
  const eventId = nextEventId();
  connection.channel.send(JSON.stringify({ event_id: eventId, ...event }));
  return eventId;
}

/** Content for the model, tracked so a rejected append can be retried shorter. */
function append(
  connection: LiveConnection,
  type: AppendType,
  delegationId: string | null,
  content: string,
  retried = false,
): void {
  const eventId = send(connection, { type, delegation_id: delegationId, content });
  if (eventId) connection.pendingAppends.set(eventId, { type, delegationId, content, retried });
}

/** Same as `append`, for callers that may run while the voice is paused. */
function appendIfLive(
  bs: Brainstorm,
  type: AppendType,
  delegationId: string | null,
  content: string,
): boolean {
  const connection = liveConnection(bs);
  if (!connection) return false;
  append(connection, type, delegationId, content);
  return true;
}

function fail(message: string): void {
  useBrainstormStore.setState({ status: "error", error: message });
  logEvent("warn", "brainstorm.failed", { message });
}

/** A rejected command or a moderation cut, not a dead session: show, then let it go. */
function flashError(message: string): void {
  useBrainstormStore.setState({ error: message });
  if (errorFlashTimer) clearTimeout(errorFlashTimer);
  errorFlashTimer = setTimeout(() => {
    errorFlashTimer = null;
    if (useBrainstormStore.getState().error === message) {
      useBrainstormStore.setState({ error: null });
    }
  }, ERROR_FLASH_MS);
}

function resolvePaneContext(paneId: string): PaneContext {
  const state = useSessionStore.getState();
  const session = state.sessions.find((candidate) =>
    collectPaneIds(candidate.layout).includes(paneId),
  );
  if (!session) throw new Error("Terminal não encontrado.");

  const profile = session.agentProfileId;
  const agent =
    profile === "claude" || profile === "codex" || profile === "cursor" ? profile : null;
  const git = pickGitContextForSession(
    session.id,
    collectPaneIds(session.layout),
    state.paneGitContext,
    state.sessionGitContext,
    { activePaneId: paneId, isActiveSession: true },
  );
  return {
    cwd: resolvePaneCwd(session, paneId),
    agent,
    // The pane's account, never the CLI's global ~/.claude.
    claudeConfigDir:
      agent === "claude" ? resolveClaudeConfigDir(session.claudeAccountId) : undefined,
    // Cursor cannot fork a chat, and resuming the pane's would write into it
    // while the pane's own Cursor is still using it.
    paneSessionId:
      agent === "claude" || agent === "codex"
        ? (state.paneResumeAnchors[paneId] ?? state.paneResumeSessionIds[paneId])
        : undefined,
    branch: git?.branch ?? null,
  };
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timeout);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    // Host candidates are enough; a slow STUN probe must not hold the call.
    const timeout = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function waitForSessionStart(connection: LiveConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("A OpenAI não iniciou a conversa a tempo.")),
      SESSION_START_TIMEOUT_MS,
    );
    connection.onSessionStarted = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

function closeReasonMessage(reason: unknown): string | null {
  switch (reason) {
    case undefined:
    case "close_requested":
      return null;
    case "expired":
      return "A conversa atingiu o tempo máximo de uma sessão de voz.";
    case "connection_lost":
      return "A conexão de voz caiu.";
    case "content":
      return "A OpenAI encerrou a conversa pela política de conteúdo.";
    case "remote_hangup":
      return "A OpenAI encerrou a conversa.";
    default:
      return `Conversa encerrada (${String(reason)}).`;
  }
}

/** Releases one voice session's microphone, speaker and peer connection. */
/** Web Audio taps on both sides of the call, read by the orb once a frame. */
interface AudioMeter {
  context: AudioContext;
  analysers: AnalyserNode[];
  samples: Uint8Array<ArrayBuffer>;
}

function createMeter(stream: MediaStream): AudioMeter | null {
  try {
    const context = new AudioContext();
    const meter: AudioMeter = { context, analysers: [], samples: new Uint8Array(256) };
    tapStream(meter, stream);
    return meter;
  } catch {
    return null;
  }
}

function tapStream(meter: AudioMeter, stream: MediaStream): void {
  try {
    const analyser = meter.context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    meter.context.createMediaStreamSource(stream).connect(analyser);
    meter.analysers.push(analyser);
  } catch {
    // No level for this side; the orb just breathes on its own.
  }
}

/**
 * Loudness of whoever is talking right now, 0..1. Zero while the voice is not
 * live, so the orb can settle. Called from an animation frame, never stored.
 */
export function readBrainstormAudioLevel(): number {
  const meter = brainstorm?.connection?.meter;
  if (!meter || brainstorm?.connection?.closed) return 0;
  let peak = 0;
  for (const analyser of meter.analysers) {
    analyser.getByteTimeDomainData(meter.samples);
    let sum = 0;
    for (const sample of meter.samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    peak = Math.max(peak, Math.sqrt(sum / meter.samples.length));
  }
  // Speech RMS sits around 0.05-0.3; stretch it so the orb visibly reacts.
  return Math.min(1, peak * 4);
}

function releaseConnection(bs: Brainstorm, connection: LiveConnection): void {
  if (connection.closed) return;
  connection.closed = true;
  if (connection.meter) {
    void connection.meter.context.close().catch(() => undefined);
    connection.meter = null;
  }
  if (connection.deltaFlush) clearTimeout(connection.deltaFlush);
  flushDeltas(connection, true);
  connection.pendingAppends.clear();
  bs.closedUsageSeconds += connection.usageSeconds;
  if (bs.connection === connection) bs.connection = null;

  try {
    connection.channel.close();
  } catch {
    // Already closed.
  }
  try {
    connection.pc.close();
  } catch {
    // Already closed.
  }
  // The OS microphone indicator must not outlive the conversation.
  for (const track of connection.stream.getTracks()) track.stop();
  connection.audio.srcObject = null;
  useBrainstormStore.setState({ muted: false });
}

/** The whole brainstorm is over: analyses stop, the voice closes, the panel shows why. */
function endBrainstorm(bs: Brainstorm, error: string | null): void {
  if (bs.ended) return;
  bs.ended = true;
  if (brainstorm === bs) brainstorm = null;
  if (bs.pauseTimer) clearTimeout(bs.pauseTimer);

  for (const task of runningTasks()) {
    void window.headTerminal.live.cancelDelegation(task.id).catch(() => undefined);
    updateTask(task.id, {
      status: "cancelled",
      error: "Cancelada: a conversa terminou.",
      finishedAt: Date.now(),
    });
  }
  if (bs.connection) releaseConnection(bs, bs.connection);

  useBrainstormStore.setState({
    status: error ? "error" : "ended",
    error,
    usageSeconds: bs.closedUsageSeconds,
  });
  logEvent("info", "brainstorm.ended", {
    paneId: bs.paneId,
    error,
    usageSeconds: bs.closedUsageSeconds,
  });
}

/** The API ended the session on its own: a real end, unless the agent is mid-task. */
function onSessionLost(bs: Brainstorm, connection: LiveConnection, error: string | null): void {
  if (bs.connection !== connection) return;
  releaseConnection(bs, connection);
  if (error && runningTasks().length > 0) {
    // The analysis outlives the call; the voice comes back with the result.
    setStatus("paused");
    flashError(error);
    return;
  }
  endBrainstorm(bs, error);
}

function flushDeltas(connection: LiveConnection, force = false): void {
  connection.deltaFlush = null;
  if (connection.pendingDeltas.length === 0) return;
  if (connection.closed && !force) return;
  const batch = connection.pendingDeltas;
  connection.pendingDeltas = [];
  useBrainstormStore.setState((state) => {
    let turns = state.turns;
    for (const { role, delta, startMs, endMs } of batch) {
      turns = appendTranscriptDelta(turns, role, delta, { startMs, endMs }, MAX_TURNS);
    }
    return { turns };
  });
}

function queueDelta(
  connection: LiveConnection,
  role: BrainstormRole,
  delta: string,
  startMs: number | undefined,
  endMs: number | undefined,
): void {
  connection.pendingDeltas.push({ role, delta, startMs, endMs });
  if (role === "user") connection.lastUserDeltaAt = Date.now();
  connection.deltaFlush ??= setTimeout(() => flushDeltas(connection), DELTA_FLUSH_MS);
}

/** The user's last fragments are still arriving when the delegation lands. */
async function waitForTranscriptQuiet(connection: LiveConnection): Promise<void> {
  const deadline = Date.now() + TRANSCRIPT_QUIET_MAX_MS;
  // With no user fragment yet, give the first one a moment to show up.
  if (connection.lastUserDeltaAt === 0) connection.lastUserDeltaAt = Date.now();
  while (Date.now() < deadline && !connection.closed) {
    if (Date.now() - connection.lastUserDeltaAt >= TRANSCRIPT_QUIET_MS) break;
    await sleep(TRANSCRIPT_POLL_MS);
  }
  flushDeltas(connection);
}

function handleProgress(bs: Brainstorm, event: LiveDelegationProgress): void {
  const task = taskById(event.delegationId);
  if (!task || task.status !== "running") return;

  if (event.agentSessionId) {
    // Reserved now so the pane never adopts it; continued from only on success.
    reserveBackgroundAgentSession(event.agentSessionId);
  }
  if (!event.text) return;

  const steps = [...task.steps, event.text].slice(-MAX_STEPS);
  updateTask(task.id, { steps });

  const connection = liveConnection(bs);
  if (!connection) return;
  const now = Date.now();
  if (now - connection.lastProgressAppendAt >= PROGRESS_APPEND_MIN_MS) {
    connection.lastProgressAppendAt = now;
    append(
      connection,
      "session.thinking.append",
      task.id,
      `Andamento da análise: ${event.text}. Ainda sem resultado.`,
    );
  }
}

/** The user asked to work somewhere else and the agent found the folder. */
function switchFolder(bs: Brainstorm, folder: string): void {
  if (folder === bs.cwd) return;
  bs.cwd = folder;
  // A new folder is a new project: the agent starts a conversation there.
  bs.agentSessionId = null;
  bs.paneSessionId = undefined;
  bs.transcriptSentUpToMs = null;
  useBrainstormStore.setState({ cwd: folder, warning: null });
  const name = basenamePath(folder, folder);
  appendIfLive(
    bs,
    "session.instructions.append",
    null,
    `A pasta do projeto agora é "${name}" (${folder}). Trate este como o projeto da conversa daqui em diante; a próxima análise já roda nela.`,
  );
  logEvent("info", "brainstorm.folder_changed", { paneId: bs.paneId, folder });
}

/** Speaks a result now, or keeps it for the session that resumes the voice. */
function deliverResult(bs: Brainstorm, delegationId: string, spoken: string): void {
  if (appendIfLive(bs, "session.commentary.append", delegationId, spoken)) return;
  bs.pendingResults.push(spoken);
  if (
    !bs.ended
    && useBrainstormStore.getState().status === "paused"
    && runningTasks().length === 0
  ) {
    void resumeVoice(bs, "result");
  }
}

/** Close the voice while the agent works; it comes back with the result. */
function scheduleWorkPause(bs: Brainstorm): void {
  if (!useBrainstormStore.getState().pauseWhileWorking || bs.pauseTimer) return;
  bs.pauseTimer = setTimeout(() => {
    bs.pauseTimer = null;
    const connection = liveConnection(bs);
    if (!connection || bs.ended || runningTasks().length === 0) return;
    if (useBrainstormStore.getState().status !== "live") return;
    void pauseVoice(bs, connection);
  }, PAUSE_GRACE_MS);
}

async function pauseVoice(bs: Brainstorm, connection: LiveConnection): Promise<void> {
  setStatus("paused");
  logEvent("info", "brainstorm.paused", { paneId: bs.paneId });
  await closeGracefully(connection);
  releaseConnection(bs, connection);
  beep(660);
}

/** `session.closed` carries the final usage; the peer connection stays up until then. */
function closeGracefully(connection: LiveConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    connection.onSessionClosed = () => {
      clearTimeout(timeout);
      resolve();
    };
    if (!send(connection, { type: "session.close" })) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function delegate(bs: Brainstorm, connection: LiveConnection, delegationId: string): Promise<void> {
  const { agent } = bs;
  if (!agent) {
    append(
      connection,
      "session.commentary.append",
      delegationId,
      "Este terminal não roda um agente de código, então não dá para analisar a pasta. Siga a conversa sem a análise.",
    );
    return;
  }

  const label = AGENT_LABELS[agent];

  // A new request while the agent is still on the previous one: the newer
  // one wins, and its transcript covers both.
  const previous = bs.runningDelegationId;
  if (previous && taskById(previous)?.status === "running") {
    void window.headTerminal.live.cancelDelegation(previous).catch(() => undefined);
    updateTask(previous, {
      status: "cancelled",
      error: "Substituída pelo pedido seguinte.",
      finishedAt: Date.now(),
    });
    append(
      connection,
      "session.thinking.append",
      previous,
      "A análise anterior foi cancelada porque um pedido novo chegou; a nova análise cobre os dois.",
    );
  }
  bs.runningDelegationId = delegationId;

  useBrainstormStore.setState((state) => ({
    tasks: [
      ...state.tasks,
      {
        id: delegationId,
        status: "running",
        request: "",
        transcriptSent: "",
        attachments: state.attachments,
        steps: [],
        startedAt: Date.now(),
      },
    ],
    // Images ride along with the next analysis, once.
    attachments: [],
  }));

  // Nothing in the delegation says what to investigate: it is whatever the
  // user just said, and that transcript may still be arriving.
  await waitForTranscriptQuiet(connection);
  if (bs.ended) return;
  const { turns } = useBrainstormStore.getState();
  // A continued agent conversation already heard everything up to the last
  // delegation; only what came after is news to it.
  const sinceMs = bs.agentSessionId ? bs.transcriptSentUpToMs : null;
  let transcript = formatTranscript(turns, { sinceMs });
  let continuation = sinceMs !== null;
  if (!transcript.trim()) {
    transcript = formatTranscript(turns);
    continuation = false;
  }
  const sentUpToMs = transcriptEndMs(turns);
  const task = taskById(delegationId);
  const attachments = task?.attachments ?? [];
  updateTask(delegationId, { request: lastUserText(turns), transcriptSent: transcript });

  if (useBrainstormStore.getState().pauseWhileWorking) {
    append(
      connection,
      "session.instructions.append",
      null,
      `Diga em uma frase que vai pausar a voz enquanto o ${label} trabalha e que volta sozinha com o resultado. Depois fique em silêncio.`,
    );
    scheduleWorkPause(bs);
  }

  const run = bs.queue.then(async () => {
    if (bs.ended || taskById(delegationId)?.status !== "running") return;
    appendIfLive(
      bs,
      "session.thinking.append",
      delegationId,
      `O ${label} começou a trabalhar na pasta "${basenamePath(bs.cwd, bs.cwd)}". Leva de alguns segundos a alguns minutos; os passos e o resultado chegam por aqui.`,
    );
    if (bs.connection) bs.connection.lastProgressAppendAt = Date.now();
    const spokenProgress = setTimeout(() => {
      const current = taskById(delegationId);
      if (bs.ended || current?.status !== "running") return;
      const lastStep = current.steps.at(-1);
      appendIfLive(
        bs,
        "session.commentary.append",
        delegationId,
        lastStep
          ? `O ${label} ainda está trabalhando; o último passo foi ${lastStep}.`
          : `O ${label} ainda está trabalhando; ainda não tem resultado.`,
      );
    }, SPOKEN_PROGRESS_AFTER_MS);

    const resume = bs.agentSessionId
      ? { sessionId: bs.agentSessionId, fork: false }
      : bs.paneSessionId
        ? { sessionId: bs.paneSessionId, fork: true }
        : undefined;

    try {
      const result = await window.headTerminal.live.delegate({
        delegationId,
        agent,
        cwd: bs.cwd,
        transcript,
        continuation,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(bs.claudeConfigDir ? { claudeConfigDir: bs.claudeConfigDir } : {}),
        ...(resume ? { resume } : {}),
      });
      clearTimeout(spokenProgress);
      if (taskById(delegationId)?.status !== "running") return;
      if (result.agentSessionId) {
        // Never let the pane's anchor watcher adopt the brainstorm's transcript.
        reserveBackgroundAgentSession(result.agentSessionId);
        bs.agentSessionId = result.agentSessionId;
      }
      bs.transcriptSentUpToMs = sentUpToMs;
      updateTask(delegationId, {
        status: "done",
        summary: result.summary,
        details: result.details,
        costUsd: result.costUsd ?? null,
        model: result.model ?? null,
        finishedAt: Date.now(),
      });
      if (result.folder) switchFolder(bs, result.folder);
      deliverResult(
        bs,
        delegationId,
        result.folder
          ? `${result.summary} A pasta de trabalho agora é "${basenamePath(result.folder, result.folder)}".`
          : `Resultado do ${label}: ${result.summary}`,
      );
      logEvent("info", "brainstorm.delegation_done", {
        delegationId,
        agent,
        model: result.model ?? null,
        costUsd: result.costUsd ?? null,
        durationMs: Date.now() - (taskById(delegationId)?.startedAt ?? Date.now()),
      });
    } catch (error) {
      clearTimeout(spokenProgress);
      const current = taskById(delegationId);
      if (current?.status !== "running") return;
      const reason = errorText(error).slice(0, SPOKEN_ERROR_MAX_CHARS);
      updateTask(delegationId, { status: "failed", error: reason, finishedAt: Date.now() });
      deliverResult(bs, delegationId, `A análise do ${label} falhou: ${reason}`);
      logEvent("warn", "brainstorm.delegation_failed", { delegationId, agent, message: reason });
    } finally {
      if (bs.runningDelegationId === delegationId) bs.runningDelegationId = null;
    }
  });
  bs.queue = run.catch(() => undefined);
  await run;
}

function handleAppendError(connection: LiveConnection, event: ServerEvent): boolean {
  const clientEventId = event.error?.client_event_id ?? event.client_event_id;
  if (typeof clientEventId !== "string") return false;
  const pending = connection.pendingAppends.get(clientEventId);
  if (!pending) return false;
  connection.pendingAppends.delete(clientEventId);
  // Most likely too long for one append: half of it still carries the point.
  if (!pending.retried && pending.content.length >= APPEND_RETRY_MIN_CHARS) {
    const half = Math.floor(pending.content.length / 2);
    append(
      connection,
      pending.type,
      pending.delegationId,
      `${pending.content.slice(0, half).trimEnd()}…`,
      true,
    );
    logEvent("info", "brainstorm.append_retried", { type: pending.type });
    return true;
  }
  return false;
}

function handleServerEvent(bs: Brainstorm, connection: LiveConnection, raw: unknown): void {
  if (connection.closed || typeof raw !== "string") return;
  let event: ServerEvent;
  try {
    event = JSON.parse(raw) as ServerEvent;
  } catch {
    return;
  }

  switch (event.type) {
    case "session.started":
      connection.onSessionStarted?.();
      break;
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (typeof event.delta === "string" && event.delta) {
        queueDelta(
          connection,
          event.type === "session.input_transcript.delta" ? "user" : "assistant",
          event.delta,
          typeof event.start_ms === "number" ? event.start_ms : undefined,
          typeof event.end_ms === "number" ? event.end_ms : undefined,
        );
      }
      break;
    case "session.delegation.created":
      if (event.delegation?.target === "client" && typeof event.delegation.id === "string") {
        void delegate(bs, connection, event.delegation.id);
      }
      break;
    case "session.commentary.appended":
    case "session.thinking.appended":
    case "session.instructions.appended":
      if (typeof event.client_event_id === "string") {
        connection.pendingAppends.delete(event.client_event_id);
      }
      break;
    case "session.usage.updated":
      if (typeof event.usage?.seconds === "number") {
        connection.usageSeconds = event.usage.seconds;
        useBrainstormStore.setState({
          usageSeconds: bs.closedUsageSeconds + connection.usageSeconds,
        });
      }
      break;
    case "session.input_audio.muted":
      useBrainstormStore.setState({ muted: true });
      break;
    case "session.input_audio.unmuted":
      useBrainstormStore.setState({ muted: false });
      break;
    case "error":
      // A rejected command or a moderation cut, not a dead session.
      logEvent("warn", "brainstorm.server_error", {
        code: event.error?.code,
        message: event.error?.message,
        clientEventId: event.error?.client_event_id,
      });
      if (!handleAppendError(connection, event) && typeof event.error?.message === "string") {
        flashError(event.error.message);
      }
      break;
    case "session.closed":
      connection.onSessionClosed?.();
      if (bs.connection === connection && useBrainstormStore.getState().status !== "paused") {
        onSessionLost(bs, connection, closeReasonMessage(event.reason));
      }
      break;
    default:
      break;
  }
}

function ensureProgressSubscription(): void {
  progressUnsubscribe ??= window.headTerminal.live.onDelegationProgress((event) => {
    if (brainstorm) handleProgress(brainstorm, event);
  });
}

interface OpenOptions {
  history?: LiveHistoryMessage[];
  resumeNote?: string | null;
  /** Spoken as soon as the session starts; may depend on what the session was seeded with. */
  opening: string | ((answer: LiveSessionAnswer) => string);
}

/** The pane's agent conversation the voice should pick up, when the pane has one. */
function paneConversationOf(bs: Brainstorm): LivePaneConversation | undefined {
  if (!bs.paneSessionId || (bs.agent !== "claude" && bs.agent !== "codex")) return undefined;
  return {
    agent: bs.agent,
    sessionId: bs.paneSessionId,
    ...(bs.claudeConfigDir ? { claudeConfigDir: bs.claudeConfigDir } : {}),
  };
}

/** Opens one voice session for the brainstorm; a pause closes it, a resume opens another. */
async function openVoice(bs: Brainstorm, options: OpenOptions): Promise<boolean> {
  setStatus("connecting");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // The model talks while it listens; without echo cancellation it hears itself.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const denied = (error as DOMException)?.name === "NotAllowedError";
    endBrainstorm(
      bs,
      denied
        ? "Acesso ao microfone negado. Libere o microfone para o aplicativo nas configurações do sistema."
        : "Não foi possível abrir o microfone.",
    );
    return false;
  }
  if (bs.ended) {
    for (const track of stream.getTracks()) track.stop();
    return false;
  }

  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  // Created before the offer so the SDP negotiates it.
  const channel = pc.createDataChannel("oai-events");
  const connection: LiveConnection = {
    pc,
    channel,
    stream,
    audio,
    lastUserDeltaAt: 0,
    pendingDeltas: [],
    deltaFlush: null,
    pendingAppends: new Map(),
    lastProgressAppendAt: 0,
    usageSeconds: 0,
    meter: createMeter(stream),
    closed: false,
  };
  bs.connection = connection;

  pc.ontrack = (event) => {
    const remote = event.streams[0] ?? new MediaStream([event.track]);
    audio.srcObject = remote;
    if (connection.meter) tapStream(connection.meter, remote);
  };
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
  channel.onmessage = (event) => handleServerEvent(bs, connection, event.data);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") onSessionLost(bs, connection, "A conexão de voz caiu.");
  };

  try {
    const started = waitForSessionStart(connection);
    // Awaited below; a failure before then must not surface as unhandled.
    started.catch(() => undefined);
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    const offer = pc.localDescription?.sdp;
    if (!offer) throw new Error("Não foi possível preparar a conexão de voz.");

    const paneConversation = paneConversationOf(bs);
    const answer = await window.headTerminal.live.createSession({
      sdp: offer,
      cwd: bs.cwd,
      agent: bs.agent,
      branch: bs.branch,
      ...(options.history ? { history: options.history } : {}),
      resumeNote: options.resumeNote ?? null,
      ...(paneConversation ? { paneConversation } : {}),
    });
    if (connection.closed || bs.ended) return false;
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await started;
    if (connection.closed || bs.ended) return false;

    useBrainstormStore.setState({
      status: "live",
      warning: answer.warning ?? null,
      paneConversation: answer.paneConversation ?? null,
    });
    append(
      connection,
      "session.instructions.append",
      null,
      typeof options.opening === "function" ? options.opening(answer) : options.opening,
    );
    // Results that landed while this session was being opened.
    for (const spoken of bs.pendingResults.splice(0)) {
      append(connection, "session.commentary.append", null, spoken);
    }
    beep(880);
    logEvent("info", "brainstorm.live", { paneId: bs.paneId, sessionId: answer.sessionId });
    return true;
  } catch (error) {
    releaseConnection(bs, connection);
    if (runningTasks().length > 0) {
      // The agent is still at work; the voice can be retried with F10.
      setStatus("paused");
      flashError(errorText(error));
      return false;
    }
    endBrainstorm(bs, errorText(error));
    return false;
  }
}

function historyFromTurns(turns: readonly BrainstormTurn[]): LiveHistoryMessage[] {
  return turns
    .map((turn) => ({ role: turn.role, text: turn.text.trim() }))
    .filter((turn) => turn.text);
}

/** Reopens the voice after a pause, with the conversation so far and whatever happened meanwhile. */
async function resumeVoice(bs: Brainstorm, trigger: "result" | "user"): Promise<void> {
  if (bs.ended || bs.connection) return;
  const label = brainstormAgentLabel(bs.agent);
  const results = bs.pendingResults.splice(0);
  const running = runningTasks().length;
  const notes: string[] = [];
  if (results.length > 0) {
    notes.push(
      `Enquanto a voz estava pausada, o ${label} terminou. ${results.join(" ")}`.slice(
        0,
        RESUME_NOTE_MAX_CHARS,
      ),
    );
  }
  if (running > 0) {
    notes.push(
      `O ${label} ainda está trabalhando em ${running === 1 ? "uma análise" : `${running} análises`}; o resultado chega quando terminar.`,
    );
  }
  if (trigger === "user") notes.push("O usuário reativou a voz por conta própria (F10).");
  const resumeNote = notes.join(" ");
  const opening =
    results.length > 0
      ? "Retome a conversa agora: diga em poucas frases o que a análise concluiu, conforme a nota do desenvolvedor, e pergunte o que o usuário quer fazer a seguir. Depois espere."
      : running > 0
        ? "Diga em uma frase que a voz está de volta e que o resultado chega quando o agente terminar; depois espere o usuário falar."
        : "Diga em poucas palavras que a voz está de volta e espere o usuário falar.";
  logEvent("info", "brainstorm.resume", { paneId: bs.paneId, trigger, results: results.length });
  await openVoice(bs, {
    history: historyFromTurns(useBrainstormStore.getState().turns),
    resumeNote,
    opening,
  });
}

export async function startBrainstorm(paneId: string): Promise<void> {
  if (brainstorm) await stopBrainstorm();

  let context: PaneContext;
  try {
    context = resolvePaneContext(paneId);
  } catch (error) {
    fail(errorText(error));
    return;
  }
  useBrainstormStore.setState((state) => ({
    ...INITIAL_STATE,
    pauseWhileWorking: state.pauseWhileWorking,
    status: "connecting",
    paneId,
    cwd: context.cwd,
    agent: context.agent,
  }));
  logEvent("info", "brainstorm.start", { paneId, agent: context.agent, branch: context.branch });

  if (!(await hasOpenAiApiKey())) {
    fail("Configure sua chave da OpenAI nas Configurações.");
    return;
  }

  const bs: Brainstorm = {
    paneId,
    cwd: context.cwd,
    agent: context.agent,
    branch: context.branch,
    ...(context.claudeConfigDir ? { claudeConfigDir: context.claudeConfigDir } : {}),
    ...(context.paneSessionId ? { paneSessionId: context.paneSessionId } : {}),
    agentSessionId: null,
    transcriptSentUpToMs: null,
    queue: Promise.resolve(),
    runningDelegationId: null,
    connection: null,
    pendingResults: [],
    pauseTimer: null,
    closedUsageSeconds: 0,
    ended: false,
  };
  brainstorm = bs;
  ensureProgressSubscription();

  await openVoice(bs, {
    // A spoken hello confirms the speaker path works before the user commits a question.
    opening: (answer) => {
      const conversation = answer.paneConversation;
      if (!conversation || conversation.messages === 0) {
        return "Cumprimente o usuário agora, em uma frase curta em português: diga que está ouvindo e pergunte no que ele quer trabalhar. Depois espere ele falar.";
      }
      const about = conversation.title ? ` (o assunto: ${conversation.title})` : "";
      return `Cumprimente o usuário agora, em uma ou duas frases curtas em português: diga que já está por dentro da conversa que ele estava tendo com o ${brainstormAgentLabel(bs.agent)} neste terminal${about} e pergunte o que ele quer discutir sobre ela. Não resuma a conversa agora. Depois espere ele falar.`;
    },
  });
}

/** Ends the brainstorm: the voice closes and any analysis still running is cancelled. */
export async function stopBrainstorm(): Promise<void> {
  const bs = brainstorm;
  if (!bs) return;
  const connection = liveConnection(bs);
  if (connection && useBrainstormStore.getState().status === "live") {
    setStatus("closing");
    await closeGracefully(connection);
  }
  endBrainstorm(bs, null);
  beep(440);
}

/**
 * F10: starts a conversation on the pane, or pauses and resumes its voice.
 * Ending is F11 or the panel's X, so a stray F10 never kills an analysis.
 */
export function toggleBrainstorm(paneId: string | null): void {
  const { status } = useBrainstormStore.getState();
  if (status === "closing" || status === "connecting") return;
  if (brainstorm) {
    if (status === "paused") {
      void resumeVoice(brainstorm, "user");
    } else if (status === "live") {
      pauseBrainstormVoice();
    }
    return;
  }
  if (paneId) void startBrainstorm(paneId);
}

/** The panel's "Retomar voz": same as F10 while paused. */
export function resumeBrainstormVoice(): void {
  if (brainstorm && useBrainstormStore.getState().status === "paused") {
    void resumeVoice(brainstorm, "user");
  }
}

/** The panel's "Pausar voz", or F10 while live: the voice closes, the brainstorm stays. */
export function pauseBrainstormVoice(): void {
  const bs = brainstorm;
  const connection = bs ? liveConnection(bs) : null;
  if (!bs || !connection || useBrainstormStore.getState().status !== "live") return;
  if (bs.pauseTimer) {
    clearTimeout(bs.pauseTimer);
    bs.pauseTimer = null;
  }
  void pauseVoice(bs, connection);
}

/** F11 or the panel's X: everything stops, analyses included. */
export function endBrainstormNow(): void {
  void stopBrainstorm();
}

export function setBrainstormPauseWhileWorking(enabled: boolean): void {
  useBrainstormStore.setState({ pauseWhileWorking: enabled });
  if (!enabled && brainstorm?.pauseTimer) {
    clearTimeout(brainstorm.pauseTimer);
    brainstorm.pauseTimer = null;
  }
}

export function toggleBrainstormMute(): void {
  const bs = brainstorm;
  const connection = bs ? liveConnection(bs) : null;
  if (!connection) return;
  const muted = !useBrainstormStore.getState().muted;
  // Disabling the track sends silence; the event tells the model why.
  for (const track of connection.stream.getAudioTracks()) track.enabled = !muted;
  send(connection, { type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
  useBrainstormStore.setState({ muted });
}

/** Stops one analysis at the user's request; the conversation goes on. */
export function cancelBrainstormTask(taskId: string): void {
  const bs = brainstorm;
  const task = taskById(taskId);
  if (!task || task.status !== "running") return;
  void window.headTerminal.live.cancelDelegation(taskId).catch(() => undefined);
  updateTask(taskId, {
    status: "cancelled",
    error: "Cancelada pelo usuário.",
    finishedAt: Date.now(),
  });
  if (!bs) return;
  if (bs.runningDelegationId === taskId) bs.runningDelegationId = null;
  appendIfLive(
    bs,
    "session.thinking.append",
    taskId,
    "O usuário cancelou esta análise na tela. Não há resultado; siga a conversa.",
  );
  // Nothing left to wait for: the voice comes back on its own.
  if (useBrainstormStore.getState().status === "paused" && runningTasks().length === 0) {
    void resumeVoice(bs, "user");
  }
}

/** An image (usually a screenshot) for the next analysis; only the agent sees it. */
export function attachBrainstormImage(path: string): boolean {
  const bs = brainstorm;
  const { attachments } = useBrainstormStore.getState();
  if (!bs || !path || attachments.includes(path)) return false;
  if (attachments.length >= MAX_ATTACHMENTS) {
    flashError(`No máximo ${MAX_ATTACHMENTS} imagens por análise.`);
    return false;
  }
  useBrainstormStore.setState({ attachments: [...attachments, path] });
  appendIfLive(
    bs,
    "session.thinking.append",
    null,
    `O usuário anexou uma imagem (${basenamePath(path, "captura de tela")}) na tela do app. Só o backend consegue ver a imagem: se a próxima pergunta for sobre ela, delegue. Você pode confirmar em poucas palavras que recebeu.`,
  );
  logEvent("info", "brainstorm.image_attached", { paneId: bs.paneId });
  return true;
}

/** Ctrl+V on the panel: a screenshot in the clipboard becomes an attachment. */
export async function attachBrainstormClipboardImage(): Promise<boolean> {
  if (!brainstorm) return false;
  try {
    const path = await window.headTerminal.clipboard.saveImage();
    if (!path) {
      flashError("A área de transferência não tem uma imagem.");
      return false;
    }
    return attachBrainstormImage(path);
  } catch (error) {
    flashError(errorText(error));
    return false;
  }
}

export function removeBrainstormAttachment(path: string): void {
  useBrainstormStore.setState((state) => ({
    attachments: state.attachments.filter((entry) => entry !== path),
  }));
}

/** Hides the panel of a conversation that already ended. */
export function dismissBrainstorm(): void {
  if (brainstorm) return;
  useBrainstormStore.setState((state) => ({
    ...INITIAL_STATE,
    pauseWhileWorking: state.pauseWhileWorking,
  }));
}

export function isBrainstormActive(): boolean {
  return brainstorm !== null;
}
