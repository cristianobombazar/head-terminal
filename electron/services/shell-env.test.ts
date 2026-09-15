import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  adoptLoginShellPath,
  mergePath,
  parseLoginShellPath,
  readLoginShellPath,
  resolveLoginShell,
  type ShellProcess,
  type SpawnShell,
} from "./shell-env";

const MARKER = "__HEAD_TERMINAL_PATH__";

function fakeShell(behaviour: {
  stdout?: string;
  exitCode?: number | null;
  error?: Error;
  hang?: boolean;
}): {
  spawn: SpawnShell;
  calls: Array<{ command: string; args: string[] }>;
  killed: boolean[];
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const killed: boolean[] = [];
  const spawn: SpawnShell = (command, args) => {
    calls.push({ command, args });
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdout,
      kill: (_signal?: NodeJS.Signals) => {
        killed.push(true);
        return true;
      },
    }) as unknown as ShellProcess;
    setImmediate(() => {
      if (behaviour.error) {
        emitter.emit("error", behaviour.error);
        return;
      }
      if (behaviour.stdout !== undefined) {
        stdout.write(behaviour.stdout);
      }
      stdout.end();
      if (!behaviour.hang) {
        emitter.emit("close", behaviour.exitCode ?? 0);
      }
    });
    return child;
  };
  return { spawn, calls, killed };
}

describe("resolveLoginShell", () => {
  it("uses $SHELL when it is an absolute path", () => {
    expect(resolveLoginShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe(
      "/opt/homebrew/bin/fish",
    );
  });

  it("falls back to zsh, the macOS default", () => {
    expect(resolveLoginShell({})).toBe("/bin/zsh");
    expect(resolveLoginShell({ SHELL: "zsh" })).toBe("/bin/zsh");
  });
});

describe("parseLoginShellPath", () => {
  it("reads the value between the markers and ignores rc chatter", () => {
    const output = `Now using node v24.1.0\n${MARKER}/opt/homebrew/bin:/usr/bin${MARKER}\n% `;
    expect(parseLoginShellPath(output)).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("is null without both markers or with an empty value", () => {
    expect(parseLoginShellPath("nothing here")).toBeNull();
    expect(parseLoginShellPath(`${MARKER}/usr/bin`)).toBeNull();
    expect(parseLoginShellPath(`${MARKER}${MARKER}`)).toBeNull();
  });
});

describe("mergePath", () => {
  it("puts the shell's entries first and keeps what only the process had", () => {
    expect(mergePath("/usr/bin:/bin:/custom", "/opt/homebrew/bin:/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin:/custom",
    );
  });

  it("drops duplicates and empty entries", () => {
    expect(mergePath(undefined, "/a::/b:/a")).toBe("/a:/b");
  });
});

describe("readLoginShellPath", () => {
  it("asks an interactive login shell and parses its answer", async () => {
    const shell = fakeShell({ stdout: `banner\n${MARKER}/x:/y${MARKER}\n` });
    const result = await readLoginShellPath({
      env: { SHELL: "/bin/zsh" },
      spawn: shell.spawn,
    });
    expect(result).toBe("/x:/y");
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0].command).toBe("/bin/zsh");
    expect(shell.calls[0].args[0]).toBe("-ilc");
    expect(shell.calls[0].args[1]).toContain('"$PATH"');
  });

  it("is null when the shell fails to start", async () => {
    const shell = fakeShell({
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    });
    expect(await readLoginShellPath({ env: {}, spawn: shell.spawn })).toBeNull();
  });

  it("kills a shell that hangs and gives up", async () => {
    const shell = fakeShell({ stdout: "stuck on a prompt", hang: true });
    const result = await readLoginShellPath({
      env: {},
      spawn: shell.spawn,
      timeoutMs: 20,
    });
    expect(result).toBeNull();
    expect(shell.killed).toEqual([true]);
  });
});

describe("adoptLoginShellPath", () => {
  it("does nothing off macOS, without even spawning a shell", async () => {
    const shell = fakeShell({ stdout: `${MARKER}/x${MARKER}` });
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    expect(
      await adoptLoginShellPath({ env, platform: "win32", spawn: shell.spawn }),
    ).toBe(false);
    expect(
      await adoptLoginShellPath({ env, platform: "linux", spawn: shell.spawn }),
    ).toBe(false);
    expect(env.PATH).toBe("C:\\Windows");
    expect(shell.calls).toHaveLength(0);
  });

  it("merges the shell PATH into the environment on macOS", async () => {
    const shell = fakeShell({
      stdout: `${MARKER}/opt/homebrew/bin:/usr/bin:/bin${MARKER}`,
    });
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh",
    };
    expect(
      await adoptLoginShellPath({ env, platform: "darwin", spawn: shell.spawn }),
    ).toBe(true);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("leaves the environment alone when the shell had nothing new", async () => {
    const shell = fakeShell({ stdout: `${MARKER}/usr/bin:/bin${MARKER}` });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    expect(
      await adoptLoginShellPath({ env, platform: "darwin", spawn: shell.spawn }),
    ).toBe(false);
    expect(env.PATH).toBe("/usr/bin:/bin");
  });
});
