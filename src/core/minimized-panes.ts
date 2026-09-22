import { formatActivityDuration } from "./activity-duration";
import type { PaneRuntime } from "./session-manager";
import type { PaneActivity } from "../types/activity";

/** A terminal taken off its session's canvas into the session's dock. */
export interface MinimizedPane {
  /** When it left the canvas. */
  since: number;
  /** When the agent stopped working while minimized. The card flags it until
   * the terminal is brought back; going back to work clears it. */
  finishedAt?: number;
}

/**
 * The `finishedAt` a minimized pane carries after its activity moves from
 * `previous` to `next`. Only a pane seen working counts as having finished:
 * one minimized while already idle has nothing new to report.
 */
export function nextFinishedAt(
  finishedAt: number | undefined,
  previous: PaneActivity,
  next: PaneActivity,
  now: number,
): number | undefined {
  if (next === "working") {
    return undefined;
  }
  if (previous === "working" && next !== "starting") {
    return finishedAt ?? now;
  }
  return finishedAt;
}

export type MinimizedPaneTone =
  | "working"
  | "starting"
  | "approval"
  | "done"
  | "waiting"
  | "idle"
  | "error"
  | "exited"
  | "fallback";

export interface MinimizedPaneStatus {
  tone: MinimizedPaneTone;
  label: string;
  /** How long it has been working, or since it stopped. */
  time?: string;
  /** The card should catch the eye: the agent is blocked on the user, or
   * stopped since it was minimized. */
  attention: boolean;
}

/** What a minimized terminal's card says about it. */
export function describeMinimizedPane(
  runtime: Pick<PaneRuntime, "activity" | "activitySince" | "awaitingApproval"> | undefined,
  minimized: MinimizedPane,
  now: number,
): MinimizedPaneStatus {
  const activity = runtime?.activity ?? "starting";
  const stoppedHere = minimized.finishedAt !== undefined;
  const stoppedFor = minimized.finishedAt !== undefined
    ? `há ${formatActivityDuration(minimized.finishedAt, now)}`
    : undefined;

  switch (activity) {
    case "working":
      return {
        tone: "working",
        label: "Executando",
        time: runtime ? formatActivityDuration(runtime.activitySince, now) : undefined,
        attention: false,
      };
    case "starting":
      return { tone: "starting", label: "Iniciando", attention: false };
    case "waiting_input":
      if (runtime?.awaitingApproval) {
        return { tone: "approval", label: "Pede aprovação", time: stoppedFor, attention: true };
      }
      return stoppedHere
        ? { tone: "done", label: "Terminou", time: stoppedFor, attention: true }
        : { tone: "waiting", label: "Aguardando", attention: false };
    case "idle":
      return stoppedHere
        ? { tone: "done", label: "Terminou", time: stoppedFor, attention: true }
        : { tone: "idle", label: "Pronto", attention: false };
    case "error":
      return { tone: "error", label: "Erro", time: stoppedFor, attention: true };
    case "agent_fallback":
      return { tone: "fallback", label: "Agent caiu", time: stoppedFor, attention: true };
    case "exited":
      return { tone: "exited", label: "Encerrado", time: stoppedFor, attention: stoppedHere };
  }
}
