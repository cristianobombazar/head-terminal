import { describe, expect, it } from "vitest";

import {
  claudeProjectDirCandidates,
  cursorProjectDirCandidates,
  encodeClaudeProjectDir,
  encodeCursorProjectDir,
  samePath,
} from "./agent-sessions-service";

describe("encodeClaudeProjectDir", () => {
  it("turns every non-alphanumeric into a dash without collapsing, as the CLI does", () => {
    // Observed on disk: ~/.claude/projects/C--Users-mathe-Videos-Grava--es-de-Tela
    expect(encodeClaudeProjectDir("C:/Users/mathe/Videos/Gravações de Tela")).toBe(
      "C--Users-mathe-Videos-Grava--es-de-Tela",
    );
    expect(encodeClaudeProjectDir("C:\\Users\\dev\\my-app")).toBe("C--Users-dev-my-app");
    expect(encodeClaudeProjectDir("/Users/ana/Documents/Meu Projeto")).toBe(
      "-Users-ana-Documents-Meu-Projeto",
    );
    expect(encodeClaudeProjectDir("/Users/ana/dev/my_app.v2")).toBe("-Users-ana-dev-my-app-v2");
  });

  it("keeps the older separator-only spelling as a fallback candidate", () => {
    expect(claudeProjectDirCandidates("/Users/ana/dev/my_app")).toEqual([
      "-Users-ana-dev-my-app",
      "-Users-ana-dev-my_app",
    ]);
    // Identical under both schemes: one candidate, not two.
    expect(claudeProjectDirCandidates("/home/dev/my.app")).toEqual(["-home-dev-my-app"]);
  });
});

describe("encodeCursorProjectDir", () => {
  it("collapses runs of dashes, which is why the drive colon vanishes", () => {
    expect(encodeCursorProjectDir("C:\\dev\\documentação")).toBe("C-dev-documenta-o");
    expect(encodeCursorProjectDir("/home/dev/my.app")).toBe("-home-dev-my-app");
  });

  it("tries the POSIX spelling with and without the leading dash", () => {
    expect(cursorProjectDirCandidates("/home/dev/my.app")).toEqual([
      "home-dev-my-app",
      "-home-dev-my-app",
    ]);
    expect(cursorProjectDirCandidates("C:\\Users\\me")).toEqual(["C-Users-me"]);
  });
});

describe("samePath for recorded cwds", () => {
  it("ignores case on macOS and Windows but not on Linux", () => {
    expect(samePath("/Users/x/Proj", "/Users/x/proj", "darwin")).toBe(true);
    expect(samePath("C:\\Users\\x\\Proj", "c:/users/x/proj/", "win32")).toBe(true);
    expect(samePath("/home/x/Proj", "/home/x/proj", "linux")).toBe(false);
  });

  it("treats NFC and NFD spellings of the same folder as equal", () => {
    const nfc = "/Users/x/Coração".normalize("NFC");
    const nfd = "/Users/x/Coração".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(samePath(nfc, nfd, "darwin")).toBe(true);
    expect(samePath(nfc, nfd, "linux")).toBe(true);
  });
});
