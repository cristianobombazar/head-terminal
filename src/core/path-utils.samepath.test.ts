import { afterEach, describe, expect, it } from "vitest";

import { samePath } from "./path-utils";
import { setCachedPlatformInfoForTests } from "./platform-info";

afterEach(() => {
  setCachedPlatformInfoForTests(null);
});

function host(platform: NodeJS.Platform): void {
  setCachedPlatformInfoForTests({ platform, arch: "x64", homeDir: "/home/x" });
}

describe("samePath (renderer)", () => {
  it("folds case on macOS and Windows, where the filesystem does", () => {
    host("darwin");
    expect(samePath("/Users/x/Dev/App", "/users/x/dev/app/")).toBe(true);
    host("win32");
    expect(samePath("C:/Users/x/App", "c:/users/x/app/")).toBe(true);
  });

  it("compares exactly on Linux", () => {
    host("linux");
    expect(samePath("/home/x/App", "/home/x/app")).toBe(false);
    expect(samePath("/home/x/app/", "/home/x/app")).toBe(true);
  });

  it("treats NFC and NFD as one folder everywhere", () => {
    host("linux");
    expect(samePath("/home/x/ação".normalize("NFC"), "/home/x/ação".normalize("NFD"))).toBe(true);
  });
});
