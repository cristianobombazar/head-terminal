import { isMacHost } from "./platform-info";

/**
 * The keys VS Code's integrated terminal binds itself on macOS (read from
 * VS Code 1.139's keybindings), so a shell or an agent in a pane gets from
 * them exactly what it gets there. Every other key is left to xterm.
 */

export type TerminalKeyAction =
  | { kind: "send"; data: string }
  | { kind: "copy" }
  | { kind: "clear" }
  | { kind: "clearSelection" }
  | { kind: "scrollPages"; amount: number }
  | { kind: "scrollLines"; amount: number }
  | { kind: "scrollToTop" }
  | { kind: "scrollToBottom" };

export interface TerminalKeyContext {
  hasSelection: boolean;
  /** Not the alternate screen: vim or less read the scrolling keys themselves. */
  normalBuffer: boolean;
}

type KeyEventLike = Pick<
  KeyboardEvent,
  "type" | "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing"
>;

interface MacBinding {
  /**
   * `Alt+ArrowLeft`: every listed modifier held and no other. A `Key*` or
   * `Digit*` key is matched by physical key, since ⌥ and ⇧ change what
   * `event.key` says (⇧6 is a dead key on US International); any other key
   * by `event.key`, which names Home or PageUp however the keyboard makes them.
   */
  keys: string;
  when?: (context: TerminalKeyContext) => boolean;
  action: TerminalKeyAction;
}

const send = (data: string): TerminalKeyAction => ({ kind: "send", data });
const withSelection = (context: TerminalKeyContext) => context.hasSelection;
const inNormalBuffer = (context: TerminalKeyContext) => context.normalBuffer;

const MAC_BINDINGS: readonly MacBinding[] = [
  // workbench.action.terminal.sendSequence
  { keys: "Alt+ArrowLeft", action: send("\x1bb") }, // word left
  { keys: "Alt+ArrowRight", action: send("\x1bf") }, // word right
  { keys: "Alt+ArrowUp", action: send("\x1b[1;5A") },
  { keys: "Alt+ArrowDown", action: send("\x1b[1;5B") },
  { keys: "Alt+Backspace", action: send("\x17") }, // ^W: delete the word before the cursor
  { keys: "Alt+Delete", action: send("\x1bd") }, // ESC d: delete the word after it
  { keys: "Meta+Backspace", action: send("\x15") }, // ^U: delete to the start of the line
  { keys: "Meta+ArrowLeft", action: send("\x01") }, // ^A: start of the line
  { keys: "Meta+ArrowRight", action: send("\x05") }, // ^E: end of the line
  { keys: "Ctrl+Shift+Digit2", action: send("\x00") },
  { keys: "Ctrl+Shift+Digit6", action: send("\x1e") },
  { keys: "Ctrl+Alt+KeyG", action: send("\x07") },
  // The terminal's own commands
  { keys: "Meta+KeyC", when: withSelection, action: { kind: "copy" } },
  { keys: "Meta+KeyK", action: { kind: "clear" } },
  { keys: "Escape", when: withSelection, action: { kind: "clearSelection" } },
  { keys: "PageUp", when: inNormalBuffer, action: { kind: "scrollPages", amount: -1 } },
  { keys: "PageDown", when: inNormalBuffer, action: { kind: "scrollPages", amount: 1 } },
  { keys: "Alt+Meta+PageUp", when: inNormalBuffer, action: { kind: "scrollLines", amount: -1 } },
  { keys: "Alt+Meta+PageDown", when: inNormalBuffer, action: { kind: "scrollLines", amount: 1 } },
  { keys: "Meta+Home", when: inNormalBuffer, action: { kind: "scrollToTop" } },
  { keys: "Meta+End", when: inNormalBuffer, action: { kind: "scrollToBottom" } },
];

function matchesBinding(event: KeyEventLike, keys: string): boolean {
  const parts = keys.split("+");
  const key = parts.pop();
  const pressed = key && /^(?:Key|Digit)/u.test(key) ? event.code : event.key;
  return (
    pressed === key &&
    event.ctrlKey === parts.includes("Ctrl") &&
    event.shiftKey === parts.includes("Shift") &&
    event.altKey === parts.includes("Alt") &&
    event.metaKey === parts.includes("Meta")
  );
}

/** What VS Code does with this keydown on macOS; `null` leaves it to xterm. */
export function macTerminalKeyAction(
  event: KeyEventLike,
  context: TerminalKeyContext,
  mac: boolean = isMacHost(),
): TerminalKeyAction | null {
  if (!mac || event.type !== "keydown" || event.isComposing) {
    return null;
  }
  const binding = MAC_BINDINGS.find(
    (candidate) =>
      matchesBinding(event, candidate.keys) && (candidate.when?.(context) ?? true),
  );
  return binding?.action ?? null;
}

/**
 * App shortcuts xterm would otherwise type into the shell and stop there:
 * Ctrl+Tab and Ctrl+Shift+Tab switch sessions, on every platform.
 */
export function isAppShortcutKey(event: KeyEventLike): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Tab" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
