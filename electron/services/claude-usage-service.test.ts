import { describe, expect, it, vi } from "vitest";

import {
  accountFromClaudeJson,
  ClaudeUsageService,
  createTokenReader,
  keychainServiceName,
  parseUsageBody,
  planLabel,
  retryAfterMs,
  tokenFromCredentials,
  type OAuthToken,
} from "./claude-usage-service";

const HOME = "/home/ana";
const TAILWIND = "5f1bd932-f0a4-449b-89fb-85ec4f2d32dc";
const NSUITE = "6ba16a87-5231-424c-b764-9e2be57ce88b";
const T0 = Date.parse("2026-09-28T15:00:00Z");

function profileDir(id: string): string {
  return `${HOME}/.head-terminal/claude-profiles/${id}`;
}

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
    ...(accountUuid
      ? { oauthAccount: { accountUuid, organizationUuid: "org-1", emailAddress: "a@b.c" } }
      : {}),
    ...extra,
  });
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

interface Harness {
  service: ClaudeUsageService;
  fetch: ReturnType<typeof vi.fn>;
  files: Map<string, { text: string; mtimeMs: number }>;
  tokens: Map<string, OAuthToken | null>;
  clock: { now: number };
}

function harness(): Harness {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const tokens = new Map<string, OAuthToken | null>();
  const clock = { now: T0 };
  const fetch = vi.fn(async () => response(200, usageBody(12, 40)));
  const service = new ClaudeUsageService({
    home: () => HOME,
    fetch,
    now: () => clock.now,
    readToken: async (configDir) => tokens.get(configDir) ?? null,
    readText: async (path) => {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return file.text;
    },
    statFile: async (path) => {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: file.mtimeMs, size: file.text.length };
    },
  });
  return { service, fetch, files, tokens, clock };
}

function signIn(
  h: Harness,
  id: string,
  accountUuid: string,
  token: Partial<OAuthToken> = {},
  extra: Record<string, unknown> = {},
) {
  h.files.set(`${profileDir(id)}/.claude.json`, {
    text: claudeJson(accountUuid, extra),
    mtimeMs: h.clock.now,
  });
  h.tokens.set(profileDir(id), {
    accessToken: `token-${id}`,
    expiresAt: h.clock.now + 8 * 3_600_000,
    plan: "Max 5x",
    ...token,
  });
}

describe("parseUsageBody", () => {
  it("reads the five-hour, weekly and model windows from `limits`", () => {
    expect(parseUsageBody(usageBody(23, 45))).toEqual({
      fiveHour: { percent: 23, resetsAt: Date.parse("2026-09-28T17:00:00.105Z") },
      sevenDay: { percent: 45, resetsAt: Date.parse("2026-10-04T17:00:00.105Z") },
      scoped: [
        { label: "Fable", percent: 30, resetsAt: Date.parse("2026-10-04T17:00:00Z") },
      ],
    });
  });

  it("falls back to the named windows of the older schema", () => {
    expect(
      parseUsageBody({
        five_hour: { utilization: 7.6, resets_at: null },
        seven_day: { utilization: 130, resets_at: "not a date" },
        seven_day_opus: { utilization: 5, resets_at: null },
        seven_day_sonnet: null,
      }),
    ).toEqual({
      fiveHour: { percent: 8, resetsAt: null },
      sevenDay: { percent: 100, resetsAt: null },
      scoped: [{ label: "Opus", percent: 5, resetsAt: null }],
    });
  });

  it("is null for a body with no window — an in-band error", () => {
    expect(parseUsageBody({ error: { type: "rate_limit_error" } })).toBeNull();
    expect(parseUsageBody(null)).toBeNull();
    expect(parseUsageBody([usageBody(1, 1)])).toBeNull();
    expect(
      parseUsageBody({ limits: [{ kind: "session", percent: "12" }], five_hour: null }),
    ).toBeNull();
  });
});

