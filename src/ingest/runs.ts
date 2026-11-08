/**
 * ingestion_runs / ingestion_run_sources bookkeeping shared by every entry
 * point. A run is "finished" once none of its source rows is queued/running;
 * whoever writes the last result finalizes it.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { ingestionRunSources, ingestionRuns, TERMINAL_RUN_SOURCE_STATUSES } from "../db/schema";

export type RunSourceStatus = (typeof ingestionRunSources.$inferSelect)["status"];
export type RunStatus = (typeof ingestionRuns.$inferSelect)["status"];

export type RunSourceResult = {
  status: Extract<RunSourceStatus, "succeeded" | "not_modified" | "skipped_locked" | "failed" | "skipped_disabled" | "skipped_budget">;
  httpStatus: number | null;
  itemsSeen: number;
  itemsNew: number;
  itemsUpdated: number;
  durationMs: number;
  error: string | null;
};

/** Stale "running" rows older than this are failed by reconcileStaleRunSources (job expiry is 10 min). */
export const STALE_RUNNING_MINUTES = 15;

export async function markRunSourceRunning(
  db: Db,
  runId: string,
  sourceId: string,
  attempt: number,
): Promise<boolean> {
  const updated = await db
    .update(ingestionRunSources)
    .set({ status: "running", attempts: attempt, startedAt: sql`now()`, error: null })
    .where(
      and(
        eq(ingestionRunSources.runId, runId),
        eq(ingestionRunSources.sourceId, sourceId),
        // A cancelled row must stay cancelled even if its job slipped through.
        inArray(ingestionRunSources.status, ["queued", "running"]),
      ),
    )
    .returning({ runId: ingestionRunSources.runId });
  if (updated.length === 0) return false;
  await db
    .update(ingestionRuns)
    .set({ status: "running", startedAt: sql`coalesce(${ingestionRuns.startedAt}, now())` })
    .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.status, "queued")));
  return true;
}

/** Records an attempt that failed but will be retried: row stays "running". */
export async function recordRetryableFailure(
  db: Db,
  runId: string,
  sourceId: string,
  error: string,
  httpStatus: number | null,
): Promise<void> {
  await db
    .update(ingestionRunSources)
    .set({ error, httpStatus })
    .where(and(eq(ingestionRunSources.runId, runId), eq(ingestionRunSources.sourceId, sourceId)));
}

export async function recordRunSourceResult(
  db: Db,
  runId: string,
  sourceId: string,
  r: RunSourceResult,
): Promise<void> {
  await db
    .update(ingestionRunSources)
    .set({
      status: r.status,
      httpStatus: r.httpStatus,
      itemsSeen: r.itemsSeen,
      itemsNew: r.itemsNew,
      itemsUpdated: r.itemsUpdated,
      durationMs: r.durationMs,
      error: r.error,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(ingestionRunSources.runId, runId),
        eq(ingestionRunSources.sourceId, sourceId),
        inArray(ingestionRunSources.status, ["queued", "running"]),
      ),
    );
  await finalizeRun(db, runId);
}

/**
 * Derives the final run status from its source rows:
 * - any failed → "failed" if nothing else did useful work, else "partial"
 * - any cancelled (and none failed) → "cancelled"
 * - otherwise → "succeeded" (skips, coalesced and not_modified count as success)
 */
export function deriveRunStatus(counts: Partial<Record<RunSourceStatus, number>>): RunStatus {
  const n = (s: RunSourceStatus) => counts[s] ?? 0;
  const failed = n("failed");
  const cancelled = n("cancelled");
  const useful = n("succeeded") + n("not_modified");
  if (failed > 0) return useful > 0 || cancelled > 0 || n("coalesced") > 0 ? "partial" : "failed";
  if (cancelled > 0) return "cancelled";
  return "succeeded";
}

/** Finalizes the run if every source row is terminal. Idempotent and race-safe (row lock). */
export async function finalizeRun(db: Db, runId: string): Promise<RunStatus | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: ingestionRuns.status })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, runId))
      .for("update");
    if (!run || !["queued", "running"].includes(run.status)) return null;

    const rows = await tx
      .select({
        status: ingestionRunSources.status,
        n: sql<number>`count(*)::int`,
        seen: sql<number>`coalesce(sum(${ingestionRunSources.itemsSeen}), 0)::int`,
        added: sql<number>`coalesce(sum(${ingestionRunSources.itemsNew}), 0)::int`,
        updated: sql<number>`coalesce(sum(${ingestionRunSources.itemsUpdated}), 0)::int`,
      })
      .from(ingestionRunSources)
      .where(eq(ingestionRunSources.runId, runId))
      .groupBy(ingestionRunSources.status);

    if (rows.some((r) => r.status === "queued" || r.status === "running")) return null;

    const counts = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<RunSourceStatus, number>>;
    const status = deriveRunStatus(counts);
    const failedRows = await tx
      .select({ sourceId: ingestionRunSources.sourceId, error: ingestionRunSources.error })
      .from(ingestionRunSources)
      .where(and(eq(ingestionRunSources.runId, runId), eq(ingestionRunSources.status, "failed")));

    await tx
      .update(ingestionRuns)
      .set({
        status,
        finishedAt: sql`now()`,
        startedAt: sql`coalesce(${ingestionRuns.startedAt}, now())`,
        stats: {
          sources: rows.reduce((a, r) => a + r.n, 0),
          byStatus: counts,
          itemsSeen: rows.reduce((a, r) => a + r.seen, 0),
          itemsNew: rows.reduce((a, r) => a + r.added, 0),
          itemsUpdated: rows.reduce((a, r) => a + r.updated, 0),
        },
        error: failedRows.length
          ? failedRows.map((f) => `${f.sourceId}: ${f.error ?? "failed"}`).join("\n").slice(0, 4000)
          : null,
      })
      .where(eq(ingestionRuns.id, runId));
    return status;
  });
}

