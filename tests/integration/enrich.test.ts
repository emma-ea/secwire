import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { appSettings, cves, ingestionRuns, itemCves, items, stories } from "@/db/schema";
import { QUEUES, RECLUSTER_SINGLETON_KEY, SCHEDULE_KEYS, stopSenderBoss } from "@/ingest/boss";
import { clusterItems } from "@/ingest/cluster";
import { enrichCve, RetryableEnrichError, selectRefreshTargets } from "@/ingest/enrich/service";
import { realClock, Throttle } from "@/ingest/enrich/throttle";
import { handleClusterJob, handleEnrichCveJob, handleEnrichRefreshJob } from "@/ingest/handlers";
import { runSource } from "@/ingest/run-source";
import { syncSchedules } from "@/ingest/scheduler-service";
import { triggerEnrichCve, triggerEnrichRefresh, triggerRecluster } from "@/ingest/trigger-jobs";
import { hashCanonicalUrl } from "@/lib/url";
import { addSource, fakeFetcher, fixture, resetDb, startTestBoss } from "./helpers";

let boss: PgBoss;
beforeAll(async () => {
  boss = await startTestBoss();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await stopSenderBoss();
  await closeDb();
});
beforeEach(() => resetDb(boss));

const NOW = new Date("2026-11-08T12:00:00Z");
/** No spacing and a 1ms "backoff", so tests never sleep. */
const noWait = () => new Throttle(0, realClock, { initial: 1, max: 1 });

/** NVD by cveId (fixtures) and EPSS batches; unknown CVEs → NVD "not found". */
const NVD_FIXTURES: Record<string, string> = {
  "CVE-2024-3400": "nvd-cve-2024-3400.json",
  "CVE-2025-71458": "nvd-v4-and-v31.json",
  "CVE-2026-99271": "nvd-no-metrics.json",
};
function apis(overrides: { nvdStatus?: number } = {}) {
  return fakeFetcher((url) => {
    const u = new URL(url);
    if (u.hostname === "services.nvd.nist.gov") {
      if (overrides.nvdStatus) return { status: overrides.nvdStatus };
      const file = NVD_FIXTURES[u.searchParams.get("cveId")!];
      return { body: file ? fixture(file) : fixture("nvd-not-found.json") };
    }
    if (u.hostname === "api.first.org") return { body: fixture("epss-batch.json") };
    return { status: 404 };
  });
}

let n = 0;
async function itemWith(cveIds: string[], sourceId = "bc"): Promise<string> {
  n++;
  const url = `https://news.example.com/${n}`;
  const [row] = await getDb()
    .insert(items)
    .values({ sourceId, externalId: `e${n}`, url, canonicalUrlHash: hashCanonicalUrl(url), title: `Item ${n}`, publishedAt: NOW, fetchedAt: NOW })
    .returning({ id: items.id });
  for (const c of cveIds) {
    await getDb().insert(cves).values({ id: c }).onConflictDoNothing();
    await getDb().insert(itemCves).values({ itemId: row!.id, cveId: c });
  }
  return row!.id;
}

async function cve(id: string) {
  const [row] = await getDb().select().from(cves).where(eq(cves.id, id));
  return row!;
}

