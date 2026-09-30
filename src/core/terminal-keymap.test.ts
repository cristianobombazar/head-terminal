import { describe, expect, it } from "vitest";

import {
  isAppShortcutKey,
  macTerminalKeyAction,
  type TerminalKeyContext,
} from "./terminal-keymap";

function keydown(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    type: "keydown",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...init,
  } as KeyboardEvent;
}

const shell: TerminalKeyContext = { hasSelection: false, normalBuffer: true };

describe("macTerminalKeyAction", () => {
  it.each([
    ["⌥←", { key: "ArrowLeft", altKey: true }, "\x1bb"],
    ["⌥→", { key: "ArrowRight", altKey: true }, "\x1bf"],
    ["⌥↑", { key: "ArrowUp", altKey: true }, "\x1b[1;5A"],
    ["⌥↓", { key: "ArrowDown", altKey: true }, "\x1b[1;5B"],
    ["⌥⌫", { key: "Backspace", altKey: true }, "\x17"],
    ["⌥⌦", { key: "Delete", altKey: true }, "\x1bd"],
    ["⌘⌫", { key: "Backspace", metaKey: true }, "\x15"],
    ["⌘←", { key: "ArrowLeft", metaKey: true }, "\x01"],
    ["⌘→", { key: "ArrowRight", metaKey: true }, "\x05"],
    ["⌃⇧2", { key: "@", code: "Digit2", ctrlKey: true, shiftKey: true }, "\x00"],
    ["⌃⇧6 (a dead key on US International)", { key: "Dead", code: "Digit6", ctrlKey: true, shiftKey: true }, "\x1e"],
    ["⌃⌥G", { key: "©", code: "KeyG", ctrlKey: true, altKey: true }, "\x07"],
  ])("sends what VS Code sends for %s", (_label, init, data) => {
    expect(macTerminalKeyAction(keydown(init), shell, true)).toEqual({ kind: "send", data });
  });

  it("requires exactly the bound modifiers", () => {
    expect(macTerminalKeyAction(keydown({ key: "ArrowLeft", altKey: true, shiftKey: true }), shell, true)).toBeNull();
    expect(macTerminalKeyAction(keydown({ key: "ArrowLeft", altKey: true, metaKey: true }), shell, true)).toBeNull();
    expect(macTerminalKeyAction(keydown({ key: "Backspace", metaKey: true, shiftKey: true }), shell, true)).toBeNull();
    expect(macTerminalKeyAction(keydown({ key: "ArrowLeft" }), shell, true)).toBeNull();
    expect(macTerminalKeyAction(keydown({ key: "b", code: "KeyB", altKey: true }), shell, true)).toBeNull();
  });

  it("copies with ⌘C and clears the selection with Esc only while text is selected", () => {
    const selected = { ...shell, hasSelection: true };
    const copy = keydown({ key: "c", code: "KeyC", metaKey: true });
    const escape = keydown({ key: "Escape", code: "Escape" });
    expect(macTerminalKeyAction(copy, selected, true)).toEqual({ kind: "copy" });
    expect(macTerminalKeyAction(escape, selected, true)).toEqual({ kind: "clearSelection" });
    expect(macTerminalKeyAction(copy, shell, true)).toBeNull();
    expect(macTerminalKeyAction(escape, shell, true)).toBeNull();
  });

  it("clears the terminal with ⌘K", () => {
    expect(macTerminalKeyAction(keydown({ key: "k", code: "KeyK", metaKey: true }), shell, true)).toEqual({
      kind: "clear",
    });
  });

  it("scrolls the normal buffer and leaves the keys to vim or less on the alternate screen", () => {
    const fullScreen = { ...shell, normalBuffer: false };
    const cases: Array<[Partial<KeyboardEvent> & { key: string }, unknown]> = [
      [{ key: "PageUp" }, { kind: "scrollPages", amount: -1 }],
      [{ key: "PageDown" }, { kind: "scrollPages", amount: 1 }],
      [{ key: "PageUp", altKey: true, metaKey: true }, { kind: "scrollLines", amount: -1 }],
      [{ key: "PageDown", altKey: true, metaKey: true }, { kind: "scrollLines", amount: 1 }],
      [{ key: "Home", metaKey: true }, { kind: "scrollToTop" }],
      [{ key: "End", metaKey: true }, { kind: "scrollToBottom" }],
    ];
    for (const [init, action] of cases) {
      expect(macTerminalKeyAction(keydown(init), shell, true)).toEqual(action);
      expect(macTerminalKeyAction(keydown(init), fullScreen, true)).toBeNull();
    }
  });

  it("leaves every key to xterm off macOS, on keyup and during an IME composition", () => {
    const wordLeft = { key: "ArrowLeft", altKey: true };
    expect(macTerminalKeyAction(keydown(wordLeft), shell, false)).toBeNull();
    expect(macTerminalKeyAction(keydown({ ...wordLeft, type: "keyup" }), shell, true)).toBeNull();
    expect(macTerminalKeyAction(keydown({ ...wordLeft, isComposing: true }), shell, true)).toBeNull();
  });
});

describe("isAppShortcutKey", () => {
  it("keeps Ctrl+Tab and Ctrl+Shift+Tab from xterm", () => {
    expect(isAppShortcutKey(keydown({ key: "Tab", ctrlKey: true }))).toBe(true);
    expect(isAppShortcutKey(keydown({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves Tab, Shift+Tab and other Ctrl keys to the shell", () => {
    expect(isAppShortcutKey(keydown({ key: "Tab" }))).toBe(false);
    expect(isAppShortcutKey(keydown({ key: "Tab", shiftKey: true }))).toBe(false);
    expect(isAppShortcutKey(keydown({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isAppShortcutKey(keydown({ key: "Tab", ctrlKey: true, type: "keyup" }))).toBe(false);
  });
});
