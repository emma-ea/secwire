import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, getPool } from "@/db/client";
import { ingestionRunSources, sources } from "@/db/schema";
import { resetEnvCache } from "@/env";
import { X_SEARCH_URL } from "@/ingest/adapters/x";
import { runSource } from "@/ingest/run-source";
import { findDueSources } from "@/ingest/scheduler-service";
import { BudgetError, monthSpend, withBudget } from "@/ingest/spend";
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

  it("a fetch that fails part-way still records what was spent", async () => {
    setX({ X_ENABLED: "true", X_BEARER_TOKEN: "t" });
    await getDb().update(sources).set({ config: { accounts: ["alice", "bob"], maxResults: 10 } });
    let n = 0;
    const f = fakeFetcher(() => (n++ === 0 ? { body: fixture("x-search.json") } : { status: 503, body: "{}" }));
    const o = await runSource("x", { force: false, fetcher: f, now: NOW });
    expect(o.status).toBe("failed");
    expect(await spend()).toEqual({ usd: 0.02, requests: 2, units: 4 });
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
