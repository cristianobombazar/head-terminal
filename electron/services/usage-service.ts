import { createHash } from "node:crypto";

import type {
  AgentUsage,
  UsageProblem,
  UsageProvider,
  UsageTarget,
  UsageWindow,
} from "../types/api";

/** A read is served this long before the endpoint is asked again. */
const FRESH_MS = 5 * 60_000;
/** Floor between two reads of one account, even when one is asked for (a
 * turn just ended, a click on refresh): these endpoints throttle hard. */
const MIN_REFRESH_MS = 45_000;
/** Numbers older than this are flagged as old even with nothing failing. */
const STALE_AFTER_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const AUTH_RETRY_MS = 5 * 60_000;
const EXPIRED_RECHECK_MS = 60_000;
/**
 * A token this close to expiring is left alone. Renewing it is the agent
 * CLI's job: a refresh rotates the refresh token, and doing it here would
 * race the CLI running on that login and sign it out.
 */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export interface ParsedUsage {
  windows: UsageWindow[];
  extra: UsageWindow[];
  /** When the answer itself names the plan. */
  plan?: string;
}

export interface UsageToken {
  value: string;
  /** Epoch ms; absent when the store does not say. */
  expiresAt?: number;
  /** When the login itself names the plan. */
  plan?: string;
  /** Account headers some endpoints want next to the token. */
  headers?: Record<string, string>;
}

export interface UsageAccount {
  /** Whose limits these are: logins on the same account share their numbers. */
  key: string;
  /** Which login reads them, when one account can have several (two Claude
   * profiles signed in to it): each keeps its own token trouble, so one
   * expired login never holds back the other. */
  login?: string;
  /** A read the agent's own CLI left on disk, taken when newer than ours. */
  cached?: { usage: ParsedUsage; fetchedAt: number } | null;
  /** The login to read with — only called when a read is due. */
  readToken(): Promise<UsageToken | null>;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type Http = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export type FetchOutcome =
  | { kind: "ok"; usage: ParsedUsage }
  | { kind: "auth" }
  | { kind: "rate-limited"; retryAfterMs: number | null }
  | { kind: "failed" };

export interface UsageAdapter {
  /**
   * The account behind the target, from files on disk — no network.
   * `signed-out`: the target has a place for a login but none is there.
   * Null: this agent has no plan limits here at all.
   */
  account(target: UsageTarget): Promise<UsageAccount | "signed-out" | null>;
  /** One read of the endpoint. Throwing counts as a network failure. */
  fetchUsage(token: UsageToken, http: Http, known: { plan?: string }): Promise<FetchOutcome>;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function percentOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Retry-After in seconds or as an HTTP date, clamped to sane bounds. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(delay)) {
    return null;
  }
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_BASE_MS, delay));
}

/** The claims of a JWT access token, read without verifying it. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    return asObject(
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

/** Expiry of a JWT access token (epoch ms). */
export function jwtExpiry(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/** "Plus" from "plus", with the names each vendor spells its own way. */
export function planName(value: unknown, names: Record<string, string> = {}): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const key = value.trim().toLowerCase();
  return (
    names[key] ??
    key
      .split(/[_\s-]+/u)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
      .slice(0, 32)
  );
}

/** The usual reading of an answer: status first, then the body. */
export async function readOutcome(
  response: HttpResponse,
  parse: (body: unknown) => ParsedUsage | null,
  now: number,
): Promise<FetchOutcome> {
  if (response.status === 401 || response.status === 403) {
    return { kind: "auth" };
  }
  if (response.status === 429) {
    return {
      kind: "rate-limited",
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now),
    };
  }
  if (!response.ok) {
    return { kind: "failed" };
  }
  const body = await response.json().catch(() => null);
  const usage = parse(body);
  if (usage) {
    return { kind: "ok", usage };
  }
  // A 200 carrying an error envelope is how some of these endpoints throttle.
  const error = asObject(asObject(body)?.error);
  return error?.type === "rate_limit_error"
    ? { kind: "rate-limited", retryAfterMs: null }
    : { kind: "failed" };
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

