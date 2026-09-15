import { isMacHost } from "./platform-info";

/**
 * Shortcuts are written once, the Windows/Linux way — `Ctrl+Shift+P` — and
 * "Ctrl" there means *the primary modifier*: the Control key on Windows and
 * Linux, Command on macOS, where Ctrl+letter is what the shell reads and ⌘
 * is what every app shortcut uses. `Ctrl+Tab` is the one exception callers
 * keep on Control everywhere, since ⌘Tab belongs to the OS.
 */

type ModifierEvent = Pick<KeyboardEvent, "ctrlKey" | "metaKey">;

/** Is the platform's primary modifier held? Ctrl on Windows/Linux, ⌘ on macOS. */
export function hasPrimaryModifier(
  event: ModifierEvent,
  mac: boolean = isMacHost(),
): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  ctrl: "⌘",
  cmd: "⌘",
  meta: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
};

/**
 * The label for a shortcut as the host spells it: unchanged on Windows and
 * Linux, macOS symbols with no separators there (`Ctrl+Shift+P` → `⌘⇧P`).
 */
export function formatShortcut(
  shortcut: string,
  mac: boolean = isMacHost(),
): string {
  if (!mac) {
    return shortcut;
  }
  const parts = shortcut.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  if (parts.length === 0) {
    return key;
  }
  const modifiers = parts
    .map((part) => MAC_MODIFIER_SYMBOLS[part.toLowerCase()] ?? part)
    .join("");
  return `${modifiers}${key.length === 1 ? key.toUpperCase() : key}`;
}

/**
 * Does this keydown match a `Ctrl+Shift+L`-style definition? Every listed
 * modifier must be held and no other. On macOS "Ctrl" is matched against ⌘,
 * and letters are also matched by physical key, because ⌥ changes what
 * `event.key` says (⌥L is `¬`) while `event.code` stays `KeyL`.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: string,
  mac: boolean = isMacHost(),
): boolean {
  const parts = shortcut.split("+").map((part) => part.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const needsPrimary = parts.includes("ctrl");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt") || parts.includes("option");
  const needsMeta = parts.includes("cmd") || parts.includes("meta");
  const needsCtrlKey = mac ? needsMeta : needsPrimary;
  const needsMetaKey = mac ? needsPrimary || needsMeta : needsMeta;

  const keyMatches =
    event.key.toLowerCase() === key
    || (mac && key.length === 1 && event.code === `Key${key.toUpperCase()}`);

  return (
    keyMatches &&
    event.ctrlKey === needsCtrlKey &&
    event.shiftKey === needsShift &&
    event.altKey === needsAlt &&
    event.metaKey === needsMetaKey
  );
}
