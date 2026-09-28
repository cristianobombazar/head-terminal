import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type {
  ClaudeAccountUsage,
  ClaudeUsageProblem,
  ClaudeUsageScopedWindow,
  ClaudeUsageWindow,
} from "../types/api";
// The renderer's own join: the macOS Keychain entry is named after the exact
// CLAUDE_CONFIG_DIR string a pane was started with.
import { joinPath } from "../../src/core/path-join";

/** The endpoint behind Claude Code's own `/usage`. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

/** A read is served this long before the endpoint is asked again. */
const FRESH_MS = 5 * 60_000;
/** Floor between two reads of one account, even when one is asked for (a
 * turn just ended, a click on refresh): the endpoint throttles hard. */
const MIN_REFRESH_MS = 45_000;
/** Numbers older than this are flagged as old even with nothing failing. */
const STALE_AFTER_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const AUTH_RETRY_MS = 5 * 60_000;
const EXPIRED_RECHECK_MS = 60_000;
/**
 * A token this close to expiring is left alone. Renewing it is the CLI's
 * job: a refresh rotates the refresh token, and doing it here would race the
 * Claude running on that profile and log it out.
 */
const TOKEN_EXPIRY_SLACK_MS = 60_000;
const MAX_SCOPED_WINDOWS = 4;
const MAX_LABEL_LENGTH = 32;
/**
 * Claude rewrites `.claude.json` on nearly every turn, and it grows with the
 * profile's history: parsed at most this often on the main thread. An
 * account switch (`/login`) shows up this much later, at worst.
 */
const REPARSE_MIN_MS = 30_000;