interface AccountState {
  usage: ParsedUsage | null;
  fetchedAt: number;
  plan?: string;
  /** The login was read at least once, so a missing plan is the login's. */
  planChecked: boolean;
  problem: UsageProblem | null;
  lastAttemptAt: number;
  retryAt: number;
  failures: number;
  /** The token the endpoint refused: asking again with it is pointless. */
  refusedToken?: string;
  inFlight: Promise<void> | null;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

export interface UsageServiceDeps {
  adapters: Record<UsageProvider, UsageAdapter>;
  fetch: FetchLike;
  now?: () => number;
  userAgent?: string;
}

/**
 * Plan limits of the agents the panes run — the numbers of each agent's
 * own usage screen, read from the same endpoint with the same login.
 *
 * What an adapter says about its agent (who is signed in, how to ask) is
 * all that differs; the pacing is shared. An account is asked at most every
 * few minutes (sooner on request), backs off when throttled, and never has
 * its token renewed here: an expired token waits for the agent to renew it,
 * and the last numbers stay on screen, flagged as old.
 */
export class UsageService {
  /** Pacing and token trouble, per login. */
  private readonly accounts = new Map<string, AccountState>();
  /** The freshest numbers per account, whichever of its logins read them. */
  private readonly latest = new Map<
    string,
    { usage: ParsedUsage; fetchedAt: number; plan?: string }
  >();
  private readonly now: () => number;

  constructor(private readonly deps: UsageServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async get(target: UsageTarget, refresh = false): Promise<AgentUsage | null> {
    const provider = target.provider;
    const account = await this.deps.adapters[provider].account(target);
    if (account === null) {
      return null;
    }
    if (account === "signed-out") {
      return { provider, status: "signed-out", windows: [], extra: [] };
    }
    const accountKey = `${provider}:${account.key}`;
    const state = this.state(`${accountKey}:${account.login ?? ""}`);
    await this.refreshAccount(provider, accountKey, state, account, refresh);
    return this.describe(provider, state);
  }

  private state(key: string): AccountState {
    let state = this.accounts.get(key);
    if (!state) {
      state = {
        usage: null,
        fetchedAt: 0,
        planChecked: false,
        problem: null,
        lastAttemptAt: 0,
        retryAt: 0,
        failures: 0,
        inFlight: null,
      };
      this.accounts.set(key, state);
    }
    return state;
  }

  private async refreshAccount(
    provider: UsageProvider,
    accountKey: string,
    state: AccountState,
    account: UsageAccount,
    force: boolean,
  ): Promise<void> {
    const now = this.now();

    // Another login on the account may have read it, or the agent's own
    // usage screen left a read on disk: either saves a request and is as
    // fresh as ours.
    const shared = this.latest.get(accountKey);
    if (shared && shared.fetchedAt > state.fetchedAt) {
      state.usage = shared.usage;
      state.fetchedAt = shared.fetchedAt;
      state.plan ??= shared.plan;
    }
    const cached = account.cached;
    if (cached && cached.fetchedAt > state.fetchedAt && cached.fetchedAt <= now + 60_000) {
      state.usage = cached.usage;
      state.fetchedAt = cached.fetchedAt;
    }

    if (state.inFlight) {
      return state.inFlight;
    }
    const age = now - state.fetchedAt;
    const due =
      !state.usage ||
      age >= FRESH_MS ||
      (force && age >= MIN_REFRESH_MS && now - state.lastAttemptAt >= MIN_REFRESH_MS);
    if (!due) {
      // Numbers taken from disk came without the plan, which only the login
      // may say: looked up once, with no request.
      if (state.plan === undefined && !state.planChecked) {
        state.planChecked = true;
        const token = await account.readToken().catch(() => null);
        if (token?.plan) {
          state.plan = token.plan;
        }
      }
      return;
    }
    // Throttling is waited out even when asked; a token problem is not —
    // the turn that just ended is exactly when the agent renews its token.
    const tokenProblem =
      state.problem === "auth" || state.problem === "expired" || state.problem === "no-token";
    if (now < state.retryAt && !(force && tokenProblem)) {
      return;
    }

    state.inFlight = this.fetchInto(provider, accountKey, state, account).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  private fail(state: AccountState, problem: UsageProblem, delayMs: number): void {
    state.problem = problem;
    state.retryAt = this.now() + delayMs;
  }

  private backoff(state: AccountState, problem: UsageProblem, hintMs?: number | null): void {
    state.failures += 1;
    const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failures - 1));
    this.fail(state, problem, hintMs ?? exponential);
  }

