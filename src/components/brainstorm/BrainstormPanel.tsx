import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { BRAINSTORM_END_SHORTCUT, BRAINSTORM_SHORTCUT } from "../../config/toolbar";
import { formatTranscript, type BrainstormTurn } from "../../core/brainstorm-transcript";
import {
  attachBrainstormClipboardImage,
  attachBrainstormImage,
  brainstormAgentLabel,
  cancelBrainstormTask,
  dismissBrainstorm,
  endBrainstormNow,
  LIVE_RATE_USD_PER_MINUTE,
  pauseBrainstormVoice,
  removeBrainstormAttachment,
  resumeBrainstormVoice,
  setBrainstormPauseWhileWorking,
  stopBrainstorm,
  toggleBrainstorm,
  toggleBrainstormMute,
  useBrainstormStore,
  type BrainstormStatus,
  type BrainstormTask,
} from "../../core/live-brainstorm";
import { basenamePath } from "../../core/path-utils";
import { useSessionStore } from "../../core/session-manager";
import { collectPaneIds } from "../../core/session-layout";
import { IconCheck, IconClose, IconMic, IconMinimize } from "../ui/Icons";
import { BrainstormOrb, orbMood } from "./BrainstormOrb";

const STATUS_LABEL: Record<BrainstormStatus, string> = {
  idle: "",
  connecting: "Conectando…",
  live: "Ouvindo",
  paused: "Voz pausada",
  closing: "Encerrando…",
  ended: "Encerrada",
  error: "Erro",
};

const REQUEST_PREVIEW_CHARS = 160;
const STEPS_PREVIEW = 3;
/** Following new text stops once the reader scrolls this far from the bottom. */
const FOLLOW_THRESHOLD_PX = 24;

function seconds(from: number, to: number): string {
  return `${Math.max(0, Math.round((to - from) / 1000))}s`;
}

function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const rest = Math.floor(totalSeconds % 60);
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function usd(value: number): string {
  return `US$ ${value.toFixed(2).replace(".", ",")}`;
}

function isImageFile(name: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(name);
}

