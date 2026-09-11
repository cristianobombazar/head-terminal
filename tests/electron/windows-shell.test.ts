import { describe, expect, it } from "vitest";

import {
  legacyPosixToWindowsPath,
  parseWslDistros,
  resolvePowerShell,
  resolveWindowsCwd,
  resolveWsl,
} from "../../electron/services/windows-shell";

const ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local",
  SystemRoot: "C:\\WINDOWS",
};

describe("WSL", () => {
  it("resolves wsl.exe from System32", () => {
    expect(resolveWsl(ENV)).toBe("C:\\WINDOWS\\System32\\wsl.exe");
  });

  it("lists distributions from `wsl -l -v`, default first, without Docker's", () => {
    const table = [
      "  NAME                   STATE           VERSION",
      "  docker-desktop         Running         2",
      "  Ubuntu-24.04           Stopped         2",
      "* Ubuntu                 Stopped         2",
      "  docker-desktop-data    Stopped         2",
      "",
    ].join("\r\n");
    expect(parseWslDistros(table)).toEqual(["Ubuntu", "Ubuntu-24.04"]);
  });

  it("reads the UTF-16LE output wsl.exe prints by default", () => {
    // Decoded as UTF-8, every UTF-16LE character carries a trailing NUL.
    const utf16AsUtf8 = "  NAME  STATE  VERSION\r\n* Ubuntu  Stopped  2\r\n"
      .split("")
      .join("\0");
    expect(parseWslDistros(utf16AsUtf8)).toEqual(["Ubuntu"]);
  });

  it("answers nothing when WSL is not installed", () => {
    expect(parseWslDistros("")).toEqual([]);
  });
});

describe("resolvePowerShell", () => {
  it("prefers PowerShell 7 from Program Files", () => {
    const present = new Set(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
    expect(resolvePowerShell({ env: ENV, exists: (path) => present.has(path) }))
      .toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("takes the Store install through its app execution alias", () => {
    // The alias is a reparse point: `stat` fails with EACCES, only `lstat`
    // sees it — which is what the default `exists` uses.
    const present = new Set(["C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"]);
    expect(resolvePowerShell({ env: ENV, exists: (path) => present.has(path) }))
      .toBe("C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe");
  });

  it("falls back to Windows PowerShell 5.1, which every build ships", () => {
    expect(resolvePowerShell({ env: ENV, exists: () => false }))
      .toBe("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});

describe("resolveWindowsCwd", () => {
  const existing = new Set(["C:\\Users\\m\\repo", "C:\\Users\\m"]);
  const exists = (path: string) => existing.has(path);

  it("keeps an existing native folder and normalises the separator", () => {
    expect(resolveWindowsCwd("C:\\Users\\m\\repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
    expect(resolveWindowsCwd("C:/Users/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
  });

  it("translates a WSL-era mount path and falls back otherwise", () => {
    expect(resolveWindowsCwd("/mnt/c/Users/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
    expect(resolveWindowsCwd("/home/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
    expect(resolveWindowsCwd("C:\\Users\\m\\gone", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
    expect(resolveWindowsCwd("relative", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
  });

  it("maps mount roots and rejects other POSIX paths", () => {
    expect(legacyPosixToWindowsPath("/mnt/d")).toBe("D:\\");
    expect(legacyPosixToWindowsPath("/tmp")).toBeNull();
  });
});
