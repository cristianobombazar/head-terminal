import { msg } from "../i18n";

export type PaneActivity =
  | "starting"
  | "idle"
  | "working"
  | "waiting_input"
  | "agent_fallback"
  | "error"
  | "exited";

export const ACTIVITY_PRIORITY: Record<PaneActivity, number> = {
  error: 7,
  agent_fallback: 6,
  working: 5,
  waiting_input: 4,
  starting: 3,
  idle: 2,
  exited: 1,
};

// Estados em que a sessão está bloqueada esperando o usuário.
export const NEEDS_ATTENTION: ReadonlySet<PaneActivity> = new Set([
  "waiting_input",
  "error",
  "agent_fallback",
]);

// Getters: read when shown, so a language switch shows up without a reload.
export const ACTIVITY_LABEL: Record<PaneActivity, string> = {
  get starting() {
    return msg.core.activity.starting;
  },
  get idle() {
    return msg.core.activity.idle;
  },
  get working() {
    return msg.core.activity.working;
  },
  get waiting_input() {
    return msg.core.activity.waitingInput;
  },
  get agent_fallback() {
    return msg.core.activity.agentFallback;
  },
  get error() {
    return msg.core.activity.error;
  },
  get exited() {
    return msg.core.activity.exited;
  },
};
