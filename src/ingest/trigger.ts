/**
 * triggerIngestion (SPEC §7.2): the one function behind every entry point —
 * scheduler tick, admin UI, CLI and POST /api/ingest. It creates the
 * ingestion_runs row, applies skip rules, then enqueues jobs (or runs inline).
 */
import { asc, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getDb, type Db } from "../db/client";
import { ingestionRunSources, ingestionRuns, sources } from "../db/schema";
import { getAdapter, type NormalizedItem } from "./adapters";
import { getSenderBoss, QUEUES, type IngestSourceJob } from "./boss";
import { runSource, type RunSourceOptions } from "./run-source";
import { finalizeRun, recordRunSourceResult, type RunSourceStatus } from "./runs";
import { testSource } from "./test-source";

export const COOLDOWN_SECONDS = 60;

export type TriggerKind = "schedule" | "admin" | "api" | "cli";

export type TriggerInput = {
  trigger: TriggerKind;
  triggeredBy?: string | null;
  kind?: "ingest" | "backfill";
  sourceIds: string[] | "all";
  force?: boolean;
  includeDisabled?: boolean;
  /** Run in-process instead of enqueueing (CLI --inline, backfill). */
  inline?: boolean;
  /** Fetch + parse only; no DB writes, no run row. */
  dryRun?: boolean;
  /** Backfill window (HN only). */
  range?: { since: Date; until?: Date };
  /** Test seams. */
  boss?: PgBoss;
  fetcher?: RunSourceOptions["fetcher"];
};

export type TriggerSourceStatus = RunSourceStatus | "dry_run";

export type TriggerSourceResult = {
  sourceId: string;
  status: TriggerSourceStatus;
  jobId?: string | null;
  coalescedIntoJobId?: string | null;
  error?: string | null;
  itemsNew?: number;
  preview?: NormalizedItem[];
};

export type TriggerResult = { runId: string | null; sources: TriggerSourceResult[] };

export class UnknownSourcesError extends Error {
  constructor(public readonly unknownIds: string[]) {
    super(`Unknown source id(s): ${unknownIds.join(", ")}`);
    this.name = "UnknownSourcesError";
  }
}

export class BackfillNotSupportedError extends Error {
  constructor(public readonly sourceIds: string[]) {
    super(
      `Cannot backfill: ${sourceIds.join(", ")}. RSS feeds only contain recent entries, so past items can't be fetched; only Hacker News supports time ranges.`,
    );
    this.name = "BackfillNotSupportedError";
  }
}

type SourceRow = typeof sources.$inferSelect;

export async function triggerIngestion(input: TriggerInput): Promise<TriggerResult> {
  const db = getDb();
  const force = input.force ?? false;
  const kind = input.kind ?? "ingest";
  const selected = await resolveSources(db, input.sourceIds, input.includeDisabled ?? false);

  if (kind === "backfill") {
    const unsupported = selected.filter((s) => !getAdapter(s.type).supportsBackfill).map((s) => s.id);
    if (unsupported.length) throw new BackfillNotSupportedError(unsupported);
    if (!input.range) throw new Error("backfill requires a range");
  }

  if (input.dryRun) {
    const out: TriggerSourceResult[] = [];
    for (const s of selected) {
      const r = await testSource(s);
      out.push({ sourceId: s.id, status: "dry_run", preview: r.items, error: r.error });
    }
    return { runId: null, sources: out };
  }

  // Decide per-source status before writing anything.
  const now = Date.now();
  const plan = selected.map((s) => ({ source: s, status: initialStatus(s, input, force, now) }));

  const [run] = await db
    .insert(ingestionRuns)
    .values({
      trigger: input.trigger,
      triggeredBy: input.triggeredBy ?? null,
      kind,
      scope: {
        sourceIds: input.sourceIds,
        force,
        includeDisabled: input.includeDisabled ?? false,
        inline: input.inline ?? false,
        ...(input.range
          ? { since: input.range.since.toISOString(), until: input.range.until?.toISOString() ?? null }
          : {}),
      },
      status: "queued",
    })
    .returning({ id: ingestionRuns.id });
  const runId = run!.id;

  if (plan.length) {
    await db.insert(ingestionRunSources).values(
      plan.map((p) => ({
        runId,
        sourceId: p.source.id,
        status: p.status,
        error:
          p.status === "skipped_disabled"
            ? "source is disabled"
            : p.status === "skipped_cooldown"
              ? `succeeded less than ${COOLDOWN_SECONDS}s ago; use force to override`
              : null,
        finishedAt: p.status === "queued" ? null : sql`now()`,
      })),
    );
  }

  const results: TriggerSourceResult[] = [];
  const runnable = plan.filter((p) => p.status === "queued");
  for (const p of plan.filter((p) => p.status !== "queued")) {
    results.push({ sourceId: p.source.id, status: p.status });
  }

  if (input.inline) {
    for (const { source } of runnable) {
      const o = await runSource(source.id, { runId, force, isFinalAttempt: true, range: input.range, fetcher: input.fetcher });
      results.push({ sourceId: source.id, status: o.status, error: o.error, itemsNew: o.itemsNew });
    }
  } else if (runnable.length) {
    const boss = input.boss ?? (await getSenderBoss());
    for (const { source } of runnable) {
      results.push(await enqueueSource(db, boss, runId, source.id, force));
    }
  }

  await finalizeRun(db, runId);
  // Preserve the caller's ordering.
  const order = new Map(selected.map((s, i) => [s.id, i]));
  results.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));
  return { runId, sources: results };
}

