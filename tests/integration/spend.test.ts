import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, getPool } from "@/db/client";
import { ingestionRunSources, sources } from "@/db/schema";
import { resetEnvCache } from "@/env";
import { parseXCursors, X_SEARCH_URL } from "@/ingest/adapters/x";
import { isRetryable, runSource } from "@/ingest/run-source";
import { findDueSources } from "@/ingest/scheduler-service";
import { BudgetError, monthSpend, SpendLockTimeoutError, withBudget } from "@/ingest/spend";
import { testSource } from "@/ingest/test-source";
import { triggerIngestion } from "@/ingest/trigger";
import { addSource, fakeFetcher, fixture, resetDb } from "./helpers";

const NOW = new Date("2026-11-08T12:00:00Z");
const ENV_KEYS = ["X_ENABLED", "X_BEARER_TOKEN", "X_MONTHLY_CAP_USD"] as const;

function setX(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  resetEnvCache();
}

const xFetcher = () => fakeFetcher(() => ({ body: fixture("x-search.json") }));
const spend = () => monthSpend(getPool(), "x", NOW);

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  await getDb().execute(sql`TRUNCATE api_spend, ingestion_run_sources, ingestion_runs, items, item_cves, cves CASCADE`);
  await getDb().delete(sources);
  await addSource({ id: "x", type: "x", category: "social", url: X_SEARCH_URL, config: { accounts: ["alice"], maxResults: 10 } });
});
afterEach(() => setX({}));
afterAll(() => closeDb());

