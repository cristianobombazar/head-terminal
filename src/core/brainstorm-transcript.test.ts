import { describe, expect, it } from "vitest";

import {
  appendTranscriptDelta,
  formatTranscript,
  lastUserText,
  transcriptEndMs,
  TURN_GAP_MS,
  type BrainstormTurn,
} from "./brainstorm-transcript";

function build(
  fragments: Array<[BrainstormTurn["role"], string, number?, number?]>,
  maxTurns?: number,
): BrainstormTurn[] {
  let turns: BrainstormTurn[] = [];
  for (const [role, delta, startMs, endMs] of fragments) {
    turns = appendTranscriptDelta(turns, role, delta, { startMs, endMs }, maxTurns);
  }
  return turns;
}

describe("appendTranscriptDelta", () => {
  it("joins consecutive fragments of one speaker into one turn", () => {
    const turns = build([
      ["user", "olha "],
      ["user", "o upload"],
      ["assistant", " Tá, "],
      ["assistant", "vou ver."],
    ]);
    expect(turns).toEqual([
      { role: "user", text: "olha o upload" },
      { role: "assistant", text: "Tá, vou ver." },
    ]);
  });

  it("keeps a user sentence together when the assistant backchannels in the middle", () => {
    const turns = build([
      ["user", "vai na pasta", 1_000, 1_800],
      ["assistant", "Hmm.", 1_900, 2_100],
      ["user", " Lead Digital", 2_200, 2_900],
      ["user", " e olha o projeto", 2_950, 3_600],
    ]);
    expect(turns.map((turn) => turn.text)).toEqual([
      "vai na pasta Lead Digital e olha o projeto",
      "Hmm.",
    ]);
    expect(turns[0]).toMatchObject({ startMs: 1_000, endMs: 3_600 });
  });

  it("starts a new turn after a real pause", () => {
    const turns = build([
      ["user", "primeira frase", 0, 900],
      ["assistant", "Certo.", 1_000, 1_400],
      ["user", "segunda frase", 1_400 + TURN_GAP_MS + 1, 5_000],
    ]);
    expect(turns.map((turn) => turn.text)).toEqual(["primeira frase", "Certo.", "segunda frase"]);
  });

  it("ignores empty deltas and caps the number of turns", () => {
    expect(appendTranscriptDelta([], "user", "")).toEqual([]);
    const turns = build(
      [
        ["user", "a"],
        ["assistant", "b"],
        ["user", "c"],
      ],
      2,
    );
    expect(turns.map((turn) => turn.text)).toEqual(["b", "c"]);
  });
});

describe("formatTranscript", () => {
  const turns = build([
    ["user", "olha o upload", 0, 1_000],
    ["assistant", "Vou pedir para checar.", 1_100, 2_000],
    ["user", "e o download também", 9_000, 10_000],
  ]);

  it("labels each turn by speaker", () => {
    expect(formatTranscript(turns)).toBe(
      "Usuário: olha o upload\nAssistente de voz: Vou pedir para checar.\nUsuário: e o download também",
    );
  });

  it("keeps only what was said since a timeline point", () => {
    expect(formatTranscript(turns, { sinceMs: 2_000 })).toBe(
      "Assistente de voz: Vou pedir para checar.\nUsuário: e o download também",
    );
    expect(formatTranscript(turns, { sinceMs: 5_000 })).toBe("Usuário: e o download também");
  });

  it("keeps the newest part when too long", () => {
    const formatted = formatTranscript(turns, { maxChars: 20 });
    expect(formatted.startsWith("…")).toBe(true);
    expect(formatted.endsWith("download também")).toBe(true);
  });

  it("accepts the old numeric maxChars form", () => {
    expect(formatTranscript(turns, Number.POSITIVE_INFINITY)).toContain("olha o upload");
  });
});

describe("lastUserText and transcriptEndMs", () => {
  it("returns the latest non-empty user turn and the furthest timeline point", () => {
    const turns = build([
      ["user", "primeiro", 0, 500],
      ["assistant", "ok", 600, 700],
      ["user", "  ", 800, 900],
    ]);
    expect(lastUserText(turns)).toBe("primeiro");
    expect(transcriptEndMs(turns)).toBe(900);
    expect(transcriptEndMs([])).toBeNull();
  });
});
