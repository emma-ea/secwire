import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { appSettings, ingestionRunSources, ingestionRuns } from "@/db/schema";
import { QUEUES, stopSenderBoss } from "@/ingest/boss";
import { handlePrune, handleTick } from "@/ingest/handlers";
import { getRun, reconcileStaleRunSources } from "@/ingest/runs";
import {
  findDueSources,
  getSchedulerState,
  SettingsValidationError,
  syncSchedules,
  updateSchedulerSettings,
} from "@/ingest/scheduler-service";
import { triggerIngestion } from "@/ingest/trigger";
import { addSource, count, resetDb, startTestBoss } from "./helpers";

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

const schedules = async () =>
  (await getDb().execute<{ name: string; key: string; cron: string; timezone: string }>(
    sql`SELECT name, key, cron, timezone FROM pgboss.schedule ORDER BY name`,
  )).rows;

const minutesAgo = (m: number, from = new Date()) => new Date(from.getTime() - m * 60_000);

describe("scheduler.sync (SPEC §7.5)", () => {
  it("a fresh install schedules ingest.tick every 15 min (UTC), the daily enrich refresh and prune", async () => {
    await syncSchedules(boss);
    expect(await schedules()).toEqual([
      { name: QUEUES.enrichRefresh, key: "enrich-refresh", cron: "0 3 * * *", timezone: "UTC" },
      { name: QUEUES.tick, key: "ingest-tick", cron: "*/15 * * * *", timezone: "UTC" },
      { name: QUEUES.prune, key: "maintenance-prune", cron: "30 3 * * *", timezone: "UTC" },
    ]);
  });

  it("changing the interval rewrites the same schedule row in place", async () => {
    await syncSchedules(boss);
    const r = await updateSchedulerSettings({ intervalMinutes: 60 }, "admin", { boss });
    expect(r.syncQueued).toBe(true);
    await syncSchedules(boss); // what the scheduler.sync job does
    const tick = (await schedules()).filter((s) => s.name === QUEUES.tick);
    expect(tick).toEqual([{ name: QUEUES.tick, key: "ingest-tick", cron: "0 */1 * * *", timezone: "UTC" }]);
  });

  it("pausing removes the tick schedule; prune stays", async () => {
    await syncSchedules(boss);
    await updateSchedulerSettings({ enabled: false }, "admin", { boss });
    await syncSchedules(boss);
    expect((await schedules()).map((s) => s.name)).toEqual([QUEUES.enrichRefresh, QUEUES.prune]);
    // Restarting the worker re-syncs from the DB: still paused.
    await syncSchedules(boss);
    expect((await schedules()).map((s) => s.name)).toEqual([QUEUES.enrichRefresh, QUEUES.prune]);
  });

  it("rejects non-preset intervals with nothing saved", async () => {
    await expect(updateSchedulerSettings({ intervalMinutes: 7 }, "admin", { boss })).rejects.toBeInstanceOf(SettingsValidationError);
    const [s] = await getDb().select().from(appSettings);
    expect(s!.schedulerIntervalMinutes).toBe(15);
  });

  it("settings saved while scheduler.sync is already queued coalesce (exclusive queue)", async () => {
    const a = await updateSchedulerSettings({ intervalMinutes: 30 }, "admin", { boss });
    const b = await updateSchedulerSettings({ intervalMinutes: 60 }, "admin", { boss });
    expect(a.syncQueued).toBe(true);
    expect(b.syncQueued).toBe(false); // the queued sync will read the latest settings
    expect(b.state.intervalMinutes).toBe(60);
  });

  it("pausing with 'also cancel queued scheduled jobs' cancels only scheduled runs' jobs", async () => {
    await addSource({ id: "a" });
    await addSource({ id: "b" });
    const sched = await triggerIngestion({ trigger: "schedule", sourceIds: ["a"], boss });
    const manual = await triggerIngestion({ trigger: "admin", sourceIds: ["b"], boss });
    const r = await updateSchedulerSettings({ enabled: false, cancelQueuedScheduled: true }, "admin", { boss });
    expect(r.cancelledJobs).toBe(1);
    expect((await getRun(getDb(), sched.runId!))!.status).toBe("cancelled");
    expect((await getRun(getDb(), manual.runId!))!.status).toBe("queued");
  });

  it("the GET shape includes effective intervals and the request estimate", async () => {
    await addSource({ id: "rss1" });
    await addSource({ id: "kev", type: "cisa_kev", minIntervalMinutes: 60 });
    await addSource({ id: "hn", type: "hackernews", config: { queries: ["CVE", "RCE"] } });
    await addSource({ id: "off", enabled: false });
    const s = await getSchedulerState(getDb(), new Date("2026-11-08T12:07:00Z"));
    expect(s).toMatchObject({ enabled: true, intervalMinutes: 15, managedExternally: false, nextRunAt: "2026-11-08T12:15:00.000Z" });
    expect(Object.fromEntries(s.sources.map((x) => [x.id, x.effectiveIntervalMinutes]))).toEqual({ hn: 15, kev: 60, off: 15, rss1: 15 });
    // rss 96 + kev 24 + hn 2×96 = 312 (disabled source excluded)
    expect(s.estimatedRequestsPerDay).toBe(312);
  });
});

