/**
 * pg-boss job handlers. Registered only in worker/index.ts; kept here so they
 * can be exercised directly in integration tests.
 */
import { eq, lt, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { getDb } from "../db/client";
import { appSettings, ingestionRuns, loginAttempts, sources, workerHeartbeats } from "../db/schema";
import { QUEUE_DEFINITIONS, QUEUES, type IngestSourceJob } from "./boss";
import { runSource } from "./run-source";
import { reconcileStaleRunSources, recordRunSourceResult } from "./runs";
import { findDueSources, getSettings, syncSchedules } from "./scheduler-service";
import { triggerIngestion } from "./trigger";

const RUN_RETENTION_DAYS = 90;

/** ingest.tick: enqueue due sources. Idle ticks cost one settings write + one query. */
export async function handleTick(now = new Date()): Promise<{ runId: string | null; due: string[] }> {
  const db = getDb();
  await db.update(appSettings).set({ lastTickAt: now }).where(eq(appSettings.id, true));
  await reconcileStaleRunSources(db);

  const settings = await getSettings(db);
  if (!settings.schedulerEnabled) return { runId: null, due: [] };

  const due = await findDueSources(db, now);
  // No due sources → no ingestion_runs row, no external requests (SPEC §7.4).
  if (!due.length) return { runId: null, due };

  const r = await triggerIngestion({ trigger: "schedule", triggeredBy: "scheduler", sourceIds: due, force: false });
  return { runId: r.runId, due };
}

export class RetryableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSourceError";
  }
}

/** ingest.source: one source, one run. Throwing makes pg-boss retry (2×, backoff). */
export async function handleSourceJob(job: Pick<Job<IngestSourceJob>, "data" | "retryCount" | "signal">): Promise<void> {
  const { runId, sourceId, force } = job.data;
  const retryLimit = QUEUE_DEFINITIONS[QUEUES.source].retryLimit ?? 0;
  const isFinalAttempt = job.retryCount >= retryLimit;
  try {
    const o = await runSource(sourceId, {
      runId,
      force,
      attempt: job.retryCount + 1,
      isFinalAttempt,
      signal: job.signal,
    });
    if (o.status === "failed" && o.retryable) throw new RetryableSourceError(o.error ?? "failed");
  } catch (err) {
    if (err instanceof RetryableSourceError) throw err;
    // Unexpected (e.g. DB) error. Record it on the final attempt so the run can finish.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    if (isFinalAttempt) {
      const db = getDb();
      await db
        .update(sources)
        .set({ lastError: message, consecutiveFailures: sql`${sources.consecutiveFailures} + 1` })
        .where(eq(sources.id, sourceId))
        .catch(() => {});
      await recordRunSourceResult(db, runId, sourceId, {
        status: "failed",
        httpStatus: null,
        itemsSeen: 0,
        itemsNew: 0,
        itemsUpdated: 0,
        durationMs: 0,
        error: message,
      }).catch(() => {});
    }
    throw err;
  }
}

export async function handleSchedulerSync(boss: PgBoss) {
  const r = await syncSchedules(boss);
  console.log(`[worker] scheduler.sync → tick ${r.tick ?? "unscheduled"}, prune ${r.prune ? "scheduled" : "unscheduled"}`);
  return r;
}

/** maintenance.prune: old runs (cascade to run sources), login attempts, dead heartbeats. */
export async function handlePrune(): Promise<{ runs: number; logins: number; heartbeats: number }> {
  const db = getDb();
  const runs = await db
    .delete(ingestionRuns)
    .where(lt(ingestionRuns.createdAt, sql`now() - make_interval(days => ${RUN_RETENTION_DAYS})`))
    .returning({ id: ingestionRuns.id });
  const logins = await db
    .delete(loginAttempts)
    .where(lt(loginAttempts.attemptedAt, sql`now() - interval '1 day'`))
    .returning({ id: loginAttempts.id });
  const heartbeats = await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.lastBeatAt, sql`now() - interval '1 day'`))
    .returning({ id: workerHeartbeats.workerId });
  return { runs: runs.length, logins: logins.length, heartbeats: heartbeats.length };
}
