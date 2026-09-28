import { stat } from "node:fs/promises";
import path from "node:path";

type StatPath = (target: string) => Promise<{ isDirectory(): boolean }>;

/**
 * The folder a path handed to the app opens in: the folder itself, or the one
 * a file sits in (a file dropped on the Dock icon). Null for anything that is
 * not an absolute path to something that exists — there is nothing to open.
 */
export async function resolveOpenedFolder(
  target: unknown,
  statPath: StatPath = stat,
): Promise<string | null> {
  if (typeof target !== "string" || target.includes("\0") || !path.isAbsolute(target)) {
    return null;
  }
  const normalized = path.normalize(target);
  try {
    return (await statPath(normalized)).isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    return null;
  }
}

/**
 * Folders sent from outside the app — Finder's "New Head Terminal Session
 * Here", a folder dropped on the Dock icon — on their way to the renderer.
 * One can arrive before there is a renderer to take it (a cold launch, or the
 * window closed with the app still running), so it waits here until the
 * renderer asks; from then on each goes straight to it. Only the latest one
 * waits: it is what the user asked for last.
 */
export class FolderInbox {
  private pending: string | null = null;
  private deliver: ((folder: string) => void) | null = null;

  /** Hands `folder` to the renderer, or keeps it for when it asks. True when
   * it was handed over. */
  receive(folder: string): boolean {
    if (this.deliver) {
      this.deliver(folder);
      return true;
    }
    this.pending = folder;
    return false;
  }

  /** The renderer listens from now on: returns what waited, if anything. */
  attach(deliver: (folder: string) => void): string | null {
    this.deliver = deliver;
    const folder = this.pending;
    this.pending = null;
    return folder;
  }

  /** The renderer is gone (its window closed). */
  detach(): void {
    this.deliver = null;
  }
}
