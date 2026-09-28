// Path spelling shared with the main process: kept free of any renderer
// import, since main must build a profile's directory byte for byte the way
// the renderer does (the macOS Keychain entry is named after that string).

const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/u;

/** `C:\x`, `C:/x` or a UNC `\\server\share`. */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith("\\\\");
}

/** Joins with the separator the base already uses, so a Windows base stays Windows. */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = isWindowsPath(base) ? "\\" : "/";
  const root = base.replace(/[\\/]+$/u, "");
  return [root, ...segments].join(separator);
}