describe("enrichCve (SPEC §6.6)", () => {
  beforeEach(() => addSource({ id: "bc" }).then(() => undefined));

  it("writes NVD + EPSS and refreshes the story badges", async () => {
    await itemWith(["CVE-2024-3400"]);
    await clusterItems({ windowDays: 14 });
    const [before] = await getDb().select().from(stories);
    expect(before!.maxCvss).toBeNull();

    const f = apis();
    const r = await enrichCve("cve-2024-3400", {}, { fetcher: f, throttle: noWait() });
    expect(r).toMatchObject({ cveId: "CVE-2024-3400", nvd: "updated", cvssScore: 10, epssUpdated: 1, storiesRefreshed: 1 });

    const row = await cve("CVE-2024-3400");
    expect(row).toMatchObject({ cvssScore: 10, cvssVersion: "3.1", cvssSeverity: "CRITICAL", nvdVendor: "Palo Alto Networks", nvdStatus: "Analyzed", cweIds: ["CWE-20", "CWE-77"] });
    expect(row.epssPercentile).toBe(1);
    expect(row.nvdEnrichedAt).not.toBeNull();
    expect(row.epssEnrichedAt).not.toBeNull();

    const [after] = await getDb().select().from(stories);
    expect(after).toMatchObject({ maxCvss: 10, maxEpssPercentile: 1, vendors: ["Palo Alto Networks"] });
  });

  it("records nvd_enriched_at even when NVD has no score or no record yet", async () => {
    await itemWith(["CVE-2026-99271", "CVE-2026-55555"]);
    await enrichCve("CVE-2026-99271", { epss: false }, { fetcher: apis(), throttle: noWait() });
    await enrichCve("CVE-2026-55555", { epss: false }, { fetcher: apis(), throttle: noWait() });
    for (const id of ["CVE-2026-99271", "CVE-2026-55555"]) {
      const row = await cve(id);
      expect(row.cvssScore).toBeNull();
      expect(row.nvdEnrichedAt).not.toBeNull();
    }
    expect((await cve("CVE-2026-99271")).nvdStatus).toBe("Received");
  });

  it("rate limits (403/429/503) throw a retryable error and back the throttle off", async () => {
    await itemWith(["CVE-2024-3400"]);
    const throttle = noWait();
    for (const status of [403, 429, 503]) {
      await expect(enrichCve("CVE-2024-3400", {}, { fetcher: apis({ nvdStatus: status }), throttle })).rejects.toBeInstanceOf(
        RetryableEnrichError,
      );
    }
    expect(throttle.currentBackoffMs).toBeGreaterThan(0);
    expect((await cve("CVE-2024-3400")).nvdEnrichedAt).toBeNull();
  });

  it("fills the EPSS request with other item-linked CVEs still missing scores", async () => {
    await itemWith(["CVE-2024-3400"]);
    await itemWith(["CVE-2025-71458"]);
    // KEV-catalog-only CVE (no item): not included.
    await getDb().insert(cves).values({ id: "CVE-2021-44228", inKev: true });
    const f = apis();
    const r = await enrichCve("CVE-2024-3400", {}, { fetcher: f, throttle: noWait() });
    const epssCall = f.calls.find((c) => c.url.includes("api.first.org"))!;
    expect(new URL(epssCall.url).searchParams.get("cve")!.split(",").sort()).toEqual(["CVE-2024-3400", "CVE-2025-71458"]);
    expect(r.epssUpdated).toBe(2);
    expect((await cve("CVE-2025-71458")).epssScore).toBeCloseTo(0.00395);
    expect((await cve("CVE-2021-44228")).epssEnrichedAt).toBeNull();
  });

  it("an EPSS outage doesn't fail the NVD part", async () => {
    await itemWith(["CVE-2024-3400"]);
    const f = fakeFetcher((url) => (url.includes("nvd") ? { body: fixture("nvd-cve-2024-3400.json") } : { status: 500 }));
    const r = await enrichCve("CVE-2024-3400", {}, { fetcher: f, throttle: noWait() });
    expect(r.nvd).toBe("updated");
    expect(r.epssError).toMatch(/500/);
  });
});

describe("refresh target selection (SPEC §6.6)", () => {
  it("picks never-enriched, unscored-and-young, and stale CVEs seen in items in the last 30 days", async () => {
    await addSource({ id: "bc" });
    const day = 86_400_000;
    const ago = (d: number) => new Date(NOW.getTime() - d * day);
    await itemWith(["CVE-2026-0001", "CVE-2026-0002", "CVE-2026-0003", "CVE-2026-0004", "CVE-2026-0005", "CVE-2026-0006"]);
    await getDb().update(items).set({ fetchedAt: ago(1) });
    const set = (id: string, v: Partial<typeof cves.$inferInsert>) => getDb().update(cves).set(v).where(eq(cves.id, id));
    // 0001: never enriched → yes
    await set("CVE-2026-0002", { nvdEnrichedAt: ago(2), cvssScore: null, nvdPublishedAt: ago(5) }); // no CVSS, young → yes
    await set("CVE-2026-0003", { nvdEnrichedAt: ago(2), cvssScore: null, nvdPublishedAt: ago(60) }); // no CVSS but old → no
    await set("CVE-2026-0004", { nvdEnrichedAt: ago(8), cvssScore: 5 }); // stale → yes
    await set("CVE-2026-0005", { nvdEnrichedAt: ago(1), cvssScore: 5 }); // fresh → no
    await set("CVE-2026-0006", { nvdEnrichedAt: new Date(NOW.getTime() - 3_600_000), cvssScore: null, nvdPublishedAt: ago(1) }); // checked 1h ago → no
    // Not seen in items in 30 days → never selected.
    await getDb().insert(cves).values({ id: "CVE-2026-0007" });
    const old = await itemWith(["CVE-2026-0008"]);
    await getDb().update(items).set({ fetchedAt: ago(40) }).where(eq(items.id, old));

    const t = await selectRefreshTargets(getDb(), NOW);
    expect(t.nvd.sort()).toEqual(["CVE-2026-0001", "CVE-2026-0002", "CVE-2026-0004"]);
    expect(t.epss).toEqual(["CVE-2026-0001", "CVE-2026-0002", "CVE-2026-0003", "CVE-2026-0004", "CVE-2026-0005", "CVE-2026-0006"]);
  });
});