describe("planLabel", () => {
  it("names the plan the way claude.ai does", () => {
    expect(planLabel("max", "default_claude_max_5x")).toBe("Max 5x");
    expect(planLabel("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(planLabel("max", null)).toBe("Max");
    expect(planLabel("pro", "default_claude_ai")).toBe("Pro");
    expect(planLabel("team", "default_claude_max_5x")).toBe("Team");
    expect(planLabel("enterprise", undefined)).toBe("Enterprise");
    expect(planLabel("custom", undefined)).toBe("Custom");
    expect(planLabel("", undefined)).toBeUndefined();
    expect(planLabel(undefined, undefined)).toBeUndefined();
  });
});

describe("credentials", () => {
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
    ).toEqual({ accessToken: "sk-ant-oat", expiresAt: 1790000000000, plan: "Pro" });
    expect(tokenFromCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(tokenFromCredentials("{broken")).toBeNull();
  });

  it("derives one Keychain entry per profile directory", () => {
    const name = keychainServiceName(profileDir(TAILWIND));
    expect(name).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(keychainServiceName(profileDir(TAILWIND))).toBe(name);
    expect(keychainServiceName(profileDir(NSUITE))).not.toBe(name);
  });

  it("reads the Keychain on macOS and falls back to the file", async () => {
    const file = JSON.stringify({ claudeAiOauth: { accessToken: "from-file" } });
    const keychain = vi.fn(async () => null);
    const read = createTokenReader({
      platform: "darwin",
      readKeychain: keychain,
      readText: async () => file,
    });
    expect(await read(profileDir(TAILWIND))).toEqual({ accessToken: "from-file" });
    expect(keychain).toHaveBeenCalledWith(keychainServiceName(profileDir(TAILWIND)));

    keychain.mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: "from-keychain" } }) as never,
    );
    expect(await read(profileDir(TAILWIND))).toEqual({ accessToken: "from-keychain" });
  });

  it("reads only the file elsewhere, and a missing file is no token", async () => {
    const keychain = vi.fn(async () => "never");
    const paths: string[] = [];
    const read = createTokenReader({
      platform: "win32",
      readKeychain: keychain,
      readText: async (path) => {
        paths.push(path);
        throw new Error("ENOENT");
      },
    });
    expect(await read("C:\\Users\\ana\\.head-terminal\\claude-profiles\\default")).toBeNull();
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
        cachedUsageUtilization: {
          fetchedAtMs: T0,
          accountUuid,
          utilization: usageBody(3, 66),
        },
      });
    expect(accountFromClaudeJson(snapshot("acc-1"))?.cached).toEqual({
      fetchedAt: T0,
      usage: parseUsageBody(usageBody(3, 66)),
    });
    expect(accountFromClaudeJson(snapshot("someone-else"))?.cached).toBeNull();
  });
});

describe("retryAfterMs", () => {
  it("reads seconds or a date, within one and thirty minutes", () => {
    expect(retryAfterMs("120", T0)).toBe(120_000);
    expect(retryAfterMs("5", T0)).toBe(60_000);
    expect(retryAfterMs("86400", T0)).toBe(30 * 60_000);
    expect(retryAfterMs(new Date(T0 + 300_000).toUTCString(), T0)).toBe(300_000);
    expect(retryAfterMs(null, T0)).toBeNull();
    expect(retryAfterMs("soon", T0)).toBeNull();
  });
});

