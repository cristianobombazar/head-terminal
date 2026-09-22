// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  landPaneMotion,
  minimizePaneWithMotion,
  restorePaneWithMotion,
  toggleActivePaneMinimized,
} from "./pane-minimize";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";

function placeAt(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  return element;
}

interface FakeAnimation {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

describe("pane minimize motion", () => {
  let animations: Array<{ element: Element; animation: FakeAnimation }>;
  let paneId: string;

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    const session = createEmptySession({
      id: "s",
      title: "s",
      cwd: "/tmp",
      agentProfileId: "shell",
    });
    useSessionStore.getState().addSession(session);
    [paneId] = collectPaneIds(session.layout);

    animations = [];
    Element.prototype.animate = function animate(this: Element) {
      const animation: FakeAnimation = { onfinish: null, oncancel: null };
      animations.push({ element: this, animation });
      return animation as unknown as Animation;
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete (Element.prototype as Partial<Element>).animate;
    vi.restoreAllMocks();
  });

  it("flies a ghost from the pane to its card, then clears it", () => {
    const shell = placeAt(document.createElement("div"), 300, 60, 800, 600);
    shell.dataset.paneShell = paneId;
    document.body.append(shell);

    minimizePaneWithMotion(paneId);
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeDefined();

    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    document.body.append(card);
    landPaneMotion(paneId, "minimize", card);

    const ghost = document.querySelector(".pane-motion-ghost");
    expect(ghost).not.toBeNull();
    expect(animations.map((entry) => entry.element)).toEqual([ghost, card]);

    animations[0].animation.onfinish?.();
    expect(document.querySelector(".pane-motion-ghost")).toBeNull();
  });

  it("lands each motion once, and only the kind it started as", () => {
    const shell = placeAt(document.createElement("div"), 300, 60, 800, 600);
    shell.dataset.paneShell = paneId;
    document.body.append(shell);
    minimizePaneWithMotion(paneId);

    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    landPaneMotion(paneId, "restore", card);
    expect(animations).toHaveLength(0);

    landPaneMotion(paneId, "minimize", card);
    landPaneMotion(paneId, "minimize", card);
    expect(animations).toHaveLength(2);
  });

  it("does not fly from a stale origin or from off-screen", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    card.dataset.minimizedPane = paneId;
    document.body.append(card);
    useSessionStore.getState().minimizePane(paneId);

    restorePaneWithMotion(paneId);
    now.mockReturnValue(5_000);
    landPaneMotion(paneId, "restore", placeAt(document.createElement("div"), 0, 0, 800, 600));
    expect(animations).toHaveLength(0);

    // A card in a hidden session sits far off to the left.
    useSessionStore.getState().minimizePane(paneId);
    placeAt(card, -3000, 700, 260, 34);
    restorePaneWithMotion(paneId);
    landPaneMotion(paneId, "restore", placeAt(document.createElement("div"), 0, 0, 800, 600));
    expect(animations).toHaveLength(0);
  });

  it("toggles the active terminal in and out of the dock", () => {
    toggleActivePaneMinimized();
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeDefined();

    toggleActivePaneMinimized();
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeUndefined();
    expect(useSessionStore.getState().activePaneId).toBe(paneId);
  });
});