function TaskItem({ task, now }: { task: BrainstormTask; now: number }) {
  const [open, setOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const status =
    task.status === "running"
      ? `Analisando… ${seconds(task.startedAt, now)}`
      : task.status === "done"
        ? `Concluída em ${seconds(task.startedAt, task.finishedAt ?? now)}`
        : task.status === "cancelled"
          ? "Cancelada"
          : "Falhou";
  const request =
    task.request.length > REQUEST_PREVIEW_CHARS
      ? `${task.request.slice(0, REQUEST_PREVIEW_CHARS - 1)}…`
      : task.request;
  const steps = allSteps ? task.steps : task.steps.slice(-STEPS_PREVIEW);
  const hidden = task.steps.length - steps.length;

  return (
    <li className="brainstorm-task">
      <div className="brainstorm-task__head">
        <span className={`brainstorm-task__status brainstorm-task__status--${task.status}`}>
          {status}
        </span>
        <span className="brainstorm-task__meta">
          {task.attachments.length > 0 && (
            <span title={task.attachments.join("\n")}>
              {task.attachments.length} {task.attachments.length === 1 ? "imagem" : "imagens"}
            </span>
          )}
          {task.model && <span title="Modelo do terminal">{task.model}</span>}
          {typeof task.costUsd === "number" && <span>{usd(task.costUsd)}</span>}
          {task.status === "running" && (
            <button
              type="button"
              className="brainstorm-task__cancel"
              onClick={() => cancelBrainstormTask(task.id)}
              title="Interromper esta análise"
            >
              Cancelar
            </button>
          )}
        </span>
      </div>
      {request && <p className="brainstorm-task__request">“{request}”</p>}
      {task.steps.length > 0 && (task.status === "running" || open) && (
        <ol className="brainstorm-task__steps">
          {hidden > 0 && (
            <li>
              <button
                type="button"
                className="brainstorm-task__toggle"
                onClick={() => setAllSteps(true)}
              >
                … {hidden} {hidden === 1 ? "passo anterior" : "passos anteriores"}
              </button>
            </li>
          )}
          {steps.map((step, index) => (
            // Steps only ever append, so position identifies them.
            <li key={`${task.steps.length - steps.length + index}`}>{step}</li>
          ))}
        </ol>
      )}
      {task.summary && <p className="brainstorm-task__summary">{task.summary}</p>}
      {task.error && <p className="brainstorm-task__error">{task.error}</p>}
      {(task.details || task.transcriptSent) && (
        <>
          <button
            type="button"
            className="brainstorm-task__toggle"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Ocultar detalhes" : "Ver detalhes"}
          </button>
          {open && (
            <div className="brainstorm-task__body">
              {task.details && <pre className="brainstorm-task__details">{task.details}</pre>}
              {task.transcriptSent && (
                <details className="brainstorm-task__sent">
                  <summary>O que o agente recebeu</summary>
                  <pre className="brainstorm-task__details">{task.transcriptSent}</pre>
                </details>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

const TurnRow = memo(function TurnRow({ turn }: { turn: BrainstormTurn }) {
  return (
    <p className={`brainstorm-panel__turn brainstorm-panel__turn--${turn.role}`}>
      <span>{turn.role === "user" ? "Você" : "Voz"}</span>
      {turn.text}
    </p>
  );
});

/** Panel visibility: the sheet grows out of the orb and shrinks back into it. */
type SheetPhase = "closed" | "opening" | "open" | "closing";

function useSessionTitle(paneId: string | null): string | null {
  return useSessionStore((state) => {
    if (!paneId) return null;
    const session = state.sessions.find((candidate) =>
      collectPaneIds(candidate.layout).includes(paneId),
    );
    return session?.title ?? null;
  });
}

/**
 * The brainstorm on screen. By default only the orb shows, in the corner of
 * the terminal area; a click opens the sheet with the transcript and the
 * analyses, and the sheet's minimize folds it back into the orb. F10 freezes
 * the orb with the voice; F11 ends everything and the orb dies.
 */
export function BrainstormPanel() {
  const status = useBrainstormStore((state) => state.status);
  const paneId = useBrainstormStore((state) => state.paneId);
  const cwd = useBrainstormStore((state) => state.cwd);
  const tasks = useBrainstormStore((state) => state.tasks);
  const sessionTitle = useSessionTitle(paneId);
  const [sheet, setSheet] = useState<SheetPhase>("closed");
  const [orbGone, setOrbGone] = useState(false);
  // Results the user has not seen because the sheet was closed.
  const seenResultsRef = useRef(0);
  const [unread, setUnread] = useState(0);
  const finished = tasks.filter((task) => task.status === "done" || task.status === "failed").length;

  useEffect(
    // F10 comes from the main process: on Windows the menu bar would take it
    // before the page saw it.
    () =>
      window.headTerminal.live.onToggleRequested(() =>
        toggleBrainstorm(useSessionStore.getState().activePaneId),
      ),
    [],
  );

  useEffect(() => window.headTerminal.live.onEndRequested(endBrainstormNow), []);

  useEffect(() => {
    const onUnload = () => {
      void stopBrainstorm();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // A new brainstorm starts folded, with a fresh orb.
  useEffect(() => {
    if (status === "connecting") {
      setSheet("closed");
      setOrbGone(false);
      seenResultsRef.current = 0;
      setUnread(0);
    }
  }, [status]);

  // Something went wrong: the message must be readable, so the sheet opens.
  useEffect(() => {
    if (status === "error") setSheet((phase) => (phase === "closed" ? "opening" : phase));
  }, [status]);

  useEffect(() => {
    if (sheet === "open" || sheet === "opening") {
      seenResultsRef.current = finished;
      setUnread(0);
    } else {
      setUnread(Math.max(0, finished - seenResultsRef.current));
    }
  }, [finished, sheet]);

  // Over, and nothing left on screen to show it: the store can reset.
  const over = status === "ended" || status === "error";
  useEffect(() => {
    if (over && orbGone && sheet === "closed") dismissBrainstorm();
  }, [over, orbGone, sheet]);

  if (status === "idle") return null;

  const mood = orbMood(status);
  const running = tasks.some((task) => task.status === "running");
  const folder = cwd ? basenamePath(cwd, cwd) : "";
  const orbTitle = [
    "Brainstorm por voz",
    STATUS_LABEL[status],
    sessionTitle ?? folder,
    status === "paused"
      ? `${BRAINSTORM_SHORTCUT} retoma`
      : status === "live"
        ? `${BRAINSTORM_SHORTCUT} pausa · ${BRAINSTORM_END_SHORTCUT} encerra`
        : "",
    "clique para abrir",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {!orbGone && sheet === "closed" && (
        <div className="brainstorm-dock">
          <BrainstormOrb
            mood={mood}
            working={running}
            unread={unread}
            title={orbTitle}
            onClick={() => setSheet("opening")}
            onDied={() => setOrbGone(true)}
          />
        </div>
      )}
      {sheet !== "closed" && (
        <BrainstormSheet
          phase={sheet}
          mood={mood}
          onOpened={() => setSheet("open")}
          onMinimize={() => setSheet("closing")}
          onClosed={() => {
            setSheet("closed");
            // The conversation ended while the sheet was open: there is no orb to fold back into.
            if (over) setOrbGone(true);
          }}
        />
      )}
    </>
  );
}

interface BrainstormSheetProps {
  phase: Exclude<SheetPhase, "closed">;
  mood: ReturnType<typeof orbMood>;
  onOpened: () => void;
  onMinimize: () => void;
  onClosed: () => void;
}

function BrainstormSheet({ phase, mood, onOpened, onMinimize, onClosed }: BrainstormSheetProps) {
  const status = useBrainstormStore((state) => state.status);
  const cwd = useBrainstormStore((state) => state.cwd);
  const agent = useBrainstormStore((state) => state.agent);
  const paneConversation = useBrainstormStore((state) => state.paneConversation);
  const turns = useBrainstormStore((state) => state.turns);
  const tasks = useBrainstormStore((state) => state.tasks);
  const attachments = useBrainstormStore((state) => state.attachments);
  const muted = useBrainstormStore((state) => state.muted);
  const pauseWhileWorking = useBrainstormStore((state) => state.pauseWhileWorking);
  const usageSeconds = useBrainstormStore((state) => state.usageSeconds);
  const warning = useBrainstormStore((state) => state.warning);
  const error = useBrainstormStore((state) => state.error);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const running = tasks.some((task) => task.status === "running");

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running]);

  // Follow new text only while the reader is at the bottom.
  useEffect(() => {
    const element = transcriptRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [turns]);

  const onTranscriptScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) return;
    followRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX;
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      if (!isImageFile(file.name)) continue;
      const path = window.headTerminal.clipboard.pathForFile(file);
      if (path) attachBrainstormImage(path);
    }
  }, []);

  const inProgress =
    status === "connecting" || status === "live" || status === "paused" || status === "closing";
  const folder = cwd ? basenamePath(cwd, cwd) : "";
  const cost = (usageSeconds / 60) * LIVE_RATE_USD_PER_MINUTE;

  const copyAll = () => {
    const parts = [
      `# Brainstorm por voz — ${folder}`,
      "",
      "## Conversa",
      "",
      formatTranscript(turns, { maxChars: Number.POSITIVE_INFINITY }),
    ];
    const answered = tasks.filter((task) => task.details || task.error);
    if (answered.length > 0) {
      parts.push("", "## Análises");
      for (const task of answered) {
        parts.push("", `### ${task.request || "Análise"}`, "", task.details ?? `Falhou: ${task.error}`);
      }
    }
    void window.headTerminal.clipboard.writeText(parts.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <aside
      className={[
        "brainstorm-panel",
        `brainstorm-panel--${phase}`,
        dragging ? "brainstorm-panel--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Brainstorm por voz"
      tabIndex={-1}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.animationName === "brainstorm-sheet-open") onOpened();
        if (event.animationName === "brainstorm-sheet-close") onClosed();
      }}
      onPaste={(event) => {
        if (status !== "live") return;
        event.preventDefault();
        void attachBrainstormClipboardImage();
      }}
      onDragOver={(event) => {
        if (status !== "live") return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="brainstorm-panel__header">
        <BrainstormOrb mood={mood} working={running} mini />
        <div className="brainstorm-panel__title">
          <strong>Brainstorm por voz</strong>
          <span className="brainstorm-panel__meta" title={cwd ?? undefined}>
            {[
              STATUS_LABEL[status],
              folder,
              brainstormAgentLabel(agent),
              paneConversation && paneConversation.messages > 0
                ? `com a conversa do terminal (${paneConversation.messages} ${paneConversation.messages === 1 ? "mensagem" : "mensagens"})`
                : "",
              usageSeconds > 0 ? `${clock(usageSeconds)} · ${usd(cost)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="brainstorm-panel__actions">
          {status === "live" && (
            <button
              type="button"
              className={`brainstorm-panel__button ${muted ? "brainstorm-panel__button--muted" : ""}`}
              onClick={toggleBrainstormMute}
              title={muted ? "Reativar microfone" : "Silenciar microfone"}
              aria-label={muted ? "Reativar microfone" : "Silenciar microfone"}
              aria-pressed={muted}
            >
              <IconMic size={13} />
            </button>
          )}
          {status === "live" && (
            <button
              type="button"
              className="brainstorm-panel__button"
              onClick={() => void attachBrainstormClipboardImage()}
              title="Anexar a imagem da área de transferência (Ctrl+V no painel)"
            >
              Imagem
            </button>
          )}
          {status === "paused" && (
            <button
              type="button"
              className="brainstorm-panel__button brainstorm-panel__button--accent"
              onClick={resumeBrainstormVoice}
              title={`Reabrir a voz agora com o contexto da conversa (${BRAINSTORM_SHORTCUT})`}
            >
              Retomar voz
            </button>
          )}
          {status === "live" && (
            <button
              type="button"
              className="brainstorm-panel__button"
              onClick={pauseBrainstormVoice}
              title={`Pausar a voz sem encerrar a conversa (${BRAINSTORM_SHORTCUT})`}
            >
              Pausar
            </button>
          )}
          {inProgress && (
            <button
              type="button"
              className={`brainstorm-panel__button ${pauseWhileWorking ? "brainstorm-panel__button--on" : ""}`}
              onClick={() => setBrainstormPauseWhileWorking(!pauseWhileWorking)}
              aria-pressed={pauseWhileWorking}
              title={
                pauseWhileWorking
                  ? "A voz fecha enquanto o agente trabalha (sem cobrança) e volta com o resultado. Clique para manter a voz aberta."
                  : "A voz fica aberta enquanto o agente trabalha. Clique para pausar automaticamente."
              }
            >
              Pausa auto
            </button>
          )}
          <button
            type="button"
            className="brainstorm-panel__button"
            onClick={copyAll}
            disabled={turns.length === 0 && tasks.length === 0}
            title="Copiar conversa e análises em markdown"
          >
            {copied ? <IconCheck size={13} /> : "Copiar"}
          </button>
          <button
            type="button"
            className="brainstorm-panel__button"
            onClick={onMinimize}
            title="Recolher para a bolinha"
            aria-label="Recolher para a bolinha"
          >
            <IconMinimize size={13} />
          </button>
          <button
            type="button"
            className="brainstorm-panel__button"
            onClick={() => (inProgress ? void stopBrainstorm() : dismissBrainstorm())}
            title={inProgress ? `Encerrar conversa (${BRAINSTORM_END_SHORTCUT})` : "Fechar painel"}
            aria-label={inProgress ? "Encerrar conversa" : "Fechar painel"}
          >
            <IconClose size={13} />
          </button>
        </div>
      </header>

      {warning && status === "live" && <p className="brainstorm-panel__warning">{warning}</p>}
      {error && <p className="brainstorm-panel__error">{error}</p>}

      {attachments.length > 0 && (
        <ul className="brainstorm-panel__attachments" aria-label="Imagens para a próxima análise">
          {attachments.map((path) => (
            <li key={path} className="brainstorm-panel__attachment" title={path}>
              <span>{basenamePath(path, path)}</span>
              <button
                type="button"
                onClick={() => removeBrainstormAttachment(path)}
                aria-label={`Remover ${basenamePath(path, path)}`}
              >
                <IconClose size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {tasks.length > 0 && (
        <ul className="brainstorm-panel__tasks">
          {[...tasks].reverse().map((task) => (
            <TaskItem key={task.id} task={task} now={now} />
          ))}
        </ul>
      )}

      <div
        className="brainstorm-panel__transcript"
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
      >
        {turns.length === 0 ? (
          <p className="brainstorm-panel__hint">
            {status === "live"
              ? paneConversation && paneConversation.messages > 0
                ? `Pode falar. A voz já leu a conversa que estava neste terminal${paneConversation.title ? ` (${paneConversation.title})` : ""}; pergunte sobre ela, peça um resumo ou siga em frente.`
                : "Pode falar. Peça para olhar o código, relatar um bug, implementar algo ou pesquisar."
              : status === "connecting"
                ? "Abrindo o microfone e conectando…"
                : status === "paused"
                  ? "Voz pausada enquanto o agente trabalha."
                  : "Nada foi dito nesta conversa."}
          </p>
        ) : (
          turns.map((turn, index) => (
            // Turns keep their position; only their text grows.
            <TurnRow key={index} turn={turn} />
          ))
        )}
      </div>

      <footer className="brainstorm-panel__footer">
        {status === "paused"
          ? `${BRAINSTORM_SHORTCUT} retoma a voz · ${BRAINSTORM_END_SHORTCUT} ou X encerra · a voz volta sozinha com o resultado`
          : inProgress
            ? `${BRAINSTORM_SHORTCUT} pausa · ${BRAINSTORM_END_SHORTCUT} encerra · Ctrl+V ou arrastar anexa imagem`
            : `${BRAINSTORM_SHORTCUT} abre outra conversa`}
      </footer>
    </aside>
  );
}
