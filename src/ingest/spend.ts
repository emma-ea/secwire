/**
 * Paid API spend tracking and monthly caps (Phase 3). Every paid call
 * (X fetches, AI summaries) goes through withBudget():
 *
 *   1. the provider must be enabled (feature flag + credentials);
 *   2. under a per-provider advisory lock, month-to-date spend plus the call's
 *      worst-case cost must stay within the cap — otherwise the call is refused;
 *   3. the call reports actual usage, which is added to api_spend before the
 *      lock is released, even when the call fails part-way.
 *
 * Holding the lock across the call serializes paid calls per provider, so
 * two workers can't both pass the check and overshoot the cap together.
 */
import type { PoolClient } from "pg";
import { getPool, type Queryable } from "../db/client";
import { getEnv } from "../env";
import type { AdapterContext, FetchResult, Source, SourceAdapter } from "./adapters/types";

export const PROVIDERS = ["x"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = { x: "X API" };

export type Usage = { usd: number; requests: number; units: number };
export const NO_USAGE: Usage = { usd: 0, requests: 0, units: 0 };

export type ProviderStatus = {
  provider: Provider;
  label: string;
  enabled: boolean;
  /** Why the provider is off, for run rows and the dashboard. */
  disabledReason: string | null;
  capUsd: number;
};

export function providerStatus(provider: Provider): ProviderStatus {
  const env = getEnv();
  switch (provider) {
    case "x": {
      const disabledReason = !env.X_ENABLED
        ? "X integration is off (set X_ENABLED=true)"
        : !env.X_BEARER_TOKEN
          ? "X_BEARER_TOKEN is not set"
          : null;
      return { provider, label: PROVIDER_LABELS.x, enabled: !disabledReason, disabledReason, capUsd: env.X_MONTHLY_CAP_USD };
    }
  }
}

/** Billing month in UTC: "2026-11". */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export async function monthSpend(q: Queryable, provider: Provider, now = new Date()): Promise<Usage> {
  const r = await q.query<{ usd: string; requests: number; units: number }>(
    "SELECT usd, requests, units FROM api_spend WHERE provider = $1 AND month = $2",
    [provider, monthKey(now)],
  );
  const row = r.rows[0];
  return row ? { usd: Number(row.usd), requests: row.requests, units: row.units } : { ...NO_USAGE };
}

export async function recordSpend(q: Queryable, provider: Provider, usage: Usage, now = new Date()): Promise<void> {
  if (usage.usd <= 0 && usage.requests <= 0 && usage.units <= 0) return;
  await q.query(
    `INSERT INTO api_spend (provider, month, usd, requests, units) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, month) DO UPDATE SET
       usd = api_spend.usd + excluded.usd,
       requests = api_spend.requests + excluded.requests,
       units = api_spend.units + excluded.units,
       updated_at = now()`,
    [provider, monthKey(now), usage.usd, usage.requests, usage.units],
  );
}

/** Credentials + price for X fetches, or undefined when not configured. */
export function xContext(): { bearerToken: string; postReadUsd: number } | undefined {
  const env = getEnv();
  return env.X_BEARER_TOKEN ? { bearerToken: env.X_BEARER_TOKEN, postReadUsd: env.X_POST_READ_USD } : undefined;
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

/** Pure: the refusal message, or null when the call fits under the cap. */
export function capBlockReason(label: string, spentUsd: number, projectedUsd: number, capUsd: number): string | null {
  if (spentUsd + projectedUsd <= capUsd + 1e-9) return null;
  return `${label} monthly spend cap reached: ${fmt(spentUsd)} spent of ${fmt(capUsd)}, this call could cost up to ${fmt(projectedUsd)}`;
}

/** Thrown by withBudget when the provider is off or the cap would be exceeded. Not retryable. */
export class BudgetError extends Error {
  constructor(
    public readonly reason: "disabled" | "cap",
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

/** Read-only check for callers that want to skip early (tick due list, dashboard). */
export async function budgetBlock(provider: Provider, projectedUsd: number, q: Queryable = getPool(), now = new Date()): Promise<BudgetError | null> {
  const st = providerStatus(provider);
  if (!st.enabled) return new BudgetError("disabled", st.disabledReason!);
  const spent = await monthSpend(q, provider, now);
  const cap = capBlockReason(st.label, spent.usd, projectedUsd, st.capUsd);
  return cap ? new BudgetError("cap", cap) : null;
}

/**
 * Runs one paid call under the provider's budget. `fn` reports usage through
 * `track` as it goes (per HTTP request), so a failure after some requests
 * still records what was spent.
 */
export async function withBudget<T>(
  provider: Provider,
  projectedUsd: number,
  fn: (track: (u: Partial<Usage>) => void) => Promise<T>,
  opts: { now?: Date } = {},
): Promise<{ result: T; usage: Usage }> {
  const st = providerStatus(provider);
  if (!st.enabled) throw new BudgetError("disabled", st.disabledReason!);

  const client: PoolClient = await getPool().connect();
  const lockKey = `spend:${provider}`;
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
  const usage: Usage = { ...NO_USAGE };
  try {
    const now = opts.now ?? new Date();
    const spent = await monthSpend(client, provider, now);
    const cap = capBlockReason(st.label, spent.usd, projectedUsd, st.capUsd);
    if (cap) throw new BudgetError("cap", cap);
    try {
      const result = await fn((u) => {
        usage.usd += u.usd ?? 0;
        usage.requests += u.requests ?? 0;
        usage.units += u.units ?? 0;
      });
      return { result, usage };
    } finally {
      await recordSpend(client, provider, usage, now);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    client.release();
  }
}

export type SpendSummary = ProviderStatus & Usage & { month: string };

export async function spendSummary(q: Queryable = getPool(), now = new Date()): Promise<SpendSummary[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => ({ ...providerStatus(p), ...(await monthSpend(q, p, now)), month: monthKey(now) })),
  );
}

/**
 * Fetches a source, through the provider's budget when the adapter is paid.
 * Shared by runSource and the "Test source" dry run, so a test fetch of X is
 * capped and billed like any other.
 */
export async function fetchWithBudget(
  adapter: SourceAdapter,
  source: Source,
  ctx: AdapterContext,
): Promise<FetchResult> {
  if (!adapter.paid) return adapter.fetch(source, ctx);
  const withCreds: AdapterContext = { ...ctx, ...(adapter.type === "x" ? { x: xContext() } : {}) };
  const { result } = await withBudget(
    adapter.paid.provider,
    adapter.paid.maxCostPerFetchUsd(source),
    (track) => adapter.fetch(source, { ...withCreds, trackUsage: track }),
    { now: ctx.now },
  );
  return result;
}
