/**
 * Run cancellation (SPEC §7.4): queued jobs are cancelled, running jobs finish.
 *
 * Our own ingestion_run_sources row is the arbiter: we flip it queued →
 * cancelled first, and only cancel the pg-boss job if that update won. If the
 * worker marked it running a moment earlier, the update matches nothing and
 * the job is left alone. If the worker picks the job up after we flipped the
 * row, markRunSourceRunning refuses to start it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getDb } from "../db/client";
import { ingestionRunSources, ingestionRuns } from "../db/schema";
import { getSenderBoss, QUEUES } from "./boss";
import { finalizeRun } from "./runs";

export type CancelResult = { cancelled: string[]; stillRunning: string[]; status: string | null };

export async function cancelRun(runId: string, opts: { boss?: PgBoss } = {}): Promise<CancelResult | null> {
  const db = getDb();
  const [run] = await db.select({ id: ingestionRuns.id }).from(ingestionRuns).where(eq(ingestionRuns.id, runId));
  if (!run) return null;

  const flipped = await db
    .update(ingestionRunSources)
    .set({ status: "cancelled", finishedAt: sql`now()`, error: "cancelled by admin" })
    .where(and(eq(ingestionRunSources.runId, runId), eq(ingestionRunSources.status, "queued")))
    .returning({ sourceId: ingestionRunSources.sourceId, jobId: ingestionRunSources.jobId });

  const jobIds = flipped.map((f) => f.jobId).filter((j): j is string => !!j);
  if (jobIds.length) {
    const boss = opts.boss ?? (await getSenderBoss());
    await boss.cancel(QUEUES.source, jobIds);
  }

  const running = await db
    .select({ sourceId: ingestionRunSources.sourceId })
    .from(ingestionRunSources)
    .where(and(eq(ingestionRunSources.runId, runId), eq(ingestionRunSources.status, "running")));

  const status = await finalizeRun(db, runId);
  return { cancelled: flipped.map((f) => f.sourceId), stillRunning: running.map((r) => r.sourceId), status };
}

/** "Also cancel queued scheduled jobs" when pausing the scheduler. */
export async function cancelQueuedScheduledRuns(opts: { boss?: PgBoss } = {}): Promise<number> {
  const db = getDb();
  const runs = await db
    .selectDistinct({ runId: ingestionRunSources.runId })
    .from(ingestionRunSources)
    .innerJoin(ingestionRuns, eq(ingestionRuns.id, ingestionRunSources.runId))
    .where(and(eq(ingestionRuns.trigger, "schedule"), inArray(ingestionRunSources.status, ["queued"])));
  let n = 0;
  for (const { runId } of runs) n += (await cancelRun(runId, opts))?.cancelled.length ?? 0;
  return n;
}
