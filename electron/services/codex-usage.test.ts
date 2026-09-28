import { describe, expect, it, vi } from "vitest";

import {
  codexHome,
  codexLoginFrom,
  CodexUsageAdapter,
  parseCodexUsage,
} from "./codex-usage";
import type { HttpResponse, UsageAccount } from "./usage-service";

const EXP = 1_791_000_000;
const ACCESS_TOKEN = `h.${Buffer.from(JSON.stringify({ exp: EXP })).toString("base64url")}.s`;

/** What `/wham/usage` answered on 2026-09-28, trimmed. */
const BODY = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 1,
      limit_window_seconds: 18000,
      reset_after_seconds: 12679,
      reset_at: 1790630361,
    },
    secondary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 599479,
      reset_at: 1791217161,
    },
  },
  additional_rate_limits: [
    {
      limit_name: "gpt-reserve",
      rate_limit: {
        primary_window: {
          used_percent: 80,
          limit_window_seconds: 604800,
          reset_at: 1791222483,
        },
        secondary_window: null,
      },
    },
  ],
};

function auth(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "id", access_token: ACCESS_TOKEN, refresh_token: "r", account_id: "acc-7" },
    ...extra,
  });
}

function response(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe("Codex login", () => {
  it("lives in CODEX_HOME, else ~/.codex", () => {
    expect(codexHome("C:\\Users\\ana", {})).toBe("C:\\Users\\ana\\.codex");
    expect(codexHome("/home/ana", { CODEX_HOME: "/data/codex" })).toBe("/data/codex");
  });

  it("reads the ChatGPT login, and tells an API key apart", () => {
    expect(codexLoginFrom(auth())).toEqual({ accessToken: ACCESS_TOKEN, accountId: "acc-7" });
    expect(codexLoginFrom(JSON.stringify({ OPENAI_API_KEY: "sk-1" }))).toBe("api-key");
    expect(codexLoginFrom(auth({ auth_mode: "apikey" }))).toBe("api-key");
    expect(codexLoginFrom("{")).toBeNull();
    expect(codexLoginFrom("{}")).toBeNull();
  });
});

describe("parseCodexUsage", () => {
  it("reads the five hours, the week and the narrower limits", () => {
    expect(parseCodexUsage(BODY)).toEqual({
      plan: "Plus",
      windows: [
        { kind: "session", percent: 1, resetsAt: 1790630361000, windowMs: 18_000_000 },
        { kind: "week", percent: 0, resetsAt: 1791217161000, windowMs: 604_800_000 },
      ],
      extra: [
        {
          kind: "week",
          label: "gpt-reserve",
          percent: 80,
          resetsAt: 1791222483000,
          windowMs: 604_800_000,
        },
      ],
    });
  });

  it("is null without any window", () => {
    expect(parseCodexUsage({ plan_type: "plus", rate_limit: null })).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
  });
});

describe("CodexUsageAdapter", () => {
  function adapter(text: string | null) {
    const paths: string[] = [];
    const read = new CodexUsageAdapter({
      home: () => "/home/ana",
      env: {},
      readText: async (path) => {
        paths.push(path);
        if (text === null) throw new Error("ENOENT");
        return text;
      },
    });
    return { read, paths };
  }

  it("reads with the ChatGPT token, its account header and its expiry", async () => {
    const h = adapter(auth());

    const account = (await h.read.account({ provider: "codex" })) as UsageAccount;

    expect(h.paths[0]).toBe("/home/ana/.codex/auth.json");
    expect(account.key).toBe("acc-7");
    expect(await account.readToken()).toEqual({
      value: ACCESS_TOKEN,
      expiresAt: EXP * 1000,
      headers: { "ChatGPT-Account-Id": "acc-7" },
    });
  });

  it("has nothing to show on an API key or without a login", async () => {
    expect(await adapter(JSON.stringify({ OPENAI_API_KEY: "sk" })).read.account({
      provider: "codex",
    })).toBeNull();
    expect(await adapter(null).read.account({ provider: "codex" })).toBeNull();
    expect(await adapter(auth()).read.account({ provider: "cursor" })).toBeNull();
  });

  it("asks the endpoint behind /status", async () => {
    const http = vi.fn(async () => response(200, BODY));

    const outcome = await adapter(auth()).read.fetchUsage(
      { value: "tok", headers: { "ChatGPT-Account-Id": "acc-7" } },
      http,
    );

    expect(http).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        Authorization: "Bearer tok",
        Accept: "application/json",
        "ChatGPT-Account-Id": "acc-7",
      },
    });
    expect(outcome).toEqual({ kind: "ok", usage: parseCodexUsage(BODY) });
  });
});
