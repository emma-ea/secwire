/**
 * Scheduler settings (SPEC §7.5). Postgres (app_settings) is the source of
 * truth; pg-boss schedules are derived from it by syncSchedules(), which only
 * the worker runs (via the scheduler.sync job and at startup).
 */
import { asc, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getDb, type Db } from "../db/client";
import { appSettings, sources } from "../db/schema";
import { getEnv } from "../env";
import {
  SCHEDULER_INTERVAL_PRESETS,
  WORKER_OFFLINE_AFTER_SEC,
  cronForInterval,
  effectiveIntervalMinutes,
  estimateDailyRequests,
  isPreset,
  isSourceDue,
  nextDueAt,
  nextRunAt,
  overrideIsBelowGlobal,
} from "../lib/scheduler";
import { getAdapter } from "./adapters";
import { getSenderBoss, QUEUES, SCHEDULE_KEYS } from "./boss";
import { cancelQueuedScheduledRuns } from "./cancel";

/** Daily NVD/EPSS refresh at 03:00 UTC (SPEC §7.5). */
export const ENRICH_REFRESH_CRON = "0 3 * * *";
/** Daily maintenance at 03:30 UTC, after the refresh has been enqueued. */
export const PRUNE_CRON = "30 3 * * *";

export type Settings = typeof appSettings.$inferSelect;

export async function getSettings(db: Db = getDb()): Promise<Settings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.id, true));
  if (row) return row;
  // The migration inserts it; recreate defensively if someone deleted it.
  await db.insert(appSettings).values({ id: true }).onConflictDoNothing();
  const [created] = await db.select().from(appSettings).where(eq(appSettings.id, true));
  return created!;
}

export type SchedulerState = {
  enabled: boolean;
  intervalMinutes: number;
  enrichRefreshEnabled: boolean;
  presets: readonly number[];
  lastTickAt: string | null;
  nextRunAt: string | null;
  managedExternally: boolean;
  updatedAt: string;
  updatedBy: string | null;
  sources: Array<{
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    minIntervalMinutes: number | null;
    effectiveIntervalMinutes: number;
    overrideIgnored: boolean;
    requestsPerFetch: number;
    costPerRequestUsd: number;
    nextDueAt: string | null;
  }>;
  estimatedRequestsPerDay: number;
  estimatedCostPerDayUsd: number;
};

export async function getSchedulerState(db: Db = getDb(), now = new Date()): Promise<SchedulerState> {
  const settings = await getSettings(db);
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  const managedExternally = !getEnv().WORKER_SCHEDULES_ENABLED;
  const g = settings.schedulerIntervalMinutes;
  const active = settings.schedulerEnabled && !managedExternally;

  const srcs = rows.map((s) => {
    const adapter = getAdapter(s.type);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      minIntervalMinutes: s.minIntervalMinutes,
      effectiveIntervalMinutes: effectiveIntervalMinutes(g, s.minIntervalMinutes),
      overrideIgnored: overrideIsBelowGlobal(g, s.minIntervalMinutes),
      requestsPerFetch: adapter.requestsPerFetch(s),
      costPerRequestUsd: adapter.costPerRequestUsd ?? 0,
      nextDueAt: active && s.enabled ? nextDueAt(s.lastFetchedAt, g, s.minIntervalMinutes, now).toISOString() : null,
    };
  });
  const est = estimateDailyRequests(srcs, g);

  return {
    enabled: settings.schedulerEnabled,
    intervalMinutes: g,
    enrichRefreshEnabled: settings.enrichRefreshEnabled,
    presets: SCHEDULER_INTERVAL_PRESETS,
    lastTickAt: settings.lastTickAt?.toISOString() ?? null,
    nextRunAt: active ? nextRunAt(g, now).toISOString() : null,
    managedExternally,
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
    sources: srcs,
    estimatedRequestsPerDay: est.requestsPerDay,
    estimatedCostPerDayUsd: est.costPerDayUsd,
  };
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export type SchedulerUpdate = {
  enabled?: boolean;
  intervalMinutes?: number;
  enrichRefreshEnabled?: boolean;
  /** When pausing: also cancel jobs that scheduled runs already queued. */
  cancelQueuedScheduled?: boolean;
};