/** `default`, or the uuid a profile created in Settings gets. */
export const CLAUDE_PROFILE_ID =
  /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface ParsedUsage {
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  scoped: ClaudeUsageScopedWindow[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function percentOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function resetOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function windowOf(value: unknown, percentKey: string): ClaudeUsageWindow | null {
  const record = asObject(value);
  const percent = percentOf(record?.[percentKey]);
  if (!record || percent === null) {
    return null;
  }
  return { percent, resetsAt: resetOf(record.resets_at) };
}

function scopeLabel(scope: unknown): string | null {
  const record = asObject(scope);
  const named = asObject(record?.model) ?? asObject(record?.surface);
  const label =
    typeof named?.display_name === "string" ? named.display_name.trim() : "";
  return label ? label.slice(0, MAX_LABEL_LENGTH) : null;
}

function addScoped(
  scoped: ClaudeUsageScopedWindow[],
  label: string | null,
  window: ClaudeUsageWindow | null,
): void {
  if (
    label &&
    window &&
    scoped.length < MAX_SCOPED_WINDOWS &&
    !scoped.some((entry) => entry.label === label)
  ) {
    scoped.push({ label, ...window });
  }
}

/**
 * The windows `/usage` shows, from the endpoint's answer. `limits` is the
 * list it renders today; the named windows (`five_hour`, `seven_day`…) are
 * the older schema, still sent next to it, and fill whatever the list left
 * out. Null when the body holds no window at all — an in-band error.
 */
export function parseUsageBody(body: unknown): ParsedUsage | null {
  const record = asObject(body);
  if (!record) {
    return null;
  }

  let fiveHour: ClaudeUsageWindow | null = null;
  let sevenDay: ClaudeUsageWindow | null = null;
  const scoped: ClaudeUsageScopedWindow[] = [];

  if (Array.isArray(record.limits)) {
    for (const entry of record.limits) {
      const limit = asObject(entry);
      const window = windowOf(limit, "percent");
      if (!limit || !window) {
        continue;
      }
      if (limit.kind === "session") {
        fiveHour ??= window;
      } else if (limit.kind === "weekly_all") {
        sevenDay ??= window;
      } else if (limit.kind === "weekly_scoped") {
        addScoped(scoped, scopeLabel(limit.scope), window);
      }
    }
  }

  fiveHour ??= windowOf(record.five_hour, "utilization");
  sevenDay ??= windowOf(record.seven_day, "utilization");
  addScoped(scoped, "Opus", windowOf(record.seven_day_opus, "utilization"));
  addScoped(scoped, "Sonnet", windowOf(record.seven_day_sonnet, "utilization"));

  if (!fiveHour && !sevenDay && scoped.length === 0) {
    return null;
  }
  return { fiveHour, sevenDay, scoped };
}

const PLAN_NAMES: Record<string, string> = {
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
};

/** "Max 5x" from `subscriptionType: "max"` + `rateLimitTier: "…_max_5x"`. */
export function planLabel(
  subscriptionType: unknown,
  rateLimitTier: unknown,
): string | undefined {
  if (typeof subscriptionType !== "string" || !subscriptionType.trim()) {
    return undefined;
  }
  const type = subscriptionType.trim().toLowerCase();
  if (type === "max") {
    const multiple =
      typeof rateLimitTier === "string" ? /(\d+)x\b/i.exec(rateLimitTier)?.[1] : undefined;
    return multiple ? `Max ${multiple}x` : "Max";
  }
  return (
    PLAN_NAMES[type] ??
    type.charAt(0).toUpperCase() + type.slice(1, MAX_LABEL_LENGTH)
  );
}

export interface OAuthToken {
  accessToken: string;
  /** Epoch ms; absent when the store does not say. */
  expiresAt?: number;
  plan?: string;
}

/** The subscription login in a `.credentials.json` / Keychain entry. */
export function tokenFromCredentials(raw: string): OAuthToken | null {
  try {
    const oauth = asObject(asObject(JSON.parse(raw))?.claudeAiOauth);
    const accessToken = oauth?.accessToken;
    if (!oauth || typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    const expiresAt =
      typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
        ? oauth.expiresAt
        : undefined;
    const plan = planLabel(oauth.subscriptionType, oauth.rateLimitTier);
    return {
      accessToken,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * macOS keeps the login in the Keychain, under a name Claude Code derives
 * from `CLAUDE_CONFIG_DIR` — which every Head Terminal profile sets.
 */
export function keychainServiceName(configDir: string): string {
  const suffix = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

function readKeychainSecret(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });
}

export type TokenReader = (configDir: string) => Promise<OAuthToken | null>;

/**
 * Where Claude Code keeps a profile's login: the Keychain on macOS (with the
 * plaintext file as its own fallback), `.credentials.json` everywhere else.
 * Read-only, and only when a read of the endpoint is due.
 */
export function createTokenReader({
  platform = process.platform,
  readText = (path: string) => readFile(path, "utf8"),
  readKeychain = readKeychainSecret,
}: {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  readKeychain?: (service: string) => Promise<string | null>;
} = {}): TokenReader {
  const fromFile = async (configDir: string) => {
    try {
      return tokenFromCredentials(await readText(joinPath(configDir, ".credentials.json")));
    } catch {
      return null;
    }
  };
  if (platform !== "darwin") {
    return fromFile;
  }
  return async (configDir) => {
    const secret = await readKeychain(keychainServiceName(configDir)).catch(() => null);
    return (secret ? tokenFromCredentials(secret) : null) ?? (await fromFile(configDir));
  };
}

export interface ProfileAccount {
  /** Account + organization: limits belong to the pair. Null: signed out. */
  accountKey: string | null;
  /** What Claude Code's own `/usage` last read, when it was this account. */
  cached: { usage: ParsedUsage; fetchedAt: number } | null;
}

/**
 * The account a profile is signed in to, from its `.claude.json`. Null when
 * the file does not parse — Claude may be halfway through writing it, which
 * must not read as a logout.
 */
export function accountFromClaudeJson(raw: string): ProfileAccount | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }

  const account = asObject(parsed.oauthAccount);
  const accountUuid =
    typeof account?.accountUuid === "string" && account.accountUuid
      ? account.accountUuid
      : null;
  if (!account || !accountUuid) {
    return { accountKey: null, cached: null };
  }
  const organization =
    typeof account.organizationUuid === "string" ? account.organizationUuid : "";

  let cached: ProfileAccount["cached"] = null;
  const snapshot = asObject(parsed.cachedUsageUtilization);
  if (
    snapshot &&
    snapshot.accountUuid === accountUuid &&
    typeof snapshot.fetchedAtMs === "number" &&
    Number.isFinite(snapshot.fetchedAtMs)
  ) {
    const usage = parseUsageBody(snapshot.utilization);
    if (usage) {
      cached = { usage, fetchedAt: snapshot.fetchedAtMs };
    }
  }
  return { accountKey: `${accountUuid}:${organization}`, cached };
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

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

interface AccountState {
  usage: ParsedUsage | null;
  fetchedAt: number;
  plan?: string;
  /** The login was read at least once, so a missing plan is the login's. */
  planChecked: boolean;
  problem: ClaudeUsageProblem | null;
  lastAttemptAt: number;
  retryAt: number;
  failures: number;
  /** The token the endpoint refused: asking again with it is pointless. */
  refusedToken?: string;
  inFlight: Promise<void> | null;
}

interface Profile {
  id: string;
  configDir: string;
  account: ProfileAccount;
}

interface AccountGroup {
  accountKey: string | null;
  profiles: Profile[];
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface ClaudeUsageServiceDeps {
  home: () => string;
  fetch: FetchLike;
  readToken?: TokenReader;
  readText?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  now?: () => number;
  userAgent?: string;
}

/**
 * Five-hour and weekly limits of the Claude accounts behind the app's
 * profiles — the numbers of Claude Code's `/usage`, read from the same
 * endpoint with the profile's own login.
 *
 * Limits belong to the account, so profiles signed in to one account share
 * a single read. Each account is asked at most every few minutes (sooner
 * when a turn just ended), backs off when throttled, and never has its token
 * renewed here: an expired token waits for the Claude on that profile to
 * renew it, and the last numbers stay on screen flagged as old.
 */
export class ClaudeUsageService {
  private readonly accounts = new Map<string, AccountState>();
  private readonly profileFiles = new Map<
    string,
    { mtimeMs: number; size: number; parsedAt: number; account: ProfileAccount }
  >();
  private readonly readToken: TokenReader;
  private readonly readText: (path: string) => Promise<string>;
  private readonly statFile: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly now: () => number;

  constructor(private readonly deps: ClaudeUsageServiceDeps) {
    this.readToken = deps.readToken ?? createTokenReader();
    this.readText = deps.readText ?? ((path) => readFile(path, "utf8"));
    this.statFile = deps.statFile ?? stat;
    this.now = deps.now ?? Date.now;
  }

  async get(
    profileIds: readonly string[],
    refresh: readonly string[] = [],
  ): Promise<ClaudeAccountUsage[]> {
    const ids = [...new Set(profileIds)].filter((id) => CLAUDE_PROFILE_ID.test(id));
    const profiles = await Promise.all(
      ids.map(async (id): Promise<Profile> => {
        const configDir = joinPath(this.deps.home(), ".head-terminal", "claude-profiles", id);
        return { id, configDir, account: await this.readProfile(configDir) };
      }),
    );

    const groups = new Map<string, AccountGroup>();
    for (const profile of profiles) {
      const groupKey = profile.account.accountKey ?? `signed-out:${profile.id}`;
      const group = groups.get(groupKey);
      if (group) {
        group.profiles.push(profile);
      } else {
        groups.set(groupKey, { accountKey: profile.account.accountKey, profiles: [profile] });
      }
    }

    const forced = new Set(refresh);
    await Promise.all(
      [...groups.values()].map((group) =>
        this.refreshAccount(group, group.profiles.some((profile) => forced.has(profile.id))),
      ),
    );
    return [...groups.values()].map((group) => this.describe(group));
  }

  private async readProfile(configDir: string): Promise<ProfileAccount> {
    const path = joinPath(configDir, ".claude.json");
    const known = this.profileFiles.get(path);
    try {
      const info = await this.statFile(path);
      if (
        known &&
        ((known.mtimeMs === info.mtimeMs && known.size === info.size) ||
          this.now() - known.parsedAt < REPARSE_MIN_MS)
      ) {
        return known.account;
      }
      const account = accountFromClaudeJson(await this.readText(path));
      if (!account) {
        return known?.account ?? { accountKey: null, cached: null };
      }
      this.profileFiles.set(path, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        parsedAt: this.now(),
        account,
      });
      return account;
    } catch {
      this.profileFiles.delete(path);
      return { accountKey: null, cached: null };
    }
  }

  private state(accountKey: string): AccountState {
    let state = this.accounts.get(accountKey);
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
      this.accounts.set(accountKey, state);
    }
    return state;
  }

  private async refreshAccount(group: AccountGroup, force: boolean): Promise<void> {
    if (!group.accountKey) {
      return;
    }
    const state = this.state(group.accountKey);
    const now = this.now();

    // A `/usage` typed in any of these profiles leaves its read behind:
    // taking it saves a request and is as fresh as ours.
    for (const { account } of group.profiles) {
      const cached = account.cached;
      if (cached && cached.fetchedAt > state.fetchedAt && cached.fetchedAt <= now + 60_000) {
        state.usage = cached.usage;
        state.fetchedAt = cached.fetchedAt;
      }
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
      // Numbers taken from `.claude.json` came without the plan, which only
      // the login says: looked up once, with no request.
      if (state.plan === undefined && !state.planChecked) {
        state.planChecked = true;
        const token = await this.bestToken(group.profiles, state.refusedToken);
        if (token?.plan) {
          state.plan = token.plan;
        }
      }
      return;
    }
    // Throttling is waited out even when asked; a token problem is not —
    // the turn that just ended is exactly when Claude renews its token.
    const tokenProblem =
      state.problem === "auth" || state.problem === "expired" || state.problem === "no-token";
    if (now < state.retryAt && !(force && tokenProblem)) {
      return;
    }

    state.inFlight = this.fetchInto(state, group.profiles).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  /**
   * The login to read the account with, among its profiles: one the endpoint
   * has not refused, then the one that lasts longest.
   */
  private async bestToken(profiles: Profile[], refused?: string): Promise<OAuthToken | null> {
    const tokens = await Promise.all(
      profiles.map((profile) => this.readToken(profile.configDir).catch(() => null)),
    );
    const rank = (token: OAuthToken) => [
      refused !== undefined && fingerprint(token.accessToken) === refused ? 0 : 1,
      token.expiresAt ?? Infinity,
    ];
    let best: OAuthToken | null = null;
    for (const token of tokens) {
      if (!token) continue;
      const [accepted, expiresAt] = rank(token);
      const [bestAccepted, bestExpiresAt] = best ? rank(best) : [-1, -1];
      if (accepted > bestAccepted || (accepted === bestAccepted && expiresAt > bestExpiresAt)) {
        best = token;
      }
    }
    return best;
  }

  private fail(state: AccountState, problem: ClaudeUsageProblem, delayMs: number): void {
    state.problem = problem;
    state.retryAt = this.now() + delayMs;
  }

  private backoff(state: AccountState, problem: ClaudeUsageProblem, hintMs?: number | null): void {
    state.failures += 1;
    const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failures - 1));
    this.fail(state, problem, hintMs ?? exponential);
  }

  private async fetchInto(state: AccountState, profiles: Profile[]): Promise<void> {
    // Every attempt counts, even one that never reaches the network: it is
    // what dates the numbers on screen as ones that could not be renewed.
    const now = this.now();
    state.lastAttemptAt = now;
    const token = await this.bestToken(profiles, state.refusedToken);
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
    const tokenId = fingerprint(token.accessToken);
    if (state.refusedToken === tokenId && now < state.retryAt) {
      return;
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.deps.fetch(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          "Content-Type": "application/json",
          ...(this.deps.userAgent ? { "User-Agent": this.deps.userAgent } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.backoff(state, "network");
      return;
    }

    if (response.status === 401 || response.status === 403) {
      state.refusedToken = tokenId;
      this.fail(state, "auth", AUTH_RETRY_MS);
      return;
    }
    if (response.status === 429) {
      this.backoff(state, "rate-limited", retryAfterMs(response.headers.get("retry-after"), now));
      return;
    }
    if (!response.ok) {
      this.backoff(state, "network");
      return;
    }

    const body = await response.json().catch(() => null);
    const usage = parseUsageBody(body);
    if (!usage) {
      const error = asObject(asObject(body)?.error);
      this.backoff(state, error?.type === "rate_limit_error" ? "rate-limited" : "network");
      return;
    }
    state.usage = usage;
    state.fetchedAt = this.now();
    state.problem = null;
    state.failures = 0;
    state.retryAt = 0;
    state.refusedToken = undefined;
  }

  private describe(group: AccountGroup): ClaudeAccountUsage {
    const profileIds = group.profiles.map((profile) => profile.id);
    const key = fingerprint(group.accountKey ?? `signed-out:${profileIds[0]}`);
    const empty = { fiveHour: null, sevenDay: null, scoped: [] };
    if (!group.accountKey) {
      return { key, profileIds, status: "signed-out", ...empty };
    }

    const state = this.accounts.get(group.accountKey);
    const plan = state?.plan ? { plan: state.plan } : {};
    if (!state?.usage) {
      return {
        key,
        profileIds,
        status: "unavailable",
        ...(state?.problem ? { problem: state.problem } : {}),
        ...plan,
        ...empty,
      };
    }

    // A failure only dates numbers read before it; a `/usage` read taken
    // from `.claude.json` after the failure is as good as a success.
    const failedSince = state.problem !== null && state.lastAttemptAt >= state.fetchedAt;
    const stale = failedSince || this.now() - state.fetchedAt > STALE_AFTER_MS;
    return {
      key,
      profileIds,
      status: stale ? "stale" : "ok",
      ...(stale && state.problem ? { problem: state.problem } : {}),
      ...plan,
      fiveHour: state.usage.fiveHour,
      sevenDay: state.usage.sevenDay,
      scoped: state.usage.scoped,
      fetchedAt: state.fetchedAt,
    };
  }
}
