import { readFile } from "node:fs/promises";

import type { UsageTarget, UsageWindow } from "../types/api";
import { joinPath } from "../../src/core/path-join";
import {
  asObject,
  jwtExpiry,
  percentOf,
  planName,
  readOutcome,
  type Http,
  type ParsedUsage,
  type UsageAccount,
  type UsageAdapter,
  type UsageToken,
} from "./usage-service";

/** The endpoint behind the Codex CLI's own `/status`. */
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_EXTRA_WINDOWS = 4;
const MAX_LABEL_LENGTH = 32;

/** Where the Codex CLI keeps its login: `CODEX_HOME`, else `~/.codex`. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || joinPath(home, ".codex");
}

export interface CodexLogin {
  accessToken: string;
  accountId?: string;
}

/**
 * The ChatGPT login in `auth.json`. `api-key` when Codex runs on an API key
 * instead: billed per token, with no plan windows to show.
 */
export function codexLoginFrom(raw: string): CodexLogin | "api-key" | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(raw));
  } catch {
    return null;
  }
  const tokens = asObject(parsed?.tokens);
  const accessToken = tokens?.access_token;
  if (!tokens || typeof accessToken !== "string" || !accessToken) {
    return typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY
      ? "api-key"
      : null;
  }
  if (parsed?.auth_mode !== undefined && parsed.auth_mode !== "chatgpt") {
    return "api-key";
  }
  const accountId =
    typeof tokens.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
  return { accessToken, ...(accountId ? { accountId } : {}) };
}

function kindOf(seconds: number): UsageWindow["kind"] {
  if (seconds <= 6 * 3_600) return "session";
  if (seconds <= 8 * 86_400) return "week";
  return "cycle";
}

function windowOf(value: unknown, label?: string): UsageWindow | null {
  const record = asObject(value);
  const percent = percentOf(record?.used_percent);
  const seconds = record?.limit_window_seconds;
  if (!record || percent === null || typeof seconds !== "number" || !(seconds > 0)) {
    return null;
  }
  const resetAt = record.reset_at;
  return {
    kind: kindOf(seconds),
    ...(label ? { label } : {}),
    percent,
    resetsAt:
      typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0
        ? resetAt * 1000
        : null,
    windowMs: seconds * 1000,
  };
}

/**
 * `/status`'s windows: the plan's five hours and week (`primary_window`,
 * `secondary_window`), and the narrower limits some models carry.
 */
export function parseCodexUsage(body: unknown): ParsedUsage | null {
  const record = asObject(body);
  const limit = asObject(record?.rate_limit);
  if (!record) {
    return null;
  }
  const windows = [windowOf(limit?.primary_window), windowOf(limit?.secondary_window)].filter(
    (window): window is UsageWindow => window !== null,
  );

  const extra: UsageWindow[] = [];
  if (Array.isArray(record.additional_rate_limits)) {
    for (const entry of record.additional_rate_limits) {
      const additional = asObject(entry);
      const name =
        typeof additional?.limit_name === "string"
          ? additional.limit_name.trim().slice(0, MAX_LABEL_LENGTH)
          : "";
      const rateLimit = asObject(additional?.rate_limit);
      for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
        const window = name ? windowOf(raw, name) : null;
        if (window && extra.length < MAX_EXTRA_WINDOWS) {
          extra.push(window);
        }
      }
    }
  }

  if (windows.length === 0 && extra.length === 0) {
    return null;
  }
  const plan = planName(record.plan_type);
  return { windows, extra, ...(plan ? { plan } : {}) };
}

export interface CodexUsageAdapterDeps {
  home: () => string;
  env?: NodeJS.ProcessEnv;
  readText?: (path: string) => Promise<string>;
  now?: () => number;
}

/** Codex CLI signed in with ChatGPT: one login per machine. */
export class CodexUsageAdapter implements UsageAdapter {
  private readonly readText: (path: string) => Promise<string>;
  private readonly now: () => number;

  constructor(private readonly deps: CodexUsageAdapterDeps) {
    this.readText = deps.readText ?? ((path) => readFile(path, "utf8"));
    this.now = deps.now ?? Date.now;
  }

  private async login(): Promise<CodexLogin | "api-key" | null> {
    const path = joinPath(codexHome(this.deps.home(), this.deps.env), "auth.json");
    try {
      return codexLoginFrom(await this.readText(path));
    } catch {
      return null;
    }
  }

  async account(target: UsageTarget): Promise<UsageAccount | null> {
    if (target.provider !== "codex") {
      return null;
    }
    const login = await this.login();
    if (!login || login === "api-key") {
      return null;
    }
    return {
      key: login.accountId ?? "chatgpt",
      // Read again when due: the CLI renews the token in this same file.
      readToken: async (): Promise<UsageToken | null> => {
        const fresh = await this.login();
        if (!fresh || fresh === "api-key") {
          return null;
        }
        const expiresAt = jwtExpiry(fresh.accessToken);
        return {
          value: fresh.accessToken,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(fresh.accountId ? { headers: { "ChatGPT-Account-Id": fresh.accountId } } : {}),
        };
      },
    };
  }

  async fetchUsage(token: UsageToken, http: Http) {
    const response = await http(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.value}`,
        Accept: "application/json",
        ...token.headers,
      },
    });
    return readOutcome(response, parseCodexUsage, this.now());
  }
}
