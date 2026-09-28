import { describe, expect, it, vi } from "vitest";

import {
  cursorAuthPaths,
  cursorLoginFrom,
  CursorUsageAdapter,
  parseCursorUsage,
} from "./cursor-usage";
import type { HttpResponse, UsageAccount } from "./usage-service";

const EXP = 1_792_000_000;
const ACCESS_TOKEN = `h.${Buffer.from(
  JSON.stringify({ sub: "google-oauth2|user_01", exp: EXP }),
).toString("base64url")}.s`;
const START = 1788865649000;
const END = 1791457649000;

/** What `GetCurrentPeriodUsage` answered on 2026-09-28, trimmed. */
const BODY = {
  billingCycleStart: String(START),
  billingCycleEnd: String(END),
  planUsage: {
    totalSpend: 26934,
    includedSpend: 2000,
    limit: 2000,
    autoPercentUsed: 17.937142857142856,
    apiPercentUsed: 40.5,
    totalPercentUsed: 21.5472,
  },
  enabled: true,
};

function response(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe("Cursor login", () => {
  it("is looked for where cursor-agent keeps it on each system", () => {
    expect(cursorAuthPaths("C:\\Users\\ana", "win32", { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" })).toEqual([
      "C:\\Users\\ana\\AppData\\Roaming\\Cursor\\auth.json",
    ]);
    expect(cursorAuthPaths("/Users/ana", "darwin", {})[0]).toBe(
      "/Users/ana/Library/Application Support/Cursor/auth.json",
    );
    expect(cursorAuthPaths("/home/ana", "linux", { XDG_CONFIG_HOME: "/cfg" })[0]).toBe(
      "/cfg/cursor/auth.json",
    );
  });

  it("reads the token, who it belongs to and when it expires", () => {
    expect(cursorLoginFrom(JSON.stringify({ accessToken: ACCESS_TOKEN, refreshToken: "r" }))).toEqual({
      accessToken: ACCESS_TOKEN,
      subject: "google-oauth2|user_01",
      expiresAt: EXP * 1000,
    });
    expect(cursorLoginFrom("{}")).toBeNull();
    expect(cursorLoginFrom("nope")).toBeNull();
  });
});

describe("parseCursorUsage", () => {
  it("reads the cycle's total and API pools, with Auto as detail", () => {
    const cycle = { resetsAt: END, windowMs: END - START };
    expect(parseCursorUsage(BODY)).toEqual({
      windows: [
        { kind: "cycle", label: "Total", percent: 22, ...cycle },
        { kind: "cycle", label: "API", percent: 41, ...cycle },
      ],
      extra: [{ kind: "cycle", label: "Auto", percent: 18, ...cycle }],
    });
  });

  it("is null for a plan billed another way", () => {
    expect(parseCursorUsage({ enabled: false })).toBeNull();
    expect(parseCursorUsage({ planUsage: {} })).toBeNull();
  });
});

describe("CursorUsageAdapter", () => {
  function adapter(files: Record<string, string>) {
    return new CursorUsageAdapter({
      home: () => "/home/ana",
      platform: "linux",
      env: {},
      readText: async (path) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path];
      },
    });
  }
  const login = JSON.stringify({ accessToken: ACCESS_TOKEN, refreshToken: "r" });

  it("takes the first login found and reads with it", async () => {
    const read = adapter({ "/home/ana/.cursor/auth.json": login });

    const account = (await read.account({ provider: "cursor" })) as UsageAccount;

    expect(account.key).toBe("google-oauth2|user_01");
    expect(await account.readToken()).toEqual({ value: ACCESS_TOKEN, expiresAt: EXP * 1000 });
  });

  it("has nothing to show without a login", async () => {
    expect(await adapter({}).account({ provider: "cursor" })).toBeNull();
    expect(await adapter({ "/home/ana/.cursor/auth.json": login }).account({ provider: "codex" }))
      .toBeNull();
  });

  it("asks for the cycle, then once for the plan", async () => {
    const http = vi.fn(async (url: string) =>
      url.endsWith("full_stripe_profile")
        ? response(200, { membershipType: "enterprise" })
        : response(200, BODY),
    );
    const read = adapter({});

    const outcome = await read.fetchUsage({ value: "tok" }, http, {});

    expect(http.mock.calls[0]).toEqual([
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
          "connect-protocol-version": "1",
        },
        body: "{}",
      },
    ]);
    expect(outcome).toEqual({
      kind: "ok",
      usage: { ...parseCursorUsage(BODY), plan: "Enterprise" },
    });

    http.mockClear();
    await read.fetchUsage({ value: "tok" }, http, { plan: "Enterprise" });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("reads the plan again after a few hours, in case it changed", async () => {
    const clock = { now: 1_790_000_000_000 };
    const read = new CursorUsageAdapter({
      home: () => "/home/ana",
      platform: "linux",
      env: {},
      readText: async () => {
        throw new Error("ENOENT");
      },
      now: () => clock.now,
    });
    const http = vi.fn(async (url: string) =>
      url.endsWith("full_stripe_profile")
        ? response(200, { membershipType: "pro" })
        : response(200, BODY),
    );

    await read.fetchUsage({ value: "tok" }, http, {});
    clock.now += 5 * 3_600_000;
    await read.fetchUsage({ value: "tok" }, http, { plan: "Pro" });
    expect(http).toHaveBeenCalledTimes(3);

    clock.now += 3_600_000;
    const outcome = await read.fetchUsage({ value: "tok" }, http, { plan: "Pro" });
    expect(http).toHaveBeenCalledTimes(5);
    expect(outcome).toMatchObject({ kind: "ok", usage: { plan: "Pro" } });
  });

  it("keeps the numbers when the plan cannot be read", async () => {
    const http = vi.fn(async (url: string) =>
      url.endsWith("full_stripe_profile") ? response(500, {}) : response(200, BODY),
    );

    expect(await adapter({}).fetchUsage({ value: "tok" }, http, {})).toEqual({
      kind: "ok",
      usage: parseCursorUsage(BODY),
    });
  });
});
