import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { UsageTarget, UsageWindow } from "../types/api";
// The renderer's own join: the macOS Keychain entry is named after the exact
// CLAUDE_CONFIG_DIR string a pane was started with.
import { joinPath } from "../../src/core/path-join";
import {
  asObject,
  percentOf,
  planName,
  readOutcome,
  type ParsedUsage,
  type UsageAccount,
  type UsageAdapter,
  type UsageToken,
} from "./usage-service";

/** The endpoint behind Claude Code's own `/usage`. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

const FIVE_HOURS_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;
const MAX_SCOPED_WINDOWS = 4;
const MAX_LABEL_LENGTH = 32;
/**
 * Claude rewrites `.claude.json` on nearly every turn, and it grows with the
 * profile's history: parsed at most this often on the main thread. An
 * account switch (`/login`) shows up this much later, at worst.
 */
const REPARSE_MIN_MS = 30_000;

/** A profile the app created (`default` or a uuid), or `global`: the
 * `~/.claude` of a `claude` typed in a Shell session. */
export const CLAUDE_USAGE_PROFILE_ID =
  /^(?:default|global|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function resetOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function windowOf(
  value: unknown,
  percentKey: string,
  kind: UsageWindow["kind"],
  windowMs: number,
  label?: string,
): UsageWindow | null {
  const record = asObject(value);
  const percent = percentOf(record?.[percentKey]);
  if (!record || percent === null) {
    return null;
  }
  return {
    kind,
    ...(label ? { label } : {}),
    percent,
    resetsAt: resetOf(record.resets_at),
    windowMs,
  };
}

function scopeLabel(scope: unknown): string | null {
  const record = asObject(scope);
  const named = asObject(record?.model) ?? asObject(record?.surface);
  const label =
    typeof named?.display_name === "string" ? named.display_name.trim() : "";
  return label ? label.slice(0, MAX_LABEL_LENGTH) : null;
}

function addScoped(extra: UsageWindow[], window: UsageWindow | null): void {
  if (
    window &&
    extra.length < MAX_SCOPED_WINDOWS &&
    !extra.some((entry) => entry.label === window.label)
  ) {
    extra.push(window);
  }
}

/**
 * The windows `/usage` shows, from the endpoint's answer. `limits` is the
 * list it renders today; the named windows (`five_hour`, `seven_day`…) are
 * the older schema, still sent next to it, and fill whatever the list left
 * out. Null when the body holds no window at all — an in-band error.
 */
export function parseClaudeUsage(body: unknown): ParsedUsage | null {
  const record = asObject(body);
  if (!record) {
    return null;
  }

  let session: UsageWindow | null = null;
  let week: UsageWindow | null = null;
  const extra: UsageWindow[] = [];

  if (Array.isArray(record.limits)) {
    for (const entry of record.limits) {
      const limit = asObject(entry);
      if (!limit) {
        continue;
      }
      if (limit.kind === "session") {
        session ??= windowOf(limit, "percent", "session", FIVE_HOURS_MS);
      } else if (limit.kind === "weekly_all") {
        week ??= windowOf(limit, "percent", "week", WEEK_MS);
      } else if (limit.kind === "weekly_scoped") {
        const label = scopeLabel(limit.scope);
        if (label) {
          addScoped(extra, windowOf(limit, "percent", "week", WEEK_MS, label));
        }
      }
    }
  }

  session ??= windowOf(record.five_hour, "utilization", "session", FIVE_HOURS_MS);
  week ??= windowOf(record.seven_day, "utilization", "week", WEEK_MS);
  addScoped(extra, windowOf(record.seven_day_opus, "utilization", "week", WEEK_MS, "Opus"));
  addScoped(extra, windowOf(record.seven_day_sonnet, "utilization", "week", WEEK_MS, "Sonnet"));

  const windows = [session, week].filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0 && extra.length === 0) {
    return null;
  }
  return { windows, extra };
}

/** "Max 5x" from `subscriptionType: "max"` + `rateLimitTier: "…_max_5x"`. */
export function planLabel(
  subscriptionType: unknown,
  rateLimitTier: unknown,
): string | undefined {
  if (typeof subscriptionType === "string" && subscriptionType.trim().toLowerCase() === "max") {
    const multiple =
      typeof rateLimitTier === "string" ? /(\d+)x\b/i.exec(rateLimitTier)?.[1] : undefined;
    return multiple ? `Max ${multiple}x` : "Max";
  }
  return planName(subscriptionType);
}

