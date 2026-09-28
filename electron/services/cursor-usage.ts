import { readFile } from "node:fs/promises";

import type { UsageTarget, UsageWindow } from "../types/api";
import { joinPath } from "../../src/core/path-join";
import {
  asObject,
  jwtExpiry,
  jwtPayload,
  percentOf,
  planName,
  readOutcome,
  type Http,
  type ParsedUsage,
  type UsageAccount,
  type UsageAdapter,
  type UsageToken,
} from "./usage-service";

/** What the Cursor dashboard and `cursor-agent` show for the current cycle. */
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const PROFILE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";

/** A plan changes rarely, but can while the app stays open. */
const PLAN_TTL_MS = 6 * 3_600_000;

const PLAN_NAMES: Record<string, string> = {
  free: "Hobby",
  free_trial: "Trial",
  pro_plus: "Pro+",
};

/**
 * Where `cursor-agent` keeps its login. Verified on Windows
 * (`%APPDATA%\Cursor\auth.json`); the others are its config folder's usual
 * places, tried in order.
 */
export function cursorAuthPaths(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || joinPath(home, "AppData", "Roaming");
    return [joinPath(appData, "Cursor", "auth.json")];
  }
  if (platform === "darwin") {
    return [
      joinPath(home, "Library", "Application Support", "Cursor", "auth.json"),
      joinPath(home, ".cursor", "auth.json"),
    ];
  }
  const config = env.XDG_CONFIG_HOME?.trim() || joinPath(home, ".config");
  return [
    joinPath(config, "cursor", "auth.json"),
    joinPath(config, "Cursor", "auth.json"),
    joinPath(home, ".cursor", "auth.json"),
  ];
}

export interface CursorLogin {
  accessToken: string;
  /** The JWT's subject: who is signed in. */
  subject: string;
  expiresAt?: number;
}

export function cursorLoginFrom(raw: string): CursorLogin | null {
  try {
    const accessToken = asObject(JSON.parse(raw))?.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    const payload = jwtPayload(accessToken);
    const subject = typeof payload?.sub === "string" && payload.sub ? payload.sub : "cursor";
    const expiresAt = jwtExpiry(accessToken);
    return { accessToken, subject, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  } catch {
    return null;
  }
}

function epochOf(value: unknown): number | null {
  const at = typeof value === "string" ? Number(value) : value;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * The billing cycle's share used: `Total` is what the dashboard shows with
 * Auto picking the model, `API` with a model named; `Auto` alone is detail.
 * Null for an answer with none of them (a plan billed another way).
 */
export function parseCursorUsage(body: unknown): ParsedUsage | null {
  const record = asObject(body);
  const plan = asObject(record?.planUsage);
  if (!record || !plan) {
    return null;
  }
  const start = epochOf(record.billingCycleStart);
  const end = epochOf(record.billingCycleEnd);
  const windowMs = start !== null && end !== null && end > start ? end - start : null;
  const pool = (label: string, value: unknown): UsageWindow | null => {
    const percent = percentOf(value);
    return percent === null ? null : { kind: "cycle", label, percent, resetsAt: end, windowMs };
  };

  const windows = [pool("Total", plan.totalPercentUsed), pool("API", plan.apiPercentUsed)].filter(
    (window): window is UsageWindow => window !== null,
  );
  const auto = pool("Auto", plan.autoPercentUsed);
  if (windows.length === 0 && !auto) {
    return null;
  }
  return { windows, extra: auto ? [auto] : [] };
}

export interface CursorUsageAdapterDeps {
  home: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readText?: (path: string) => Promise<string>;
  now?: () => number;
}

/** `cursor-agent`: one login per machine, billed by the month. */
export class CursorUsageAdapter implements UsageAdapter {
  private readonly readText: (path: string) => Promise<string>;
  private readonly now: () => number;
  private planReadAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: CursorUsageAdapterDeps) {
    this.readText = deps.readText ?? ((path) => readFile(path, "utf8"));
    this.now = deps.now ?? Date.now;
  }

  private async login(): Promise<CursorLogin | null> {
    for (const path of cursorAuthPaths(this.deps.home(), this.deps.platform, this.deps.env)) {
      const login = await this.readText(path).then(cursorLoginFrom, () => null);
      if (login) {
        return login;
      }
    }
    return null;
  }

  async account(target: UsageTarget): Promise<UsageAccount | null> {
    if (target.provider !== "cursor") {
      return null;
    }
    const login = await this.login();
    if (!login) {
      return null;
    }
    return {
      key: login.subject,
      readToken: async (): Promise<UsageToken | null> => {
        const fresh = await this.login();
        return fresh
          ? {
              value: fresh.accessToken,
              ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
            }
          : null;
      },
    };
  }

  async fetchUsage(token: UsageToken, http: Http, known: { plan?: string }) {
    const authorization = `Bearer ${token.value}`;
    const response = await http(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "connect-protocol-version": "1",
      },
      body: "{}",
    });
    const outcome = await readOutcome(response, parseCursorUsage, this.now());
    if (outcome.kind !== "ok" || (known.plan && this.now() - this.planReadAt < PLAN_TTL_MS)) {
      return outcome;
    }
    this.planReadAt = this.now();
    // The plan lives on the billing profile; without it the numbers still
    // stand, so a failure here only costs the badge.
    const plan = await http(PROFILE_URL, {
      method: "GET",
      headers: { Authorization: authorization },
    })
      .then((profile) => (profile.ok ? profile.json() : null))
      .then((profile) => planName(asObject(profile)?.membershipType, PLAN_NAMES))
      .catch(() => undefined);
    return plan ? { ...outcome, usage: { ...outcome.usage, plan } } : outcome;
  }
}
