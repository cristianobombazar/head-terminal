import { describe, expect, it } from "vitest";

import { formatShortcut, hasPrimaryModifier, matchesShortcut } from "./shortcuts";

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    code: "",
    ...init,
  } as KeyboardEvent;
}

describe("hasPrimaryModifier", () => {
  it("is Ctrl on Windows and Linux", () => {
    expect(hasPrimaryModifier(keyEvent({ key: "p", ctrlKey: true }), false)).toBe(true);
    expect(hasPrimaryModifier(keyEvent({ key: "p", metaKey: true }), false)).toBe(false);
  });

  it("is Command on macOS", () => {
    expect(hasPrimaryModifier(keyEvent({ key: "p", metaKey: true }), true)).toBe(true);
    expect(hasPrimaryModifier(keyEvent({ key: "p", ctrlKey: true }), true)).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("leaves the label alone off macOS", () => {
    expect(formatShortcut("Ctrl+Shift+P", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcut("F2", false)).toBe("F2");
  });

  it("spells macOS shortcuts with symbols and no separators", () => {
    expect(formatShortcut("Ctrl+Shift+P", true)).toBe("⌘⇧P");
    expect(formatShortcut("Ctrl+\\", true)).toBe("⌘\\");
    expect(formatShortcut("Ctrl+Shift+Alt+L", true)).toBe("⌘⇧⌥L");
    expect(formatShortcut("Ctrl+V", true)).toBe("⌘V");
    expect(formatShortcut("F10", true)).toBe("F10");
  });
});

describe("matchesShortcut", () => {
  it("requires exactly the listed modifiers off macOS", () => {
    expect(
      matchesShortcut(
        keyEvent({ key: "L", ctrlKey: true, shiftKey: true }),
        "Ctrl+Shift+L",
        false,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        keyEvent({ key: "L", ctrlKey: true, shiftKey: true, altKey: true }),
        "Ctrl+Shift+L",
        false,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        keyEvent({ key: "L", metaKey: true, shiftKey: true }),
        "Ctrl+Shift+L",
        false,
      ),
    ).toBe(false);
  });

  it("reads Ctrl as Command on macOS", () => {
    expect(
      matchesShortcut(
        keyEvent({ key: "L", metaKey: true, shiftKey: true }),
        "Ctrl+Shift+L",
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        keyEvent({ key: "L", ctrlKey: true, shiftKey: true }),
        "Ctrl+Shift+L",
        true,
      ),
    ).toBe(false);
  });

  it("matches letters by physical key on macOS when Option rewrote event.key", () => {
    expect(
      matchesShortcut(
        keyEvent({
          key: "¬",
          code: "KeyL",
          metaKey: true,
          shiftKey: true,
          altKey: true,
        }),
        "Ctrl+Shift+Alt+L",
        true,
      ),
    ).toBe(true);
  });
});
