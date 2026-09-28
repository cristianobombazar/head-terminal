import { describe, expect, it, vi } from "vitest";

import type { UsageTarget, UsageWindow } from "../types/api";
import {
  jwtExpiry,
  planName,
  readOutcome,
  retryAfterMs,
  UsageService,
  type FetchOutcome,
  type HttpResponse,
  type ParsedUsage,
  type UsageAccount,
  type UsageAdapter,
  type UsageToken,
} from "./usage-service";

const T0 = Date.parse("2026-09-28T15:00:00Z");
const CLAUDE: UsageTarget = { provider: "claude", profileId: "default" };
const CODEX: UsageTarget = { provider: "codex" };

function window(kind: UsageWindow["kind"], percent: number): UsageWindow {
  return { kind, percent, resetsAt: T0 + 3_600_000, windowMs: 5 * 3_600_000 };
}

function usage(session: number, week: number): ParsedUsage {
  return { windows: [window("session", session), window("week", week)], extra: [] };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

interface FakeAccount {
  key: string;
  token: UsageToken | null;
  cached?: UsageAccount["cached"];
}

function harness() {
  const clock = { now: T0 };
  const accounts: Record<string, FakeAccount | "signed-out" | null> = {
    claude: { key: "acc-1", token: { value: "t1", expiresAt: T0 + 8 * 3_600_000, plan: "Pro" } },
    codex: { key: "chatgpt-1", token: { value: "c1" } },
    cursor: null,
  };
  const fetchUsage = vi.fn(
    async (_token: UsageToken): Promise<FetchOutcome> => ({ kind: "ok", usage: usage(12, 40) }),
  );
  const readToken = vi.fn();
  const adapter: UsageAdapter = {
    async account(target) {
      const account = accounts[target.provider];
      if (account === null || account === "signed-out") return account;
      return {
        key: account.key,
        cached: account.cached ?? null,
        readToken: async () => {
          readToken(target.provider);
          return account.token;
        },
      };
    },
    fetchUsage: (token) => fetchUsage(token),
  };
  const fetch = vi.fn();
  const service = new UsageService({
    adapters: { claude: adapter, codex: adapter, cursor: adapter },
    fetch,
    now: () => clock.now,
  });
  return { service, clock, accounts, fetchUsage, readToken, fetch };
}

describe("helpers", () => {
  it("reads Retry-After in seconds or as a date, within one and thirty minutes", () => {
    expect(retryAfterMs("120", T0)).toBe(120_000);
    expect(retryAfterMs("5", T0)).toBe(60_000);
    expect(retryAfterMs("86400", T0)).toBe(30 * 60_000);
    expect(retryAfterMs(new Date(T0 + 300_000).toUTCString(), T0)).toBe(300_000);
    expect(retryAfterMs(null, T0)).toBeNull();
    expect(retryAfterMs("soon", T0)).toBeNull();
  });

  it("reads a JWT's expiry without verifying it", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_791_000_000 })).toString("base64url");
    expect(jwtExpiry(`h.${payload}.s`)).toBe(1_791_000_000_000);
    expect(jwtExpiry("not-a-jwt")).toBeUndefined();
  });

  it("names plans", () => {
    expect(planName("plus")).toBe("Plus");
    expect(planName("pro_plus", { pro_plus: "Pro+" })).toBe("Pro+");
    expect(planName("free_trial")).toBe("Free Trial");
    expect(planName("")).toBeUndefined();
    expect(planName(3)).toBeUndefined();
  });

  it("maps an answer to an outcome", async () => {
    const parse = (body: unknown) => (body ? usage(1, 2) : null);
    expect(await readOutcome(response(200, {}), parse, T0)).toEqual({
      kind: "ok",
      usage: usage(1, 2),
    });
    expect(await readOutcome(response(401, {}), parse, T0)).toEqual({ kind: "auth" });
    expect(await readOutcome(response(403, {}), parse, T0)).toEqual({ kind: "auth" });
    expect(
      await readOutcome(response(429, {}, { "retry-after": "600" }), parse, T0),
    ).toEqual({ kind: "rate-limited", retryAfterMs: 600_000 });
    expect(await readOutcome(response(500, {}), parse, T0)).toEqual({ kind: "failed" });
    expect(await readOutcome(response(200, null), parse, T0)).toEqual({ kind: "failed" });
    expect(
      await readOutcome(
        response(200, { error: { type: "rate_limit_error" } }),
        (body) => ((body as { windows?: unknown }).windows ? usage(1, 1) : null),
        T0,
      ),
    ).toEqual({ kind: "rate-limited", retryAfterMs: null });
  });
});