describe("ingestion hook (SPEC §6.2 step 5)", () => {
  it("after a KEV sync, enqueues enrich.cve only for item-linked CVEs, plus cluster.items", async () => {
    await addSource({ id: "cisa-kev", type: "cisa_kev", category: "advisory" });
    await runSource("cisa-kev", { force: false, fetcher: fakeFetcher(() => ({ body: fixture("kev.json") })), now: NOW, boss });
    const enrich = (await boss.findJobs(QUEUES.enrichCve, { queued: true })).map((j) => j.singletonKey).sort();
    // 8 catalog CVEs; 4 entries are recent enough to become items. Those items
    // also link CVEs their notes mention. Catalog-only CVEs are not enqueued.
    const linked = await getDb().selectDistinct({ id: itemCves.cveId }).from(itemCves);
    expect(enrich).toEqual(linked.map((r) => r.id).sort());
    expect(enrich).toEqual(expect.arrayContaining(["CVE-2024-27834", "CVE-2026-118527", "CVE-2026-119977", "CVE-2026-19868"]));
    for (const catalogOnly of ["CVE-2026-59310", "CVE-2025-14847", "CVE-2023-52163", "CVE-2025-14733"]) {
      expect(enrich).not.toContain(catalogOnly);
    }
    expect(await boss.findJobs(QUEUES.cluster, { queued: true })).toHaveLength(1);

    // Re-running coalesces: still one job per CVE, one cluster job.
    await runSource("cisa-kev", { force: true, fetcher: fakeFetcher(() => ({ body: fixture("kev.json") })), now: NOW, boss });
    expect(await boss.findJobs(QUEUES.enrichCve, { queued: true })).toHaveLength(enrich.length);
    expect(await boss.findJobs(QUEUES.cluster, { queued: true })).toHaveLength(1);
  });
});

