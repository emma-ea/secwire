import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { ingestionRunSources, ingestionRuns, sources } from "@/db/schema";
import { QUEUES, stopSenderBoss } from "@/ingest/boss";
import { cancelRun } from "@/ingest/cancel";
import { handleSourceJob, RetryableSourceError } from "@/ingest/handlers";
import { getRun } from "@/ingest/runs";
import { BackfillNotSupportedError, triggerIngestion, UnknownSourcesError } from "@/ingest/trigger";
import { addSource, count, fakeFetcher, resetDb, rssWith, startTestBoss } from "./helpers";

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

const ok = () => fakeFetcher(() => ({ body: rssWith([{ guid: "a", title: "x" }]) }));

describe("triggerIngestion — coalescing (SPEC §7.1, §7.4)", () => {
  it("a second trigger while a job is queued coalesces into the existing job", async () => {
    await addSource({ id: "s" });
    const first = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    expect(first.sources[0]).toMatchObject({ status: "queued", jobId: expect.any(String) });

    // Double-click / repeated trigger: no new job.
    const second = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    expect(second.sources[0]).toMatchObject({ status: "coalesced", coalescedIntoJobId: first.sources[0]!.jobId });

    // force doesn't bypass coalescing.
    const forced = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], force: true, boss });
    expect(forced.sources[0]!.status).toBe("coalesced");

    const queued = await boss.findJobs(QUEUES.source, { key: "s", queued: true });
    expect(queued).toHaveLength(1);

    const [row] = await getDb()
      .select()
      .from(ingestionRunSources)
      .where(eq(ingestionRunSources.runId, second.runId!));
    expect(row).toMatchObject({ status: "coalesced", coalescedIntoJobId: first.sources[0]!.jobId });
    // A run whose only source coalesced is finished.
    expect((await getRun(getDb(), second.runId!))!.status).toBe("succeeded");
  });

  it("a manual run while a job is active queues one more behind it (stately)", async () => {
    await addSource({ id: "s" });
    const first = await triggerIngestion({ trigger: "schedule", sourceIds: ["s"], boss });
    const [active] = await boss.fetch(QUEUES.source);
    expect(active!.id).toBe(first.sources[0]!.jobId);

    const second = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    expect(second.sources[0]).toMatchObject({ status: "queued" });
    expect(second.sources[0]!.jobId).not.toBe(first.sources[0]!.jobId);

    const third = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    expect(third.sources[0]).toMatchObject({ status: "coalesced", coalescedIntoJobId: second.sources[0]!.jobId });
  });

  it("different sources never coalesce with each other", async () => {
    await addSource({ id: "a" });
    await addSource({ id: "b" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["a", "b"], boss });
    expect(r.sources.map((s) => s.status)).toEqual(["queued", "queued"]);
  });
});

describe("triggerIngestion — skip rules (SPEC §7.4)", () => {
  it("cooldown: a source that succeeded < 60s ago is skipped unless forced", async () => {
    await addSource({ id: "s", lastSuccessAt: new Date(Date.now() - 10_000) });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    expect(r.sources[0]!.status).toBe("skipped_cooldown");
    expect((await getRun(getDb(), r.runId!))!.status).toBe("succeeded");

    const forced = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], force: true, boss });
    expect(forced.sources[0]!.status).toBe("queued");
  });

  it("the scheduler is not subject to the manual cooldown", async () => {
    await addSource({ id: "s", lastSuccessAt: new Date(Date.now() - 10_000) });
    const r = await triggerIngestion({ trigger: "schedule", sourceIds: ["s"], boss });
    expect(r.sources[0]!.status).toBe("queued");
  });

  it("disabled sources are skipped unless includeDisabled", async () => {
    await addSource({ id: "off", enabled: false });
    expect((await triggerIngestion({ trigger: "admin", sourceIds: ["off"], boss })).sources[0]!.status).toBe("skipped_disabled");
    expect((await triggerIngestion({ trigger: "admin", sourceIds: ["off"], includeDisabled: true, boss })).sources[0]!.status).toBe("queued");
  });

  it('"all" means enabled sources only', async () => {
    await addSource({ id: "on" });
    await addSource({ id: "off", enabled: false });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: "all", boss });
    expect(r.sources.map((s) => s.sourceId)).toEqual(["on"]);
  });

  it("unknown source ids reject the whole request and enqueue nothing", async () => {
    await addSource({ id: "s" });
    await expect(triggerIngestion({ trigger: "admin", sourceIds: ["s", "nope", "nada"], boss })).rejects.toMatchObject({
      name: "UnknownSourcesError",
      unknownIds: ["nope", "nada"],
    });
    await expect(triggerIngestion({ trigger: "admin", sourceIds: ["nope"], boss })).rejects.toBeInstanceOf(UnknownSourcesError);
    expect(await count("ingestion_runs")).toBe(0);
    expect(await boss.findJobs(QUEUES.source, { queued: true })).toHaveLength(0);
  });

  it("RSS cannot be backfilled", async () => {
    await addSource({ id: "s" });
    await expect(
      triggerIngestion({ trigger: "cli", kind: "backfill", sourceIds: ["s"], inline: true, range: { since: new Date() } }),
    ).rejects.toBeInstanceOf(BackfillNotSupportedError);
  });

  it("dry run fetches and parses but writes nothing", async () => {
    // Loopback is refused by the SSRF guard before any connection: no network in tests.
    await addSource({ id: "s", url: "http://127.0.0.1:9/feed.xml" });
    const r = await triggerIngestion({ trigger: "cli", sourceIds: ["s"], dryRun: true, boss });
    expect(r.runId).toBeNull();
    expect(r.sources[0]).toMatchObject({ status: "dry_run", error: expect.stringContaining("non-public") });
    expect(await count("ingestion_runs")).toBe(0);
    expect(await count("items")).toBe(0);
  });
});