/**
 * Fails run-source rows stuck in "running" (worker crashed, job expired) so
 * their runs can finalize. Called on every tick and at worker startup.
 */
export async function reconcileStaleRunSources(db: Db): Promise<number> {
  const stale = await db
    .update(ingestionRunSources)
    .set({
      status: "failed",
      error: sql`coalesce(${ingestionRunSources.error} || ' — ', '') || 'abandoned: no result after ${sql.raw(String(STALE_RUNNING_MINUTES))} min (worker stopped or job expired)'`,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(ingestionRunSources.status, "running"),
        sql`${ingestionRunSources.startedAt} < now() - make_interval(mins => ${STALE_RUNNING_MINUTES})`,
      ),
    )
    .returning({ runId: ingestionRunSources.runId });
  for (const runId of new Set(stale.map((s) => s.runId))) await finalizeRun(db, runId);
  return stale.length;
}

export async function getRun(db: Db, runId: string) {
  const [run] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
  if (!run) return null;
  const sources = await db
    .select()
    .from(ingestionRunSources)
    .where(eq(ingestionRunSources.runId, runId))
    .orderBy(ingestionRunSources.sourceId);
  return { ...run, sources };
}

export async function listRuns(db: Db, limit = 20) {
  return db
    .select()
    .from(ingestionRuns)
    .orderBy(desc(ingestionRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Source ids that currently have a queued or running job (disables "Run now"). */
export async function activeSourceIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ sourceId: ingestionRunSources.sourceId })
    .from(ingestionRunSources)
    .where(inArray(ingestionRunSources.status, ["queued", "running"]));
  return new Set(rows.map((r) => r.sourceId));
}

export function isTerminal(status: RunSourceStatus): boolean {
  return (TERMINAL_RUN_SOURCE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Enrich / recluster runs: one job, no per-source rows. Their status is set
// directly by the job handler (or the inline CLI path).
// ---------------------------------------------------------------------------

export type JobRunKind = "enrich" | "recluster";

/** Job runs stuck in "running" longer than this are failed (longest job expiry is 30 min). */
export const STALE_JOB_RUN_MINUTES = 45;

export async function createJobRun(
  db: Db,
  input: { trigger: (typeof ingestionRuns.$inferInsert)["trigger"]; triggeredBy?: string | null; kind: JobRunKind; scope: Record<string, unknown> },
): Promise<string> {
  const [run] = await db
    .insert(ingestionRuns)
    .values({ trigger: input.trigger, triggeredBy: input.triggeredBy ?? null, kind: input.kind, scope: input.scope, status: "queued" })
    .returning({ id: ingestionRuns.id });
  return run!.id;
}

export async function markJobRunRunning(db: Db, runId: string): Promise<boolean> {
  const r = await db
    .update(ingestionRuns)
    .set({ status: "running", startedAt: sql`coalesce(${ingestionRuns.startedAt}, now())` })
    .where(and(eq(ingestionRuns.id, runId), inArray(ingestionRuns.status, ["queued", "running"])))
    .returning({ id: ingestionRuns.id });
  return r.length > 0;
}

export async function completeJobRun(
  db: Db,
  runId: string,
  result: { status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">; stats?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({
      status: result.status,
      stats: result.stats ?? {},
      error: result.error?.slice(0, 4000) ?? null,
      finishedAt: sql`now()`,
      startedAt: sql`coalesce(${ingestionRuns.startedAt}, now())`,
    })
    .where(and(eq(ingestionRuns.id, runId), inArray(ingestionRuns.status, ["queued", "running"])));
}

/** Records the error of an attempt that pg-boss will retry; the run stays "running". */
export async function noteJobRunRetry(db: Db, runId: string, error: string, attempt: number): Promise<void> {
  await db
    .update(ingestionRuns)
    .set({ error: `attempt ${attempt}: ${error}`.slice(0, 4000) })
    .where(eq(ingestionRuns.id, runId));
}

/** Fails enrich/recluster runs left "running" by a crashed worker. Called on every tick and at startup. */
export async function reconcileStaleJobRuns(db: Db): Promise<number> {
  const r = await db
    .update(ingestionRuns)
    .set({
      status: "failed",
      error: sql`coalesce(${ingestionRuns.error} || ' — ', '') || ${`abandoned: no result after ${STALE_JOB_RUN_MINUTES} min (worker stopped or job expired)`}`,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        inArray(ingestionRuns.kind, ["enrich", "recluster"]),
        eq(ingestionRuns.status, "running"),
        sql`${ingestionRuns.startedAt} < now() - make_interval(mins => ${STALE_JOB_RUN_MINUTES})`,
      ),
    )
    .returning({ id: ingestionRuns.id });
  return r.length;
}
