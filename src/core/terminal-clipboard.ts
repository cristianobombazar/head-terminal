import type { Terminal } from "@xterm/xterm";

import { logError, logEvent } from "./logger";
import { isMacHost } from "./platform-info";

const pasteInFlight = new WeakSet<Terminal>();

/**
 * ⌘V on macOS, where Ctrl+V goes on to the shell as ^V like in VS Code's
 * terminal — Claude Code reads it as its own image paste. Ctrl+V elsewhere.
 */
export function isTerminalPasteKey(
  event: KeyboardEvent,
  mac: boolean = isMacHost(),
): boolean {
  if (event.type !== "keydown") {
    return false;
  }
  if (event.altKey) {
    return false;
  }
  const isV = event.key.toLowerCase() === "v" || event.code === "KeyV";
  if (!isV) {
    return false;
  }
  if (event.metaKey && !event.ctrlKey) {
    return true;
  }
  if (event.ctrlKey && !event.metaKey) {
    return !mac;
  }
  return false;
}

export function pasteClipboardIntoTerminal(terminal: Terminal): void {
  if (pasteInFlight.has(terminal)) {
    return;
  }
  pasteInFlight.add(terminal);
  void window.headTerminal.clipboard.readForTerminal()
    .then((text) => {
      if (text) {
        logEvent("info", "terminal.clipboard_paste", {
          chars: text.length,
          image: /\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(text),
        });
        terminal.paste(text);
      }
    })
    .catch((error) => {
      logError("terminal.clipboard_read_failed", error);
    })
    .finally(() => {
      pasteInFlight.delete(terminal);
    });
}

function pathsFromFiles(files: ArrayLike<{ name?: string }> | null | undefined): string[] {
  if (!files || files.length === 0) {
    return [];
  }
  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    try {
      const path = window.headTerminal.clipboard.pathForFile(files[index] as File);
      if (path) {
        paths.push(path);
      }
    } catch {
      // Chromium may expose a File without a disk path (in-memory screenshot).
    }
  }
  return paths;
}

function pasteImportedPaths(terminal: Terminal, paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  if (pasteInFlight.has(terminal)) {
    return true;
  }
  pasteInFlight.add(terminal);
  void window.headTerminal.clipboard.importPaths(paths)
    .then((text) => {
      if (text) {
        logEvent("info", "terminal.clipboard_paste", {
          chars: text.length,
          image: true,
        });
        terminal.paste(text);
      }
    })
    .catch((error) => {
      logError("terminal.clipboard_drop_failed", error);
    })
    .finally(() => {
      pasteInFlight.delete(terminal);
    });
  return true;
}

export function attachTerminalPasteSurface(
  root: HTMLElement,
  terminal: Terminal,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTerminalPasteKey(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pasteClipboardIntoTerminal(terminal);
  };

  const onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (pasteImportedPaths(terminal, pathsFromFiles(event.clipboardData?.files))) {
      return;
    }
    pasteClipboardIntoTerminal(terminal);
  };

  const onDragOver = (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return;
    }
    const types = Array.from(transfer.types);
    if (!types.includes("Files")) {
      return;
    }
    event.preventDefault();
    transfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent) => {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pasteImportedPaths(terminal, pathsFromFiles(files));
  };

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("paste", onPaste, true);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("paste", onPaste, true);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("drop", onDrop);
  };
}
