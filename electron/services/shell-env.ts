import { spawn as nodeSpawn } from "node:child_process";

/**
 * A macOS app started from the Finder, the Dock or Spotlight inherits
 * launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — and nothing the user's
 * shell adds: no Homebrew, no nvm, no `~/.local/bin`. Every CLI the app
 * spawns from the main process (`git`, `ollama`, the agents behind the
 * brainstorm) and every pane that inherits `process.env` would then fail to
 * find tools that work fine in Terminal.app. The fix is the one every
 * Electron app on macOS ends up with: ask the user's login shell what *its*
 * PATH is, once, and adopt it.
 *
 * Windows never goes through here — its PATH is read from the registry by the
 * installer service — and Linux desktop launchers already source the rc files
 * (see scripts/head-terminal-env.sh).
 */

const MARKER = "__HEAD_TERMINAL_PATH__";
/** Always the POSIX separator: this only ever runs against a macOS shell, and
 * `path.delimiter` would follow the host the tests happen to run on. */
const PATH_DELIMITER = ":";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SHELL = "/bin/zsh";

export interface ShellProcess {
  stdout: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnShell = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "ignore"] },
) => ShellProcess;

export interface LoginShellPathOptions {
  /** The user's shell. Defaults to `$SHELL`, else `/bin/zsh`. */
  shell?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: SpawnShell;
}

/** `$SHELL` when it is an absolute path; anything else falls back to zsh. */
export function resolveLoginShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  return shell && shell.startsWith("/") ? shell : DEFAULT_SHELL;
}

/**
 * The PATH between the two markers, or null when the shell never printed it.
 * Markers keep rc-file chatter — `nvm` banners, `compinit` warnings, a
 * prompt written to stdout — from being mistaken for the value.
 */
export function parseLoginShellPath(output: string): string | null {
  const start = output.indexOf(MARKER);
  if (start < 0) {
    return null;
  }
  const end = output.indexOf(MARKER, start + MARKER.length);
  if (end < 0) {
    return null;
  }
  const value = output.slice(start + MARKER.length, end).trim();
  return value.length > 0 ? value : null;
}

/**
 * The shell's PATH first, then whatever the process already had that the
 * shell did not mention — an entry the launcher added on purpose must not
 * disappear just because the rc files never heard of it.
 */
export function mergePath(current: string | undefined, fromShell: string): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...fromShell.split(PATH_DELIMITER), ...(current ?? "").split(PATH_DELIMITER)]) {
    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(PATH_DELIMITER);
}

/**
 * Asks an interactive login shell for its PATH. Interactive *and* login,
 * because zsh reads `.zprofile` (where `brew shellenv` lives) only as a login
 * shell and `.zshrc` (where nvm lives) only when interactive. Stdin is closed
 * so an rc file that prompts cannot hang the app; a shell that takes longer
 * than the timeout is killed and the answer is null.
 */
export function readLoginShellPath(
  options: LoginShellPathOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const shell = options.shell ?? resolveLoginShell(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnShell);
  const script = `command printf '\\n${MARKER}%s${MARKER}\\n' "$PATH"`;

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let child: ShellProcess | null = null;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawn(shell, ["-ilc", script], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(parseLoginShellPath(output)));
  });
}

/**
 * Adopts the login shell's PATH into `env` on macOS. Returns whether it
 * changed anything. Every other platform is a no-op, so the call is safe
 * unconditionally at startup.
 */
export async function adoptLoginShellPath(
  options: LoginShellPathOptions & { platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return false;
  }
  const env = options.env ?? process.env;
  const fromShell = await readLoginShellPath({ ...options, env });
  if (!fromShell) {
    return false;
  }
  const merged = mergePath(env.PATH, fromShell);
  if (merged === env.PATH) {
    return false;
  }
  env.PATH = merged;
  return true;
}