describe("ClaudeUsageService", () => {
  it("reads the endpoint with the profile's own login", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");

    const [entry] = await h.service.get([TAILWIND]);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(init.headers.Authorization).toBe(`Bearer token-${TAILWIND}`);
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(entry).toMatchObject({
      profileIds: [TAILWIND],
      status: "ok",
      plan: "Max 5x",
      fiveHour: { percent: 12 },
      sevenDay: { percent: 40 },
      scoped: [{ label: "Fable", percent: 30 }],
      fetchedAt: T0,
    });
    expect(entry.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("shares one read between profiles signed in to the same account", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    signIn(h, NSUITE, "acc-1");
    signIn(h, "default", "acc-2");

    const entries = await h.service.get([TAILWIND, "default", NSUITE]);

    expect(entries.map((entry) => entry.profileIds)).toEqual([
      [TAILWIND, NSUITE],
      ["default"],
    ]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("serves the read from memory while fresh and asks again after five minutes", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");

    await h.service.get([TAILWIND]);
    h.clock.now += 4 * 60_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.now += 60_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("reads again on request, but never twice within 45 seconds", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");

    await h.service.get([TAILWIND]);
    h.clock.now += 30_000;
    await h.service.get([TAILWIND], [TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.now += 20_000;
    await h.service.get([TAILWIND], [TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("asks once for concurrent reads of the same account", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");

    await Promise.all([h.service.get([TAILWIND]), h.service.get([TAILWIND])]);

    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves an expired token alone and says so", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1", { expiresAt: T0 + 30_000 });

    const [entry] = await h.service.get([TAILWIND]);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ status: "unavailable", problem: "expired", plan: "Max 5x" });
  });

  it("keeps the last numbers, flagged, when a later read fails", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    await h.service.get([TAILWIND]);

    h.clock.now += 5 * 60_000;
    h.fetch.mockResolvedValueOnce(response(429, {}, { "retry-after": "600" }));
    const [entry] = await h.service.get([TAILWIND]);

    expect(entry).toMatchObject({
      status: "stale",
      problem: "rate-limited",
      fiveHour: { percent: 12 },
      fetchedAt: T0,
    });

    // Throttled: waited out, even when a refresh is asked for.
    h.clock.now += 5 * 60_000;
    await h.service.get([TAILWIND], [TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);

    h.clock.now += 5 * 60_000 + 1;
    const [recovered] = await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(recovered.status).toBe("ok");
    expect(recovered.problem).toBeUndefined();
  });

  it("backs off exponentially on network failures", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    h.fetch.mockRejectedValue(new Error("offline"));

    const [entry] = await h.service.get([TAILWIND]);
    expect(entry).toMatchObject({ status: "unavailable", problem: "network" });

    h.clock.now += 59_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.now += 1_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // Second failure: two minutes.
    h.clock.now += 60_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.clock.now += 60_000;
    await h.service.get([TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a refused token, but tries a renewed one on request", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    h.fetch.mockResolvedValueOnce(response(401, {}));

    const [refused] = await h.service.get([TAILWIND]);
    expect(refused).toMatchObject({ status: "unavailable", problem: "auth" });

    h.clock.now += 60_000;
    await h.service.get([TAILWIND], [TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.tokens.set(profileDir(TAILWIND), {
      accessToken: "renewed",
      expiresAt: h.clock.now + 8 * 3_600_000,
    });
    const [entry] = await h.service.get([TAILWIND], [TAILWIND]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(entry.status).toBe("ok");
  });

  it("takes a newer /usage read from .claude.json instead of asking", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1", {}, {
      cachedUsageUtilization: {
        fetchedAtMs: T0 - 60_000,
        accountUuid: "acc-1",
        utilization: usageBody(55, 70),
      },
    });

    const [entry] = await h.service.get([TAILWIND]);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(entry).toMatchObject({
      status: "ok",
      fiveHour: { percent: 55 },
      sevenDay: { percent: 70 },
      fetchedAt: T0 - 60_000,
    });
  });

  it("tells a signed-out profile apart and skips ids that are not profiles", async () => {
    const h = harness();
    h.files.set(`${profileDir("default")}/.claude.json`, {
      text: claudeJson(null),
      mtimeMs: T0,
    });

    const entries = await h.service.get(["default", "../../etc", NSUITE]);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(entries.map((entry) => [entry.profileIds, entry.status])).toEqual([
      [["default"], "signed-out"],
      [[NSUITE], "signed-out"],
    ]);
  });

  it("flags the numbers as old once the token expires without a renewal", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1", { expiresAt: T0 + 3 * 60_000 });
    await h.service.get([TAILWIND]);

    h.clock.now += 6 * 60_000;
    const [entry] = await h.service.get([TAILWIND]);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({
      status: "stale",
      problem: "expired",
      fiveHour: { percent: 12 },
      fetchedAt: T0,
    });
  });

  it("reads with another profile's login once one of them was refused", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1", { expiresAt: T0 + 8 * 3_600_000 });
    signIn(h, NSUITE, "acc-1", { expiresAt: T0 + 2 * 3_600_000 });
    h.fetch.mockResolvedValueOnce(response(401, {}));

    await h.service.get([TAILWIND, NSUITE]);
    h.clock.now += 60_000;
    const [entry] = await h.service.get([TAILWIND, NSUITE], [TAILWIND]);

    const bearers = h.fetch.mock.calls.map(
      (call) => (call as unknown as [string, { headers: Record<string, string> }])[1].headers
        .Authorization,
    );
    expect(bearers).toEqual([`Bearer token-${TAILWIND}`, `Bearer token-${NSUITE}`]);
    expect(entry.status).toBe("ok");
  });

  it("names the plan of numbers taken from .claude.json, without a request", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1", { plan: "Team" }, {
      cachedUsageUtilization: {
        fetchedAtMs: T0 - 60_000,
        accountUuid: "acc-1",
        utilization: usageBody(5, 5),
      },
    });

    const [entry] = await h.service.get([TAILWIND]);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(entry.plan).toBe("Team");
  });

  it("parses a rewritten .claude.json at most every 30 seconds", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    await h.service.get([TAILWIND]);

    // /login into another account, written twice in quick succession.
    h.files.set(`${profileDir(TAILWIND)}/.claude.json`, {
      text: claudeJson("acc-2"),
      mtimeMs: T0 + 1,
    });
    h.clock.now += 10_000;
    const [soon] = await h.service.get([TAILWIND]);
    h.clock.now += 20_000;
    const [later] = await h.service.get([TAILWIND]);

    expect(soon.key).not.toBe(later.key);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the account while .claude.json is being rewritten", async () => {
    const h = harness();
    signIn(h, TAILWIND, "acc-1");
    await h.service.get([TAILWIND]);

    h.files.set(`${profileDir(TAILWIND)}/.claude.json`, {
      text: '{"oauthAccount": {"accou',
      mtimeMs: T0 + 1,
    });
    h.clock.now += 30_000;
    const [entry] = await h.service.get([TAILWIND]);

    expect(entry.status).toBe("ok");
  });
});