describe("ingest.tick (SPEC §7.2 A, §7.4)", () => {
  it("with no sources due: no ingestion_runs row, but last_tick_at is written", async () => {
    await addSource({ id: "s", lastFetchedAt: minutesAgo(3) });
    const r = await handleTick();
    expect(r).toEqual({ runId: null, due: [] });
    expect(await count("ingestion_runs")).toBe(0);
    const [s] = await getDb().select().from(appSettings);
    expect(s!.lastTickAt).not.toBeNull();
  });

  it("enqueues only due sources, honouring overrides and the 2-min grace", async () => {
    const now = new Date();
    await addSource({ id: "never" });
    await addSource({ id: "grace", lastFetchedAt: minutesAgo(14, now) }); // 15-min interval, within grace → due
    await addSource({ id: "fresh", lastFetchedAt: minutesAgo(5, now) });
    await addSource({ id: "kev", type: "cisa_kev", minIntervalMinutes: 60, lastFetchedAt: minutesAgo(20, now) });
    await addSource({ id: "off", enabled: false });
    expect(await findDueSources(getDb(), now)).toEqual(["grace", "never"]);

    const r = await handleTick(now);
    expect(r.due).toEqual(["grace", "never"]);
    const [run] = await getDb().select().from(ingestionRuns).where(eq(ingestionRuns.id, r.runId!));
    expect(run).toMatchObject({ trigger: "schedule", triggeredBy: "scheduler" });
  });

  it("raising the interval (15 → 60) causes no burst", async () => {
    const now = new Date();
    await addSource({ id: "a", lastFetchedAt: minutesAgo(16, now) });
    expect(await findDueSources(getDb(), now)).toEqual(["a"]);
    await getDb().update(appSettings).set({ schedulerIntervalMinutes: 60 });
    expect(await findDueSources(getDb(), now)).toEqual([]);
  });

  it("does nothing while paused", async () => {
    await addSource({ id: "s" });
    await getDb().update(appSettings).set({ schedulerEnabled: false });
    expect((await handleTick()).runId).toBeNull();
  });
});

describe("maintenance", () => {
  it("fails abandoned running rows so their runs can finish", async () => {
    await addSource({ id: "s" });
    const r = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    await getDb()
      .update(ingestionRunSources)
      .set({ status: "running", startedAt: minutesAgo(30) })
      .where(eq(ingestionRunSources.runId, r.runId!));
    expect(await reconcileStaleRunSources(getDb())).toBe(1);
    const run = await getRun(getDb(), r.runId!);
    expect(run!.status).toBe("failed");
    expect(run!.sources[0]!.error).toMatch(/abandoned/);
  });

  it("prunes runs older than 90 days", async () => {
    await getDb().insert(ingestionRuns).values([
      { trigger: "cli", kind: "ingest", status: "succeeded", createdAt: minutesAgo(91 * 1440) },
      { trigger: "cli", kind: "ingest", status: "succeeded", createdAt: minutesAgo(89 * 1440) },
    ]);
    expect((await handlePrune()).runs).toBe(1);
    expect(await count("ingestion_runs")).toBe(1);
  });
});