/** The subscription login in a `.credentials.json` / Keychain entry. */
export function tokenFromCredentials(raw: string): UsageToken | null {
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
      value: accessToken,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * macOS keeps the login in the Keychain, under a name Claude Code derives
 * from `CLAUDE_CONFIG_DIR` — which every Head Terminal profile sets. Without
 * it (a `claude` typed in a shell) the name has no suffix.
 */
export function keychainServiceName(configDir?: string): string {
  if (configDir === undefined) {
    return "Claude Code-credentials";
  }
  const suffix = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

/** Where one Claude login lives on disk. */
export interface ClaudeLocation {
  /** `.claude.json`: the account signed in, and the last `/usage` read. */
  claudeJson: string;
  /** The folder with `.credentials.json`. */
  credentialsDir: string;
  keychainService: string;
}

/**
 * A profile keeps everything in its own `CLAUDE_CONFIG_DIR`. Without one,
 * Claude Code splits it: `~/.claude.json` at the home's root, the login in
 * `~/.claude/`.
 */
export function claudeLocation(home: string, profileId: string): ClaudeLocation {
  if (profileId === "global") {
    return {
      claudeJson: joinPath(home, ".claude.json"),
      credentialsDir: joinPath(home, ".claude"),
      keychainService: keychainServiceName(),
    };
  }
  const configDir = joinPath(home, ".head-terminal", "claude-profiles", profileId);
  return {
    claudeJson: joinPath(configDir, ".claude.json"),
    credentialsDir: configDir,
    keychainService: keychainServiceName(configDir),
  };
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

export type ClaudeTokenReader = (location: ClaudeLocation) => Promise<UsageToken | null>;

/**
 * Where Claude Code keeps a login: the Keychain on macOS (with the
 * plaintext file as its own fallback), `.credentials.json` everywhere else.
 */
export function createClaudeTokenReader({
  platform = process.platform,
  readText = (path: string) => readFile(path, "utf8"),
  readKeychain = readKeychainSecret,
}: {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  readKeychain?: (service: string) => Promise<string | null>;
} = {}): ClaudeTokenReader {
  const fromFile = async (location: ClaudeLocation) => {
    try {
      return tokenFromCredentials(
        await readText(joinPath(location.credentialsDir, ".credentials.json")),
      );
    } catch {
      return null;
    }
  };
  if (platform !== "darwin") {
    return fromFile;
  }
  return async (location) => {
    const secret = await readKeychain(location.keychainService).catch(() => null);
    return (secret ? tokenFromCredentials(secret) : null) ?? (await fromFile(location));
  };
}

export interface ClaudeAccountFile {
  /** Account + organization: limits belong to the pair. Null: signed out. */
  accountKey: string | null;
  /** What Claude Code's own `/usage` last read, when it was this account. */
  cached: { usage: ParsedUsage; fetchedAt: number } | null;
}

/**
 * The account a login belongs to, from its `.claude.json`. Null when the
 * file does not parse — Claude may be halfway through writing it, which
 * must not read as a logout.
 */
export function accountFromClaudeJson(raw: string): ClaudeAccountFile | null {
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

  let cached: ClaudeAccountFile["cached"] = null;
  const snapshot = asObject(parsed.cachedUsageUtilization);
  if (
    snapshot &&
    snapshot.accountUuid === accountUuid &&
    typeof snapshot.fetchedAtMs === "number" &&
    Number.isFinite(snapshot.fetchedAtMs)
  ) {
    const usage = parseClaudeUsage(snapshot.utilization);
    if (usage) {
      cached = { usage, fetchedAt: snapshot.fetchedAtMs };
    }
  }
  return { accountKey: `${accountUuid}:${organization}`, cached };
}

export interface ClaudeUsageAdapterDeps {
  home: () => string;
  readToken?: ClaudeTokenReader;
  readText?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  now?: () => number;
}

/** Claude Code: one login per app profile, plus the shell's `~/.claude`. */
export class ClaudeUsageAdapter implements UsageAdapter {
  private readonly files = new Map<
    string,
    { mtimeMs: number; size: number; parsedAt: number; account: ClaudeAccountFile }
  >();
  private readonly readToken: ClaudeTokenReader;
  private readonly readText: (path: string) => Promise<string>;
  private readonly statFile: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly now: () => number;

  constructor(private readonly deps: ClaudeUsageAdapterDeps) {
    this.readToken = deps.readToken ?? createClaudeTokenReader();
    this.readText = deps.readText ?? ((path) => readFile(path, "utf8"));
    this.statFile = deps.statFile ?? stat;
    this.now = deps.now ?? Date.now;
  }

  async account(target: UsageTarget): Promise<UsageAccount | "signed-out" | null> {
    if (target.provider !== "claude" || !CLAUDE_USAGE_PROFILE_ID.test(target.profileId)) {
      return null;
    }
    const location = claudeLocation(this.deps.home(), target.profileId);
    const file = await this.readAccount(location.claudeJson);
    if (!file.accountKey) {
      return "signed-out";
    }
    return {
      key: file.accountKey,
      login: location.credentialsDir,
      cached: file.cached,
      readToken: () => this.readToken(location),
    };
  }

  async fetchUsage(token: UsageToken, http: Parameters<UsageAdapter["fetchUsage"]>[1]) {
    const response = await http(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.value}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
      },
    });
    return readOutcome(response, parseClaudeUsage, this.now());
  }

  private async readAccount(path: string): Promise<ClaudeAccountFile> {
    const known = this.files.get(path);
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
      this.files.set(path, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        parsedAt: this.now(),
        account,
      });
      return account;
    } catch {
      this.files.delete(path);
      return { accountKey: null, cached: null };
    }
  }
}
