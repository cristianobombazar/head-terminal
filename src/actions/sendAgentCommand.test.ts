import { beforeEach, describe, expect, it, vi } from "vitest";

const getTerminal = vi.fn();

let ptyWriters: Record<string, ReturnType<typeof vi.fn>> = {};
let targetPaneIds: string[] = [];

vi.mock("../core/session-manager", () => ({
  useSessionStore: {
    getState: () => ({ ptyWriters, getTargetPaneIds: () => targetPaneIds }),
  },
}));

vi.mock("../core/terminal-registry", () => ({
  getTerminal: (paneId: string) => getTerminal(paneId),
}));

const { sendAgentCommand, sendTextToPane } = await import("./sendAgentCommand");

describe("sendTextToPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyWriters = { pane: vi.fn() };
    targetPaneIds = ["pane"];
  });

  it("pastes dictated text so the agent reads it as one unit", () => {
    const paste = vi.fn();
    getTerminal.mockReturnValue({ terminal: { paste } });

    const transcript = "uma transcrição longa ".repeat(60);
    sendTextToPane("pane", transcript);

    expect(paste).toHaveBeenCalledWith(transcript);
    expect(ptyWriters.pane).not.toHaveBeenCalled();
  });

  it("falls back to the raw writer when the pane has no terminal", () => {
    getTerminal.mockReturnValue(undefined);

    sendTextToPane("pane", "texto");

    expect(ptyWriters.pane).toHaveBeenCalledWith("texto");
  });
});

describe("sendAgentCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptyWriters = { pane: vi.fn() };
    targetPaneIds = ["pane"];
  });

  it("keeps writing commands straight to the pty, terminated by a return", () => {
    const paste = vi.fn();
    getTerminal.mockReturnValue({ terminal: { paste } });

    sendAgentCommand("npm test");

    expect(ptyWriters.pane).toHaveBeenCalledWith("npm test\r");
    expect(paste).not.toHaveBeenCalled();
  });
});
