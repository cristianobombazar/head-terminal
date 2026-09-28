import { describe, expect, it, vi } from "vitest";

import {
  accountFromClaudeJson,
  claudeLocation,
  ClaudeUsageAdapter,
  createClaudeTokenReader,
  keychainServiceName,
  parseClaudeUsage,
  planLabel,
  tokenFromCredentials,
} from "./claude-usage";
import type { HttpResponse, UsageAccount } from "./usage-service";

const HOME = "/home/ana";
const TAILWIND = "5f1bd932-f0a4-449b-89fb-85ec4f2d32dc";
const T0 = Date.parse("2026-09-28T15:00:00Z");
const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 24 * 3_600_000;

function usageBody(fivePercent: number, weekPercent: number) {
  return {
    five_hour: { utilization: fivePercent, resets_at: "2026-09-28T17:00:00.105327+00:00" },
    seven_day: { utilization: weekPercent, resets_at: "2026-10-04T17:00:00.105349+00:00" },
    limits: [
      {
        kind: "session",
        percent: fivePercent,
        resets_at: "2026-09-28T17:00:00.105327+00:00",
        scope: null,
      },
      {
        kind: "weekly_all",
        percent: weekPercent,
        resets_at: "2026-10-04T17:00:00.105349+00:00",
        scope: null,
      },
      {
        kind: "weekly_scoped",
        percent: 30,
        resets_at: "2026-10-04T17:00:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  };
}

function claudeJson(accountUuid: string | null, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...(accountUuid ? { oauthAccount: { accountUuid, organizationUuid: "org-1" } } : {}),
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

describe("parseClaudeUsage", () => {
  it("reads the five-hour, weekly and model windows from `limits`", () => {
    expect(parseClaudeUsage(usageBody(23, 45))).toEqual({
      windows: [
        {
          kind: "session",
          percent: 23,
          resetsAt: Date.parse("2026-09-28T17:00:00.105Z"),
          windowMs: FIVE_HOURS,
        },
        {
          kind: "week",
          percent: 45,
          resetsAt: Date.parse("2026-10-04T17:00:00.105Z"),
          windowMs: WEEK,
        },
      ],
      extra: [
        {
          kind: "week",
          label: "Fable",
          percent: 30,
          resetsAt: Date.parse("2026-10-04T17:00:00Z"),
          windowMs: WEEK,
        },
      ],
    });
  });

  it("falls back to the named windows of the older schema", () => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 7.6, resets_at: null },
        seven_day: { utilization: 130, resets_at: "not a date" },
        seven_day_opus: { utilization: 5, resets_at: null },
        seven_day_sonnet: null,
      }),
    ).toEqual({
      windows: [
        { kind: "session", percent: 8, resetsAt: null, windowMs: FIVE_HOURS },
        { kind: "week", percent: 100, resetsAt: null, windowMs: WEEK },
      ],
      extra: [{ kind: "week", label: "Opus", percent: 5, resetsAt: null, windowMs: WEEK }],
    });
  });

  it("is null for a body with no window — an in-band error", () => {
    expect(parseClaudeUsage({ error: { type: "rate_limit_error" } })).toBeNull();
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage([usageBody(1, 1)])).toBeNull();
    expect(
      parseClaudeUsage({ limits: [{ kind: "session", percent: "12" }], five_hour: null }),
    ).toBeNull();
  });
});

describe("plan and login", () => {
  it("names the plan the way claude.ai does", () => {
    expect(planLabel("max", "default_claude_max_5x")).toBe("Max 5x");
    expect(planLabel("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(planLabel("max", null)).toBe("Max");
    expect(planLabel("pro", "default_claude_ai")).toBe("Pro");
    expect(planLabel("team", "default_claude_max_5x")).toBe("Team");
    expect(planLabel(undefined, undefined)).toBeUndefined();
  });

  it("takes the subscription login out of a credentials entry", () => {
    expect(
      tokenFromCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat",
            refreshToken: "sk-ant-ort",
            expiresAt: 1790000000000,
            subscriptionType: "pro",
          },
        }),
      ),
    ).toEqual({ value: "sk-ant-oat", expiresAt: 1790000000000, plan: "Pro" });
    expect(tokenFromCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(tokenFromCredentials("{broken")).toBeNull();
  });

  it("finds a profile's login in its own folder, the shell's split across the home", () => {
    const profileDir = `${HOME}/.head-terminal/claude-profiles/${TAILWIND}`;
    expect(claudeLocation(HOME, TAILWIND)).toEqual({
      claudeJson: `${profileDir}/.claude.json`,
      credentialsDir: profileDir,
      keychainService: keychainServiceName(profileDir),
    });
    expect(claudeLocation("C:\\Users\\ana", "global")).toEqual({
      claudeJson: "C:\\Users\\ana\\.claude.json",
      credentialsDir: "C:\\Users\\ana\\.claude",
      keychainService: "Claude Code-credentials",
    });
    expect(keychainServiceName(profileDir)).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(keychainServiceName(`${HOME}/.head-terminal/claude-profiles/default`)).not.toBe(
      keychainServiceName(profileDir),
    );
  });

  it("reads the Keychain on macOS and falls back to the file", async () => {
    const location = claudeLocation(HOME, TAILWIND);
    const keychain = vi.fn(async () => null as string | null);
    const read = createClaudeTokenReader({
      platform: "darwin",
      readKeychain: keychain,
      readText: async () => JSON.stringify({ claudeAiOauth: { accessToken: "from-file" } }),
    });
    expect(await read(location)).toEqual({ value: "from-file" });
    expect(keychain).toHaveBeenCalledWith(location.keychainService);

    keychain.mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: "from-keychain" } }),
    );
    expect(await read(location)).toEqual({ value: "from-keychain" });
  });

  it("reads only the file elsewhere, and a missing file is no token", async () => {
    const keychain = vi.fn(async () => "never");
    const paths: string[] = [];
    const read = createClaudeTokenReader({
      platform: "win32",
      readKeychain: keychain,
      readText: async (path) => {
        paths.push(path);
        throw new Error("ENOENT");
      },
    });
    expect(await read(claudeLocation("C:\\Users\\ana", "default"))).toBeNull();
    expect(paths).toEqual([
      "C:\\Users\\ana\\.head-terminal\\claude-profiles\\default\\.credentials.json",
    ]);
    expect(keychain).not.toHaveBeenCalled();
  });
});