describe("enrich / recluster triggers and jobs (SPEC §7.2, §7.3)", () => {
  it("re-enrich queues one job per CVE; a second request coalesces into the first run", async () => {
    const a = await triggerEnrichCve({ trigger: "admin", triggeredBy: "admin", cveId: "cve-2024-3400", boss });
    expect(a.status).toBe("queued");
    const b = await triggerEnrichCve({ trigger: "admin", triggeredBy: "admin", cveId: "CVE-2024-3400", boss });
    expect(b).toEqual({ runId: a.runId, status: "coalesced" });
    expect(await boss.findJobs(QUEUES.enrichCve, { key: "CVE-2024-3400", queued: true })).toHaveLength(1);
    expect((await getDb().select().from(ingestionRuns)).map((r) => r.kind)).toEqual(["enrich"]);
  });

  it("re-enrich rejects ids that aren't CVEs", async () => {
    await expect(triggerEnrichCve({ trigger: "admin", cveId: "CVE-12", boss })).rejects.toThrow(/Not a CVE/);
  });

  it("the enrich.cve handler completes the run, retries keep it running, the final attempt fails it", async () => {
    await addSource({ id: "bc" });
    await itemWith(["CVE-2024-3400"]);
    const { runId } = await triggerEnrichCve({ trigger: "admin", cveId: "CVE-2024-3400", boss });
    const job = (retryCount: number) => ({ data: { cveId: "CVE-2024-3400", runId, epss: true }, retryCount, signal: new AbortController().signal });

    await expect(handleEnrichCveJob(job(0), { fetcher: apis({ nvdStatus: 429 }), throttle: noWait() })).rejects.toThrow(/rate limit/);
    let [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    expect(run).toMatchObject({ status: "running" });
    expect(run!.error).toMatch(/attempt 1: NVD rate limit/);

    await handleEnrichCveJob(job(1), { fetcher: apis(), throttle: noWait() });
    [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(run!.stats).toMatchObject({ cveId: "CVE-2024-3400", cvssScore: 10 });

    const { runId: second } = await triggerEnrichCve({ trigger: "admin", cveId: "CVE-2025-71458", boss });
    await expect(
      handleEnrichCveJob({ data: { cveId: "CVE-2025-71458", runId: second }, retryCount: 5, signal: new AbortController().signal }, { fetcher: apis({ nvdStatus: 503 }), throttle: noWait() }),
    ).rejects.toThrow();
    const [failed] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, second));
    expect(failed!.status).toBe("failed");
  });

  it("stale refresh: EPSS batched in the job, NVD lookups enqueued one per CVE", async () => {
    await addSource({ id: "bc" });
    await itemWith(["CVE-2024-3400", "CVE-2025-71458"]);
    const { runId, status } = await triggerEnrichRefresh({ trigger: "cli", boss });
    expect(status).toBe("queued");
    expect((await triggerEnrichRefresh({ trigger: "cli", boss })).runId).toBe(runId);

    const stats = await handleEnrichRefreshJob(
      { data: { runId }, retryCount: 0, signal: new AbortController().signal },
      { boss, deps: { fetcher: apis() } },
    );
    expect(stats).toMatchObject({ nvdTargets: 2, nvdQueued: 2, epssTargets: 2, epssScored: 2 });
    const jobs = await boss.findJobs(QUEUES.enrichCve, { queued: true });
    expect(jobs.map((j) => j.data)).toEqual(expect.arrayContaining([{ cveId: "CVE-2024-3400", epss: false }]));
    const [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    expect(run!.status).toBe("succeeded");
  });

  it("scheduled refresh is skipped when enrich_refresh_enabled is off", async () => {
    await getDb().update(appSettings).set({ enrichRefreshEnabled: false });
    const r = await handleEnrichRefreshJob({ data: {}, retryCount: 0, signal: new AbortController().signal }, { boss });
    expect(r).toBeNull();
    expect(await getDb().select().from(ingestionRuns)).toHaveLength(0);
  });

  it("recluster queues behind clustering instead of being swallowed by a queued pipeline job (§7.4)", async () => {
    // A pipeline cluster job is already queued.
    expect(await boss.send(QUEUES.cluster, {})).not.toBeNull();
    const a = await triggerRecluster({ trigger: "admin", triggeredBy: "admin", since: new Date("2026-10-01T00:00:00Z"), boss });
    expect(a.status).toBe("queued");
    const queued = await boss.findJobs(QUEUES.cluster, { queued: true });
    expect(queued).toHaveLength(2);
    expect(queued.find((j) => j.singletonKey === RECLUSTER_SINGLETON_KEY)?.data).toEqual({
      runId: a.runId,
      since: "2026-10-01T00:00:00.000Z",
    });
    // A second recluster request while one is queued coalesces into it.
    const b = await triggerRecluster({ trigger: "admin", since: new Date("2026-10-05T00:00:00Z"), boss });
    expect(b).toEqual({ runId: a.runId, status: "coalesced" });
  });

  it("the cluster handler records recluster stats on the run", async () => {
    await addSource({ id: "bc" });
    await itemWith(["CVE-2026-1234"]);
    await itemWith(["CVE-2026-1234"]);
    await clusterItems({ windowDays: 14 });
    const { runId } = await triggerRecluster({ trigger: "cli", since: new Date("2026-11-01T00:00:00Z"), boss });
    await handleClusterJob({ data: { runId, since: "2026-11-01T00:00:00.000Z" }, retryCount: 0, signal: new AbortController().signal });
    const [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    expect(run).toMatchObject({ status: "succeeded", kind: "recluster" });
    expect(run!.stats).toMatchObject({ released: 2, deletedStories: 1, created: 1, joinedByCve: 1 });
  });

  it("syncSchedules applies enrich_refresh_enabled to the daily 03:00 UTC schedule", async () => {
    await syncSchedules(boss);
    const rows = async () =>
      (
        await getDb().execute<{ cron: string }>(
          sql`SELECT cron FROM pgboss.schedule WHERE name = ${QUEUES.enrichRefresh} AND key = ${SCHEDULE_KEYS.enrichRefresh}`,
        )
      ).rows;
    expect(await rows()).toEqual([{ cron: "0 3 * * *" }]);
    await getDb().update(appSettings).set({ enrichRefreshEnabled: false });
    await syncSchedules(boss);
    expect(await rows()).toEqual([]);
  });
});