function initialStatus(s: SourceRow, input: TriggerInput, force: boolean, now: number): RunSourceStatus {
  if (!s.enabled && !input.includeDisabled) return "skipped_disabled";
  // The scheduler's due check already spaces runs out; cooldown is for manual triggers.
  if (
    input.trigger !== "schedule" &&
    !force &&
    s.lastSuccessAt &&
    now - s.lastSuccessAt.getTime() < COOLDOWN_SECONDS * 1000
  ) {
    return "skipped_cooldown";
  }
  return "queued";
}

async function resolveSources(db: Db, ids: string[] | "all", includeDisabled: boolean): Promise<SourceRow[]> {
  if (ids === "all") {
    const rows = await db.select().from(sources).orderBy(asc(sources.id));
    return includeDisabled ? rows : rows.filter((s) => s.enabled);
  }
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select().from(sources).where(inArray(sources.id, unique));
  const found = new Set(rows.map((r) => r.id));
  const unknown = unique.filter((id) => !found.has(id));
  if (unknown.length) throw new UnknownSourcesError(unknown);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)!);
}

/**
 * Sends one ingest.source job. pg-boss returns null (doesn't throw) when the
 * stately policy rejects it because a job for this source is already queued:
 * that's "coalesced", and we record which job absorbed the request.
 */
async function enqueueSource(
  db: Db,
  boss: PgBoss,
  runId: string,
  sourceId: string,
  force: boolean,
): Promise<TriggerSourceResult> {
  const data: IngestSourceJob = { runId, sourceId, force };
  for (let attempt = 0; attempt < 2; attempt++) {
    const jobId = await boss.send(QUEUES.source, data, { singletonKey: sourceId });
    if (jobId) {
      await db
        .update(ingestionRunSources)
        .set({ jobId })
        .where(sql`${ingestionRunSources.runId} = ${runId} AND ${ingestionRunSources.sourceId} = ${sourceId}`);
      return { sourceId, status: "queued", jobId };
    }
    const [existing] = await boss.findJobs(QUEUES.source, { key: sourceId, queued: true });
    if (existing) {
      await db
        .update(ingestionRunSources)
        .set({ status: "coalesced", coalescedIntoJobId: existing.id, finishedAt: sql`now()` })
        .where(sql`${ingestionRunSources.runId} = ${runId} AND ${ingestionRunSources.sourceId} = ${sourceId}`);
      return { sourceId, status: "coalesced", coalescedIntoJobId: existing.id };
    }
    // Rejected, but the blocking job left the queue in between — try once more.
  }
  const error = "pg-boss rejected the job but no queued job was found to coalesce into";
  await recordRunSourceResult(db, runId, sourceId, {
    status: "failed",
    httpStatus: null,
    itemsSeen: 0,
    itemsNew: 0,
    itemsUpdated: 0,
    durationMs: 0,
    error,
  });
  return { sourceId, status: "failed", error };
}