describe("X behind a feature flag and a monthly cap", () => {
  it("does nothing while X_ENABLED is off: skipped, no request, not counted as a source failure", async () => {
    setX({ X_ENABLED: "false", X_BEARER_TOKEN: "t" });
    const f = xFetcher();
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["x"], inline: true, fetcher: f });
    expect(r.sources[0]).toMatchObject({ status: "skipped_disabled", error: "X integration is off (set X_ENABLED=true)" });
    expect(f.calls).toHaveLength(0);
    const [src] = await getDb().select().from(sources).where(eq(sources.id, "x"));
    expect([src!.consecutiveFailures, src!.lastFetchedAt]).toEqual([0, null]);
    // The tick doesn't even consider it due.
    expect(await findDueSources(getDb(), NOW)).toEqual([]);
  });

  it("needs the token too", async () => {
    setX({ X_ENABLED: "true" });
    const o = await runSource("x", { force: false, fetcher: xFetcher(), now: NOW });
    expect(o).toMatchObject({ status: "skipped_disabled", error: "X_BEARER_TOKEN is not set" });
  });

  it("records spend per post returned, then refuses once the worst case would cross the cap", async () => {
    // Worst case per fetch: 1 account × 10 posts × $0.005 = $0.05.
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t", X_MONTHLY_CAP_USD: "0.06" });
    expect(await findDueSources(getDb(), NOW)).toEqual(["x"]);
    const f = xFetcher();
    const first = await runSource("x", { force: false, fetcher: f, now: NOW });
    expect([first.status, first.itemsNew]).toEqual(["succeeded", 2]);
    expect(await spend()).toEqual({ usd: 0.02, requests: 1, units: 4 });

    // $0.02 spent + $0.05 worst case > $0.06 cap.
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["x"], force: true, inline: true, fetcher: f });
    expect(r.sources[0]).toMatchObject({ status: "skipped_budget" });
    expect(r.sources[0]!.error).toMatch(/cap reached: \$0\.02 spent of \$0\.06/);
    expect(f.calls).toHaveLength(1);
    const [row] = await getDb().select().from(ingestionRunSources).where(eq(ingestionRunSources.runId, r.runId!));
    expect(row!.status).toBe("skipped_budget");
    expect(await findDueSources(getDb(), new Date(NOW.getTime() + 2 * 3_600_000))).toEqual([]);
  });

  it("one account failing keeps the others' posts and cursors; the next run only re-asks the failed account", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t" });
    await getDb().update(sources).set({ config: { accounts: ["alice", "bob"], maxResults: 10 } });
    let n = 0;
    const f = fakeFetcher(() => (n++ === 0 ? { body: fixture("x-search.json") } : { status: 429, body: "{}" }));
    const o = await runSource("x", { force: false, fetcher: f, now: NOW });
    expect(o).toMatchObject({ status: "succeeded", itemsNew: 2 });
    expect(o.error).toMatch(/^partial: @bob: HTTP 429 from https:\/\/api\.x\.com\//);
    expect(await spend()).toEqual({ usd: 0.02, requests: 2, units: 4 });
    const [src] = await getDb().select().from(sources).where(eq(sources.id, "x"));
    expect(parseXCursors(src!.etag)).toEqual({ alice: { sinceId: "1855000000000000001", at: NOW.toISOString() } });

    // Next run: alice continues from her cursor (no re-read, no re-billing); bob gets the 24h window.
    const g = fakeFetcher(() => ({ body: JSON.stringify({ meta: { result_count: 0 } }) }));
    const later = new Date(NOW.getTime() + 3_600_000);
    await runSource("x", { force: false, fetcher: g, now: later });
    const params = g.calls.map((c) => Object.fromEntries(new URL(c.url).searchParams));
    expect(params[0]).toMatchObject({ since_id: "1855000000000000001" });
    expect(params[0]).not.toHaveProperty("start_time");
    expect(params[1]).toMatchObject({ start_time: "2026-11-07T13:00:00Z" });
    expect(params[1]).not.toHaveProperty("since_id");
    expect(await spend()).toEqual({ usd: 0.02, requests: 4, units: 4 });
  });

  it("if the first account fails, the whole fetch fails (retryable) but its request is still recorded", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t" });
    const o = await runSource("x", { force: false, fetcher: fakeFetcher(() => ({ status: 503, body: "{}" })), now: NOW, isFinalAttempt: false });
    expect([o.status, o.retryable]).toEqual(["failed", true]);
    expect(await spend()).toEqual({ usd: 0, requests: 1, units: 0 });
  });

  it("posts X returned are counted toward the cap even if they don't match our schema", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t" });
    const weird = JSON.stringify({ data: [{ id: "not-a-number", text: 1 }, { nope: true }], meta: { result_count: 2 } });
    const o = await runSource("x", { force: false, fetcher: fakeFetcher(() => ({ body: weird })), now: NOW });
    expect([o.status, o.itemsNew]).toEqual(["succeeded", 0]);
    expect(await spend()).toEqual({ usd: 0.01, requests: 1, units: 2 });
  });

  it("waiting for another paid call honors a deadline and the abort signal, and never leaks the connection", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t" });
    const holder = await getPool().connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('spend:x'))");
      await expect(withBudget("x", 0.01, async () => "x", { lockWaitMs: 300 })).rejects.toBeInstanceOf(SpendLockTimeoutError);
      const ac = new AbortController();
      ac.abort();
      await expect(withBudget("x", 0.01, async () => "x", { signal: ac.signal })).rejects.toBeInstanceOf(SpendLockTimeoutError);
      // Both connections went back to the pool (no leak): only `holder` is checked out.
      expect(getPool().totalCount - getPool().idleCount).toBe(1);
      expect(isRetryable(new SpendLockTimeoutError("x", 300))).toBe(true);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('spend:x'))");
      holder.release();
    }
  });

  it("the admin Test fetch is capped and billed like any other", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t", X_MONTHLY_CAP_USD: "0.05" });
    const ok = await testSource({ type: "x", url: X_SEARCH_URL, config: { accounts: ["alice"], maxResults: 10 } }, { fetcher: xFetcher() });
    expect(ok.ok).toBe(true);
    const refused = await testSource({ type: "x", url: X_SEARCH_URL, config: { accounts: ["alice"], maxResults: 10 } }, { fetcher: xFetcher() });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toMatch(/cap reached/);
    expect((await spend()).requests).toBe(1);
  });

  it("concurrent paid calls can't both pass the check (per-provider lock)", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t", X_MONTHLY_CAP_USD: "0.05" });
    const call = () =>
      withBudget("x", 0.05, async (track) => {
        await new Promise((r) => setTimeout(r, 50));
        track({ requests: 1, units: 10, usd: 0.05 });
        return "ok";
      });
    const results = await Promise.allSettled([call(), call()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BudgetError);
    expect((await monthSpend(getPool(), "x")).usd).toBeCloseTo(0.05);
  });
});
