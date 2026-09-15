import type { PlatformInfo } from "../../electron/types/api";
import { logError } from "./logger";

/**
 * Cached copy of `window.headTerminal.system.getPlatform()`. Fetched once at
 * boot (see main.tsx) so that by the time the first pane spawns a terminal —
 * after session-store hydration, itself async — the host platform is already
 * known to `createConfiguredTerminal` (`windowsPty`) and to the agent profile
 * builders (PowerShell vs zsh). `null` until the fetch resolves; callers
 * treat that the same as "unknown".
 */
let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo | null> | null = null;

export function initPlatformInfo(): void {
  if (pending) {
    return;
  }
  pending = window.headTerminal.system
    .getPlatform()
    .then((info) => {
      cached = info;
      return info;
    })
    .catch((error) => {
      logError("platform-info.fetch_failed", error);
      return null;
    });
}

export function getCachedPlatformInfo(): PlatformInfo | null {
  return cached;
}

/** Resolves once the fetch settles; `null` when it failed or never started. */
export function whenPlatformInfo(): Promise<PlatformInfo | null> {
  return pending ?? Promise.resolve(cached);
}

/** True only once the host is known to be Windows. Panes there run natively. */
export function isWindowsHost(): boolean {
  return cached?.platform === "win32";
}

/**
 * macOS host. Decides the ⌘-vs-Ctrl question for every app shortcut, which
 * the very first keydown may ask before the platform fetch has settled, so
 * until then the answer comes from the user agent the same way Chromium
 * itself tells the two apart.
 */
export function isMacHost(): boolean {
  if (cached) {
    return cached.platform === "darwin";
  }
  return typeof navigator !== "undefined" && /mac/iu.test(navigator.platform);
}

/** Linux host — the only one where the main process records voice itself. */
export function isLinuxHost(): boolean {
  if (cached) {
    return cached.platform === "linux";
  }
  return typeof navigator !== "undefined" && /linux/iu.test(navigator.userAgent);
}

/** Test seam. */
export function setCachedPlatformInfoForTests(info: PlatformInfo | null): void {
  cached = info;
  pending = info ? Promise.resolve(info) : null;
}