  private async fetchInto(
    provider: UsageProvider,
    accountKey: string,
    state: AccountState,
    account: UsageAccount,
  ): Promise<void> {
    // Every attempt counts, even one that never reaches the network: it is
    // what dates the numbers on screen as ones that could not be renewed.
    const now = this.now();
    state.lastAttemptAt = now;
    const token = await account.readToken().catch(() => null);
    state.planChecked = true;
    if (!token) {
      this.fail(state, "no-token", AUTH_RETRY_MS);
      return;
    }
    if (token.plan) {
      state.plan = token.plan;
    }
    if (token.expiresAt !== undefined && token.expiresAt - now <= TOKEN_EXPIRY_SLACK_MS) {
      this.fail(state, "expired", EXPIRED_RECHECK_MS);
      return;
    }
    const tokenId = fingerprint(token.value);
    if (state.refusedToken === tokenId && now < state.retryAt) {
      return;
    }

    const http: Http = (url, init) =>
      this.deps.fetch(url, {
        ...init,
        headers: {
          ...(this.deps.userAgent ? { "User-Agent": this.deps.userAgent } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    let outcome: FetchOutcome;
    try {
      outcome = await this.deps.adapters[provider].fetchUsage(token, http, {
        plan: state.plan,
      });
    } catch {
      this.backoff(state, "network");
      return;
    }

    switch (outcome.kind) {
      case "auth":
        state.refusedToken = tokenId;
        this.fail(state, "auth", AUTH_RETRY_MS);
        return;
      case "rate-limited":
        this.backoff(state, "rate-limited", outcome.retryAfterMs);
        return;
      case "failed":
        this.backoff(state, "network");
        return;
      case "ok":
        state.usage = outcome.usage;
        if (outcome.usage.plan) {
          state.plan = outcome.usage.plan;
        }
        state.fetchedAt = this.now();
        this.latest.set(accountKey, {
          usage: state.usage,
          fetchedAt: state.fetchedAt,
          ...(state.plan ? { plan: state.plan } : {}),
        });
        state.problem = null;
        state.failures = 0;
        state.retryAt = 0;
        state.refusedToken = undefined;
    }
  }

  private describe(provider: UsageProvider, state: AccountState): AgentUsage {
    const plan = state.plan ? { plan: state.plan } : {};
    if (!state.usage) {
      return {
        provider,
        status: "unavailable",
        ...(state.problem ? { problem: state.problem } : {}),
        ...plan,
        windows: [],
        extra: [],
      };
    }

    // A failure only dates numbers read before it; a read taken from disk
    // after the failure is as good as a success.
    const failedSince = state.problem !== null && state.lastAttemptAt > state.fetchedAt;
    const stale = failedSince || this.now() - state.fetchedAt > STALE_AFTER_MS;
    return {
      provider,
      status: stale ? "stale" : "ok",
      ...(stale && state.problem ? { problem: state.problem } : {}),
      ...plan,
      windows: state.usage.windows,
      extra: state.usage.extra,
      fetchedAt: state.fetchedAt,
    };
  }
}