describe("runs — multi-source outcomes (SPEC §7.4)", () => {
  it("one failing source doesn't fail the others; the run is partial", async () => {
    await addSource({ id: "good" });
    await addSource({ id: "bad" });
    const fetcher = fakeFetcher((url) => (url.includes("bad") ? { status: 404 } : { body: rssWith([{ guid: "a", title: "x" }]) }));
    const r = await triggerIngestion({ trigger: "cli", sourceIds: ["good", "bad"], inline: true, fetcher });

    const run = await getRun(getDb(), r.runId!);
    expect(run!.status).toBe("partial");
    const bySource = Object.fromEntries(run!.sources.map((s) => [s.sourceId, s]));
    expect(bySource.good).toMatchObject({ status: "succeeded", itemsNew: 1 });
    expect(bySource.bad).toMatchObject({ status: "failed", httpStatus: 404, error: expect.stringContaining("404") });
    expect(run!.error).toContain("bad:");
    expect(run!.stats).toMatchObject({ itemsNew: 1, sources: 2 });
  });

  it("a run where every source fails is failed", async () => {
    await addSource({ id: "bad" });
    const r = await triggerIngestion({ trigger: "cli", sourceIds: ["bad"], inline: true, fetcher: fakeFetcher(() => ({ status: 500 })) });
    expect((await getRun(getDb(), r.runId!))!.status).toBe("failed");
  });
});

describe("cancel (SPEC §7.4)", () => {
  it("cancels queued jobs; the run becomes cancelled and the worker won't run them", async () => {
    await addSource({ id: "a" });
    await addSource({ id: "b" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["a", "b"], boss });
    const c = await cancelRun(r.runId!, { boss });
    expect(c).toMatchObject({ cancelled: ["a", "b"], stillRunning: [], status: "cancelled" });

    for (const s of r.sources) {
      const job = await boss.getJobById(QUEUES.source, s.jobId!);
      expect(job!.state).toBe("cancelled");
    }
    // Even if a job slipped through to a worker, the cancelled row stops it.
    const fetcher = ok();
    await handleSourceJob({ data: { runId: r.runId!, sourceId: "a", force: false }, retryCount: 0, signal: new AbortController().signal }, { fetcher });
    expect(fetcher.calls).toHaveLength(0);
    expect((await getRun(getDb(), r.runId!))!.status).toBe("cancelled");
  });

  it("running jobs finish normally", async () => {
    await addSource({ id: "a" });
    await addSource({ id: "b" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["a", "b"], boss });
    await getDb()
      .update(ingestionRunSources)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(ingestionRunSources.sourceId, "a"));

    const c = await cancelRun(r.runId!, { boss });
    expect(c).toMatchObject({ cancelled: ["b"], stillRunning: ["a"], status: null });

    const runningJob = await boss.getJobById(QUEUES.source, r.sources[0]!.jobId!);
    expect(runningJob!.state).not.toBe("cancelled");
  });
});

describe("handleSourceJob — retries (SPEC §7.4: retries 2× then failed)", () => {
  it("throws for pg-boss to retry, then records failed on the final attempt", async () => {
    await addSource({ id: "s" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    const job = (retryCount: number) => ({
      data: { runId: r.runId!, sourceId: "s", force: false },
      retryCount,
      signal: new AbortController().signal,
    });
    const fetcher = fakeFetcher(() => ({ status: 503 }));

    await expect(handleSourceJob(job(0), { fetcher })).rejects.toBeInstanceOf(RetryableSourceError);
    await expect(handleSourceJob(job(1), { fetcher })).rejects.toBeInstanceOf(RetryableSourceError);
    let [src] = await getDb().select().from(sources);
    expect(src!.consecutiveFailures).toBe(0);

    await expect(handleSourceJob(job(2), { fetcher })).resolves.toBeUndefined();
    [src] = await getDb().select().from(sources);
    expect(src!.consecutiveFailures).toBe(1);
    const run = await getRun(getDb(), r.runId!);
    expect(run!.status).toBe("failed");
    expect(run!.sources[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("non-retryable errors (404) fail immediately without retrying", async () => {
    await addSource({ id: "s" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    await expect(
      handleSourceJob(
        { data: { runId: r.runId!, sourceId: "s", force: false }, retryCount: 0, signal: new AbortController().signal },
        { fetcher: fakeFetcher(() => ({ status: 404 })) },
      ),
    ).resolves.toBeUndefined();
    expect((await getRun(getDb(), r.runId!))!.status).toBe("failed");
  });
});

describe("ingestion_runs row per trigger", () => {
  it("records trigger, triggeredBy and scope", async () => {
    await addSource({ id: "s" });
    const r = await triggerIngestion({ trigger: "cli", triggeredBy: "cli:tester", sourceIds: ["s"], force: true, boss });
    const [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, r.runId!));
    expect(run).toMatchObject({ trigger: "cli", triggeredBy: "cli:tester", kind: "ingest", scope: expect.objectContaining({ force: true, sourceIds: ["s"] }) });
  });
});