describe("accountFromClaudeJson", () => {
  it("keys the account by account and organization", () => {
    expect(accountFromClaudeJson(claudeJson("acc-1"))).toEqual({
      accountKey: "acc-1:org-1",
      cached: null,
    });
  });

  it("is signed out without an OAuth account, and null while unparseable", () => {
    expect(accountFromClaudeJson(claudeJson(null))).toEqual({ accountKey: null, cached: null });
    expect(accountFromClaudeJson('{"oauthAccount": {"accountUu')).toBeNull();
  });

  it("keeps the /usage snapshot only when it is this account's", () => {
    const snapshot = (accountUuid: string) =>
      claudeJson("acc-1", {
        cachedUsageUtilization: { fetchedAtMs: T0, accountUuid, utilization: usageBody(3, 66) },
      });
    expect(accountFromClaudeJson(snapshot("acc-1"))?.cached).toEqual({
      fetchedAt: T0,
      usage: parseClaudeUsage(usageBody(3, 66)),
    });
    expect(accountFromClaudeJson(snapshot("someone-else"))?.cached).toBeNull();
  });
});

describe("ClaudeUsageAdapter", () => {
  function adapter() {
    const files = new Map<string, { text: string; mtimeMs: number }>();
    const clock = { now: T0 };
    const read = new ClaudeUsageAdapter({
      home: () => HOME,
      now: () => clock.now,
      readToken: async (location) => ({ value: `token-for:${location.credentialsDir}` }),
      readText: async (path) => {
        const file = files.get(path);
        if (!file) throw new Error("ENOENT");
        return file.text;
      },
      statFile: async (path) => {
        const file = files.get(path);
        if (!file) throw new Error("ENOENT");
        return { mtimeMs: file.mtimeMs, size: file.text.length };
      },
    });
    const write = (path: string, text: string, mtimeMs = clock.now) =>
      files.set(path, { text, mtimeMs });
    return { read, write, clock };
  }
  const profileJson = `${HOME}/.head-terminal/claude-profiles/${TAILWIND}/.claude.json`;

  it("finds the account a profile is signed in to, and the login to read it with", async () => {
    const h = adapter();
    h.write(profileJson, claudeJson("acc-1"));

    const account = (await h.read.account({
      provider: "claude",
      profileId: TAILWIND,
    })) as UsageAccount;

    expect(account.key).toBe("acc-1:org-1");
    expect(await account.readToken()).toEqual({
      value: `token-for:${HOME}/.head-terminal/claude-profiles/${TAILWIND}`,
    });
  });

  it("reads the shell's ~/.claude for the global target", async () => {
    const h = adapter();
    h.write(`${HOME}/.claude.json`, claudeJson("acc-9"));

    const account = (await h.read.account({ provider: "claude", profileId: "global" })) as
      | UsageAccount;

    expect(account.key).toBe("acc-9:org-1");
    expect(await account.readToken()).toEqual({ value: `token-for:${HOME}/.claude` });
  });

  it("is signed out without an account, and ignores what is not a profile", async () => {
    const h = adapter();
    h.write(`${HOME}/.head-terminal/claude-profiles/default/.claude.json`, claudeJson(null));

    expect(await h.read.account({ provider: "claude", profileId: "default" })).toBe(
      "signed-out",
    );
    expect(await h.read.account({ provider: "claude", profileId: TAILWIND })).toBe("signed-out");
    expect(await h.read.account({ provider: "claude", profileId: "../../etc" })).toBeNull();
    expect(await h.read.account({ provider: "codex" })).toBeNull();
  });

  it("parses a rewritten .claude.json at most every 30 seconds", async () => {
    const h = adapter();
    const target = { provider: "claude", profileId: TAILWIND } as const;
    h.write(profileJson, claudeJson("acc-1"));
    await h.read.account(target);

    h.write(profileJson, claudeJson("acc-2"), T0 + 1);
    h.clock.now += 10_000;
    expect(((await h.read.account(target)) as UsageAccount).key).toBe("acc-1:org-1");
    h.clock.now += 20_000;
    expect(((await h.read.account(target)) as UsageAccount).key).toBe("acc-2:org-1");
  });

  it("keeps the account while .claude.json is being rewritten", async () => {
    const h = adapter();
    const target = { provider: "claude", profileId: TAILWIND } as const;
    h.write(profileJson, claudeJson("acc-1"));
    await h.read.account(target);

    h.write(profileJson, '{"oauthAccount": {"accou', T0 + 1);
    h.clock.now += 30_000;
    expect(((await h.read.account(target)) as UsageAccount).key).toBe("acc-1:org-1");
  });

  it("asks the /usage endpoint with the OAuth token", async () => {
    const h = adapter();
    const http = vi.fn(async () => response(200, usageBody(12, 40)));

    const outcome = await h.read.fetchUsage({ value: "oat" }, http);

    expect(http).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: "Bearer oat",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });
    expect(outcome).toEqual({ kind: "ok", usage: parseClaudeUsage(usageBody(12, 40)) });
  });
});
