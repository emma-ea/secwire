/**
 * pg-boss job handlers. Registered only in worker/index.ts; kept here so they
 * can be exercised directly in integration tests.
 */
import { eq, lt, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { getDb } from "../db/client";
import { appSettings, ingestionRuns, loginAttempts, sources, workerHeartbeats } from "../db/schema";
import Anthropic from "@anthropic-ai/sdk";
import {
  QUEUE_DEFINITIONS,
  QUEUES,
  type ClusterJob,
  type EnrichCveJob,
  type EnrichRefreshJob,
  type IngestSourceJob,
  type SummarizeStoryJob,
} from "./boss";
import { InvalidCveIdError, type EnrichDeps } from "./enrich/service";
import { enqueueClusterIfPending } from "./hooks";
import { runSource, type RunSourceOptions } from "./run-source";
import { BudgetError } from "./spend";
import { enqueueSummaries, summarizeStory, type SummaryClient } from "./summarize";
import {
  completeJobRun,
  createJobRun,
  noteJobRunRetry,
  reconcileStaleJobRuns,
  reconcileStaleRunSources,
  recordRunSourceResult,
} from "./runs";
import { runCluster, runEnrichCve, runRefresh } from "./trigger-jobs";
import { findDueSources, getSettings, syncSchedules } from "./scheduler-service";
import { triggerIngestion } from "./trigger";

const RUN_RETENTION_DAYS = 90;

/** ingest.tick: enqueue due sources. Idle ticks cost one settings write + one query. */
export async function handleTick(now = new Date()): Promise<{ runId: string | null; due: string[] }> {
  const db = getDb();
  await db.update(appSettings).set({ lastTickAt: now }).where(eq(appSettings.id, true));
  await reconcileStaleRunSources(db);
  await reconcileStaleJobRuns(db);
  // Self-healing: items whose post-ingest cluster job was lost still get clustered.
  await enqueueClusterIfPending().catch((err: unknown) => console.error("[tick] cluster enqueue failed:", err));
  await enqueueSummaries().catch((err: unknown) => console.error("[tick] summary enqueue failed:", err));

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
export async function handleSourceJob(
  job: Pick<Job<IngestSourceJob>, "data" | "retryCount" | "signal">,
  deps: { fetcher?: RunSourceOptions["fetcher"] } = {},
): Promise<void> {
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
      fetcher: deps.fetcher,
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
  console.log(
    `[worker] scheduler.sync → tick ${r.tick ?? "unscheduled"}, enrich.refresh ${r.enrichRefresh ? "scheduled" : "unscheduled"}, prune ${r.prune ? "scheduled" : "unscheduled"}`,
  );
  return r;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

type JobLike<T> = Pick<Job<T>, "data" | "retryCount" | "signal">;

/**
 * Shared retry bookkeeping for job runs: throw so pg-boss retries; the run
 * row only turns "failed" on the final attempt.
 */
async function withJobRun<T>(
  queue: keyof typeof QUEUE_DEFINITIONS,
  job: JobLike<{ runId?: string }>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const runId = job.data.runId;
    if (runId) {
      const db = getDb();
      const final = job.retryCount >= (QUEUE_DEFINITIONS[queue].retryLimit ?? 0);
      if (final) await completeJobRun(db, runId, { status: "failed", error: errorMessage(err) }).catch(() => {});
      else await noteJobRunRetry(db, runId, errorMessage(err), job.retryCount + 1).catch(() => {});
    }
    throw err;
  }
}

/** enrich.cve: NVD (throttled) + EPSS for one CVE. Rate limits and network errors throw → retry with backoff. */
export async function handleEnrichCveJob(job: JobLike<EnrichCveJob>, deps: Omit<EnrichDeps, "signal"> = {}) {
  try {
    return await withJobRun(QUEUES.enrichCve, job, () =>
      runEnrichCve(getDb(), job.data.runId, job.data, { ...deps, signal: job.signal }),
    );
  } catch (err) {
    // A malformed id will never succeed: don't retry it.
    if (err instanceof InvalidCveIdError) return null;
    throw err;
  }
}

/** enrich.refresh: scheduled daily at 03:00 UTC (if enabled), or requested by admin/CLI with a runId. */
export async function handleEnrichRefreshJob(
  job: JobLike<EnrichRefreshJob>,
  opts: { boss?: PgBoss; deps?: EnrichDeps } = {},
) {
  const db = getDb();
  let runId = job.data.runId;
  if (!runId) {
    // Scheduled: respect the toggle in case it changed after the job was created.
    if (!(await getSettings(db)).enrichRefreshEnabled) return null;
    runId = await createJobRun(db, { trigger: "schedule", triggeredBy: "scheduler", kind: "enrich", scope: { mode: "refresh" } });
  }
  const id = runId;
  return withJobRun(QUEUES.enrichRefresh, { ...job, data: { runId: id } }, () =>
    runRefresh(db, id, { inline: false, boss: opts.boss, deps: { ...opts.deps, signal: job.signal } }),
  );
}

/** cluster.items: clusters unassigned items, or reclusters when `since` is set. */
export async function handleClusterJob(job: JobLike<ClusterJob>, deps: { boss?: PgBoss } = {}) {
  const r = await withJobRun(QUEUES.cluster, job, () => runCluster(getDb(), job.data.runId, job.data));
  // Stories that gained items may need a new summary (no-op when AI summaries are off).
  await enqueueSummaries({ boss: deps.boss }).catch((err: unknown) => console.error("[cluster] summary enqueue failed:", err));
  return r;
}

/**
 * summarize.story. Off/over-cap and requests the API rejects as invalid are
 * logged and dropped (retrying can't help); rate limits, overload and network
 * errors throw so pg-boss retries.
 */
export async function handleSummarizeJob(job: Pick<Job<SummarizeStoryJob>, "data">, deps: { client?: SummaryClient } = {}) {
  try {
    return await summarizeStory(job.data.storyId, { client: deps.client });
  } catch (err) {
    if (err instanceof BudgetError) return { status: "skipped" as const, reason: err.message };
    if (err instanceof Anthropic.APIError && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 409 && err.status !== 429) {
      console.error(`[summarize] ${job.data.storyId}: request rejected (${err.status}): ${err.message}`);
      return { status: "skipped" as const, reason: `API error ${err.status}` };
    }
    throw err;
  }
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