export async function updateSchedulerSettings(
  input: SchedulerUpdate,
  updatedBy: string,
  opts: { boss?: PgBoss; db?: Db } = {},
): Promise<{ state: SchedulerState; syncQueued: boolean; workerOnline: boolean; cancelledJobs: number }> {
  const db = opts.db ?? getDb();
  if (input.intervalMinutes !== undefined && !isPreset(input.intervalMinutes)) {
    throw new SettingsValidationError(
      `intervalMinutes must be one of ${SCHEDULER_INTERVAL_PRESETS.join(", ")}`,
    );
  }

  await getSettings(db);
  await db
    .update(appSettings)
    .set({
      ...(input.enabled !== undefined ? { schedulerEnabled: input.enabled } : {}),
      ...(input.intervalMinutes !== undefined ? { schedulerIntervalMinutes: input.intervalMinutes } : {}),
      ...(input.enrichRefreshEnabled !== undefined ? { enrichRefreshEnabled: input.enrichRefreshEnabled } : {}),
      updatedBy,
      updatedAt: sql`now()`,
    })
    .where(eq(appSettings.id, true));

  const boss = opts.boss ?? (await getSenderBoss());
  // exclusive queue: null means a sync is already queued, which will read the
  // settings we just saved — equivalent outcome, not an error.
  const jobId = await boss.send(QUEUES.schedulerSync, {});
  const cancelledJobs =
    input.enabled === false && input.cancelQueuedScheduled ? await cancelQueuedScheduledRuns({ boss }) : 0;

  return {
    state: await getSchedulerState(db),
    syncQueued: jobId !== null,
    workerOnline: await isWorkerOnline(db),
    cancelledJobs,
  };
}

export async function isWorkerOnline(db: Db = getDb()): Promise<boolean> {
  const r = await db.execute<{ age: number | null }>(
    sql`SELECT extract(epoch FROM now() - max(last_beat_at))::float8 AS age FROM worker_heartbeats`,
  );
  const age = r.rows[0]?.age;
  return age !== null && age !== undefined && age <= WORKER_OFFLINE_AFTER_SEC;
}

/**
 * Applies app_settings to pg-boss schedules. Worker only. schedule() upserts
 * on (name, key) in pg-boss 12, so repeat calls overwrite in place.
 */
export async function syncSchedules(
  boss: PgBoss,
  db: Db = getDb(),
): Promise<{ tick: string | null; enrichRefresh: boolean; prune: boolean }> {
  if (!getEnv().WORKER_SCHEDULES_ENABLED) {
    await boss.unschedule(QUEUES.tick, SCHEDULE_KEYS.tick);
    await boss.unschedule(QUEUES.enrichRefresh, SCHEDULE_KEYS.enrichRefresh);
    await boss.unschedule(QUEUES.prune, SCHEDULE_KEYS.prune);
    return { tick: null, enrichRefresh: false, prune: false };
  }
  const s = await getSettings(db);
  let tick: string | null = null;
  if (s.schedulerEnabled) {
    tick = cronForInterval(s.schedulerIntervalMinutes);
    await boss.schedule(QUEUES.tick, tick, {}, { tz: "UTC", key: SCHEDULE_KEYS.tick });
  } else {
    await boss.unschedule(QUEUES.tick, SCHEDULE_KEYS.tick);
  }
  if (s.enrichRefreshEnabled) {
    await boss.schedule(QUEUES.enrichRefresh, ENRICH_REFRESH_CRON, {}, { tz: "UTC", key: SCHEDULE_KEYS.enrichRefresh });
  } else {
    await boss.unschedule(QUEUES.enrichRefresh, SCHEDULE_KEYS.enrichRefresh);
  }
  await boss.schedule(QUEUES.prune, PRUNE_CRON, {}, { tz: "UTC", key: SCHEDULE_KEYS.prune });
  return { tick, enrichRefresh: s.enrichRefreshEnabled, prune: true };
}

/** Enabled sources whose effective interval has elapsed (with the 2-min grace). */
export async function findDueSources(db: Db, now: Date): Promise<string[]> {
  const s = await getSettings(db);
  const rows = await db
    .select({ id: sources.id, lastFetchedAt: sources.lastFetchedAt, minIntervalMinutes: sources.minIntervalMinutes })
    .from(sources)
    .where(eq(sources.enabled, true))
    .orderBy(asc(sources.id));
  return rows
    .filter((r) => isSourceDue(r.lastFetchedAt, effectiveIntervalMinutes(s.schedulerIntervalMinutes, r.minIntervalMinutes), now))
    .map((r) => r.id);
}
