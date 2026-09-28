import { isWindowsPath, joinPath } from "./path-join";
import { isMacHost, isWindowsHost } from "./platform-info";

export { isWindowsPath, joinPath };

export function truncatePathMiddle(path: string, maxLength = 28): string {
  if (path.length <= maxLength) {
    return path;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);

  return `${path.slice(0, headLength)}…${path.slice(-tailLength)}`;
}

/**
 * Same folder, whichever way it was spelled? Trailing separators and Unicode
 * form never matter; case does not either on Windows and macOS (APFS), where
 * a folder picked in the native dialog and the same one typed by hand may
 * differ only there. Linux compares exactly.
 */
export function samePath(a: string, b: string): boolean {
  const fold = isWindowsHost() || isMacHost();
  const normalize = (value: string) => {
    const spelled = value.normalize("NFC").replace(/[\\/]+$/u, "");
    return fold ? spelled.toLowerCase() : spelled;
  };
  return normalize(a) === normalize(b);
}

const WSL_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/iu;

/** Last segment of a path spelled with either separator. */
export function basenamePath(path: string, fallback = ""): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u);
  return parts[parts.length - 1] || fallback;
}

/**
 * `/mnt/c/Users/x` → `C:\Users\x`. Workspaces saved while panes ran inside
 * WSL carry these; anything else POSIX (`/home/...`) has no Windows
 * equivalent and yields null.
 */
export function legacyPosixToWindowsPath(path: string): string | null {
  const mounted = WSL_MOUNT.exec(path);
  if (!mounted) {
    return null;
  }
  const rest = (mounted[2] ?? "").replaceAll("/", "\\");
  return `${mounted[1].toUpperCase()}:\\${rest}`;
}
