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

export const PROVIDERS = ["x", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = { x: "X API", anthropic: "AI summaries" };

/** USD per million tokens, from the Claude API pricing table (cached 2026-10-06; prompts ≤ 100K tokens). */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Price for the configured summary model; env overrides win. Null when unknown (the cap can't be enforced). */
export function modelPrice(model: string): { input: number; output: number } | null {
  const env = getEnv();
  const base = MODEL_PRICES[model];
  const input = env.AI_INPUT_USD_PER_MTOK ?? base?.input;
  const output = env.AI_OUTPUT_USD_PER_MTOK ?? base?.output;
  return input === undefined || output === undefined ? null : { input, output };
}

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
    case "anthropic": {
      const disabledReason = !env.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY is not set"
        : !modelPrice(env.SUMMARY_MODEL)
          ? `no price known for ${env.SUMMARY_MODEL}: set AI_INPUT_USD_PER_MTOK and AI_OUTPUT_USD_PER_MTOK`
          : null;
      return { provider, label: PROVIDER_LABELS.anthropic, enabled: !disabledReason, disabledReason, capUsd: env.AI_MONTHLY_CAP_USD };
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
/** Waiting for another paid call of the same provider timed out (or was aborted). */
export class SpendLockTimeoutError extends Error {
  constructor(provider: Provider, waitedMs: number) {
    super(`another ${PROVIDER_LABELS[provider]} call is in progress (waited ${Math.round(waitedMs / 1000)}s)`);
    this.name = "SpendLockTimeoutError";
  }
}

export const SPEND_LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 250;

/** pg_try_advisory_lock in a loop, so the wait honors a deadline and the caller's abort signal. */
async function acquireSpendLock(client: Queryable, provider: Provider, opts: { signal?: AbortSignal; waitMs: number }) {
  const started = Date.now();
  for (;;) {
    const r = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`spend:${provider}`]);
    if (r.rows[0]?.locked) return;
    const waited = Date.now() - started;
    if (opts.signal?.aborted || waited >= opts.waitMs) throw new SpendLockTimeoutError(provider, waited);
    await new Promise((res) => setTimeout(res, LOCK_POLL_MS));
  }
}

/**
 * Runs one paid call under the provider's budget. `fn` reports usage through
 * `track` as it goes (per HTTP request), so a failure after some requests
 * still records what was spent.
 *
 * Pass `client` to reuse a connection the caller already holds (runSource), so
 * a paid fetch doesn't take a second pooled connection. The session lock is
 * always released on that same connection.
 */
export async function withBudget<T>(
  provider: Provider,
  projectedUsd: number,
  fn: (track: (u: Partial<Usage>) => void) => Promise<T>,
  opts: { now?: Date; client?: PoolClient; signal?: AbortSignal; lockWaitMs?: number } = {},
): Promise<{ result: T; usage: Usage }> {
  const st = providerStatus(provider);
  if (!st.enabled) throw new BudgetError("disabled", st.disabledReason!);

  const client: PoolClient = opts.client ?? (await getPool().connect());
  const lockKey = `spend:${provider}`;
  let locked = false;
  const usage: Usage = { ...NO_USAGE };
  try {
    await acquireSpendLock(client, provider, { signal: opts.signal, waitMs: opts.lockWaitMs ?? SPEND_LOCK_WAIT_MS });
    locked = true;
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
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    if (!opts.client) client.release();
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
  opts: { client?: PoolClient } = {},
): Promise<FetchResult> {
  if (!adapter.paid) return adapter.fetch(source, ctx);
  const withCreds: AdapterContext = { ...ctx, ...(adapter.type === "x" ? { x: xContext() } : {}) };
  const { result } = await withBudget(
    adapter.paid.provider,
    adapter.paid.maxCostPerFetchUsd(source),
    (track) => adapter.fetch(source, { ...withCreds, trackUsage: track }),
    { now: ctx.now, client: opts.client, signal: ctx.signal },
  );
  return result;
}
