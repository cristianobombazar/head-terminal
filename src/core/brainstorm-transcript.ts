export type BrainstormRole = "user" | "assistant";

export interface BrainstormTurn {
  role: BrainstormRole;
  text: string;
  /** Session-timeline milliseconds of the first fragment, when GPT-Live gave them. */
  startMs?: number;
  /** Session-timeline milliseconds where the latest fragment ended. */
  endMs?: number;
}

export interface FragmentTiming {
  startMs?: number;
  endMs?: number;
}

const SPEAKER: Record<BrainstormRole, string> = {
  user: "Usuário",
  assistant: "Assistente de voz",
};

/**
 * Full duplex means a short "mm-hmm" from the assistant lands in the middle
 * of the user's sentence. A fragment this close (on the session timeline) to
 * the same speaker's previous turn still belongs to that turn.
 */
export const TURN_GAP_MS = 1_500;

/**
 * GPT-Live streams both sides of the conversation as fragments, and they
 * interleave. Consecutive fragments of one speaker make up one turn, and a
 * fragment that follows the same speaker's turn within TURN_GAP_MS joins it
 * even when the other speaker slipped a few words in between.
 */
export function appendTranscriptDelta(
  turns: readonly BrainstormTurn[],
  role: BrainstormRole,
  delta: string,
  timing: FragmentTiming = {},
  maxTurns = Number.POSITIVE_INFINITY,
): BrainstormTurn[] {
  if (!delta) return [...turns];
  const { startMs, endMs } = timing;
  const next = [...turns];
  const lastIndex = next.length - 1;
  const last = next[lastIndex];

  let target = -1;
  if (last?.role === role) {
    target = lastIndex;
  } else if (startMs !== undefined) {
    for (let index = lastIndex - 1; index >= 0; index -= 1) {
      const turn = next[index];
      if (turn.role !== role) continue;
      if (turn.endMs !== undefined && startMs - turn.endMs <= TURN_GAP_MS) target = index;
      break;
    }
  }

  if (target >= 0) {
    const turn = next[target];
    next[target] = {
      ...turn,
      text: turn.text + delta,
      ...(turn.startMs === undefined && startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs: Math.max(turn.endMs ?? 0, endMs) } : {}),
    };
  } else {
    next.push({
      role,
      text: delta.trimStart(),
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
    });
  }
  return next.length > maxTurns ? next.slice(next.length - maxTurns) : next;
}

export interface FormatTranscriptOptions {
  maxChars?: number;
  /** Only turns that were still being spoken at or after this timeline point. */
  sinceMs?: number | null;
}

/** One line per turn, labelled by speaker; the oldest part goes first when too long. */
export function formatTranscript(
  turns: readonly BrainstormTurn[],
  options: FormatTranscriptOptions | number = {},
): string {
  const { maxChars = 12_000, sinceMs = null } =
    typeof options === "number" ? { maxChars: options } : options;
  const text = turns
    .filter((turn) => sinceMs === null || (turn.endMs ?? Number.POSITIVE_INFINITY) >= sinceMs)
    .map((turn) => ({ role: turn.role, text: turn.text.trim() }))
    .filter((turn) => turn.text)
    .map((turn) => `${SPEAKER[turn.role]}: ${turn.text}`)
    .join("\n");
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** What the user said last — the delegation itself carries no text. */
export function lastUserText(turns: readonly BrainstormTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === "user" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

/** Latest point on the session timeline any fragment reached. */
export function transcriptEndMs(turns: readonly BrainstormTurn[]): number | null {
  let latest: number | null = null;
  for (const turn of turns) {
    if (turn.endMs !== undefined && (latest === null || turn.endMs > latest)) latest = turn.endMs;
  }
  return latest;
}