describe("UsageService", () => {
  it("reads the account and describes its windows and plan", async () => {
    const h = harness();

    const entry = await h.service.get(CLAUDE);

    expect(h.fetchUsage).toHaveBeenCalledWith(expect.objectContaining({ value: "t1" }));
    expect(entry).toEqual({
      provider: "claude",
      status: "ok",
      plan: "Pro",
      windows: usage(12, 40).windows,
      extra: [],
      fetchedAt: T0,
    });
  });

  it("takes the plan the answer names over the login's", async () => {
    const h = harness();
    h.fetchUsage.mockResolvedValueOnce({ kind: "ok", usage: { ...usage(1, 1), plan: "Plus" } });

    expect((await h.service.get(CODEX))?.plan).toBe("Plus");
  });

  it("is null for an agent without plan limits, and says signed-out when asked", async () => {
    const h = harness();
    expect(await h.service.get({ provider: "cursor" })).toBeNull();

    h.accounts.claude = "signed-out";
    expect(await h.service.get(CLAUDE)).toEqual({
      provider: "claude",
      status: "signed-out",
      windows: [],
      extra: [],
    });
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it("keeps each agent's accounts apart", async () => {
    const h = harness();
    h.accounts.codex = { key: "acc-1", token: { value: "c1" } };

    await h.service.get(CLAUDE);
    await h.service.get(CODEX);

    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("serves the read from memory while fresh and asks again after five minutes", async () => {
    const h = harness();

    await h.service.get(CLAUDE);
    h.clock.now += 4 * 60_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);

    h.clock.now += 60_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("reads again on request, but never twice within 45 seconds", async () => {
    const h = harness();

    await h.service.get(CLAUDE);
    h.clock.now += 30_000;
    await h.service.get(CLAUDE, true);
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);

    h.clock.now += 20_000;
    await h.service.get(CLAUDE, true);
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("asks once for concurrent reads of the same account", async () => {
    const h = harness();

    await Promise.all([h.service.get(CLAUDE), h.service.get(CLAUDE)]);

    expect(h.fetchUsage).toHaveBeenCalledTimes(1);
  });

  it("leaves an expired token alone and says so", async () => {
    const h = harness();
    h.accounts.claude = { key: "acc-1", token: { value: "t1", expiresAt: T0 + 30_000 } };

    expect(await h.service.get(CLAUDE)).toMatchObject({
      status: "unavailable",
      problem: "expired",
    });
    expect(h.fetchUsage).not.toHaveBeenCalled();
  });

  it("flags the numbers as old once the token expires without a renewal", async () => {
    const h = harness();
    h.accounts.claude = { key: "acc-1", token: { value: "t1", expiresAt: T0 + 3 * 60_000 } };
    await h.service.get(CLAUDE);

    h.clock.now += 6 * 60_000;
    const entry = await h.service.get(CLAUDE);

    expect(h.fetchUsage).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({ status: "stale", problem: "expired", fetchedAt: T0 });
  });

  it("says when there is no login to read with", async () => {
    const h = harness();
    h.accounts.claude = { key: "acc-1", token: null };

    expect(await h.service.get(CLAUDE)).toMatchObject({
      status: "unavailable",
      problem: "no-token",
    });
  });

  it("keeps the last numbers, flagged, when throttled, and waits it out", async () => {
    const h = harness();
    await h.service.get(CLAUDE);

    h.clock.now += 5 * 60_000;
    h.fetchUsage.mockResolvedValueOnce({ kind: "rate-limited", retryAfterMs: 600_000 });
    expect(await h.service.get(CLAUDE)).toMatchObject({
      status: "stale",
      problem: "rate-limited",
      fetchedAt: T0,
    });

    h.clock.now += 5 * 60_000;
    await h.service.get(CLAUDE, true);
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);

    h.clock.now += 5 * 60_000 + 1;
    const recovered = await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(3);
    expect(recovered).toMatchObject({ status: "ok" });
    expect(recovered?.problem).toBeUndefined();
  });

  it("backs off exponentially on failures, network errors included", async () => {
    const h = harness();
    h.fetchUsage.mockRejectedValueOnce(new Error("offline"));

    expect(await h.service.get(CLAUDE)).toMatchObject({
      status: "unavailable",
      problem: "network",
    });
    h.clock.now += 59_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);

    h.fetchUsage.mockResolvedValueOnce({ kind: "failed" });
    h.clock.now += 1_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);

    // Second failure: two minutes.
    h.clock.now += 60_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
    h.clock.now += 60_000;
    await h.service.get(CLAUDE);
    expect(h.fetchUsage).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a refused token, but tries a renewed one on request", async () => {
    const h = harness();
    h.fetchUsage.mockResolvedValueOnce({ kind: "auth" });

    expect(await h.service.get(CLAUDE)).toMatchObject({ status: "unavailable", problem: "auth" });

    h.clock.now += 60_000;
    await h.service.get(CLAUDE, true);
    expect(h.fetchUsage).toHaveBeenCalledTimes(1);

    h.accounts.claude = {
      key: "acc-1",
      token: { value: "renewed", expiresAt: h.clock.now + 3_600_000 },
    };
    expect(await h.service.get(CLAUDE, true)).toMatchObject({ status: "ok" });
    expect(h.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("takes a newer read the agent left on disk, plan included, without asking", async () => {
    const h = harness();
    h.accounts.claude = {
      key: "acc-1",
      token: { value: "t1", expiresAt: T0 + 3_600_000, plan: "Team" },
      cached: { usage: usage(55, 70), fetchedAt: T0 - 60_000 },
    };

    const entry = await h.service.get(CLAUDE);

    expect(h.fetchUsage).not.toHaveBeenCalled();
    expect(entry).toMatchObject({
      status: "ok",
      plan: "Team",
      windows: usage(55, 70).windows,
      fetchedAt: T0 - 60_000,
    });
  });

  it("keeps one login's token trouble from holding back another on the account", async () => {
    const clock = { now: T0 };
    const tokens: Record<string, UsageToken> = {
      a: { value: "expired", expiresAt: T0 + 10_000 },
      b: { value: "valid", expiresAt: T0 + 8 * 3_600_000 },
    };
    const fetchUsage = vi.fn(
      async (_token: UsageToken): Promise<FetchOutcome> => ({ kind: "ok", usage: usage(12, 40) }),
    );
    const adapter: UsageAdapter = {
      account: async (target) => {
        const login = target.provider === "claude" ? target.profileId : "x";
        return { key: "acc-1", login, readToken: async () => tokens[login] };
      },
      fetchUsage: (token) => fetchUsage(token),
    };
    const service = new UsageService({
      adapters: { claude: adapter, codex: adapter, cursor: adapter },
      fetch: vi.fn(),
      now: () => clock.now,
    });
    const onA = { provider: "claude", profileId: "a" } as const;
    const onB = { provider: "claude", profileId: "b" } as const;

    // The expired login fails first…
    expect(await service.get(onA)).toMatchObject({ status: "unavailable", problem: "expired" });
    // …and the other one still reads, at once.
    clock.now += 1_000;
    expect(await service.get(onB)).toMatchObject({ status: "ok", fetchedAt: T0 + 1_000 });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    // Back on the expired login: the account's numbers, fresh, no new request.
    clock.now += 60_000;
    expect(await service.get(onA)).toMatchObject({ status: "ok", fetchedAt: T0 + 1_000 });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it("hands the adapter a fetch with the timeout and user agent", async () => {
    const fetch = vi.fn(async () => response(200, {}));
    const adapter: UsageAdapter = {
      account: async () => ({ key: "k", readToken: async () => ({ value: "t" }) }),
      fetchUsage: async (_token, http) => {
        await http("https://example.test/usage", { method: "GET", headers: { A: "1" } });
        return { kind: "ok", usage: usage(1, 1) };
      },
    };
    const service = new UsageService({
      adapters: { claude: adapter, codex: adapter, cursor: adapter },
      fetch,
      userAgent: "HeadTerminal/1",
    });

    await service.get(CODEX);

    expect(fetch).toHaveBeenCalledWith("https://example.test/usage", {
      method: "GET",
      headers: { "User-Agent": "HeadTerminal/1", A: "1" },
      signal: expect.any(AbortSignal),
    });
  });
});
