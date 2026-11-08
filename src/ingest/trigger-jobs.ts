/**
 * Entry points for enrichment and reclustering (SPEC §7.2 B/C, §7.3): admin
 * "Re-enrich" and "Recluster since…", `pnpm enrich` and `pnpm recluster`.
 * Like triggerIngestion, each request creates an ingestion_runs row (kind
 * enrich/recluster) and then enqueues a job, or runs inline for the CLI.
 *
 * The job execution itself (runEnrichCve / runRefresh / runCluster) is shared
 * by the worker handlers and the inline path.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getDb, type Db } from "../db/client";
import { ingestionRuns } from "../db/schema";
import { normalizeCveId } from "../lib/cve";
import type { Fetcher } from "./adapters/types";
import {
  getSenderBoss,
  QUEUES,
  RECLUSTER_SINGLETON_KEY,
  type ClusterJob,
  type EnrichCveJob,
  type EnrichRefreshJob,
} from "./boss";
import { clusterItems, recluster, type ClusterStats, type ReclusterStats } from "./cluster";
import {
  enrichCve,
  InvalidCveIdError,
  refreshEpss,
  selectRefreshTargets,
  type EnrichCveResult,
  type EnrichDeps,
} from "./enrich/service";
import { completeJobRun, createJobRun, markJobRunRunning } from "./runs";

export { InvalidCveIdError };

export type JobTrigger = "admin" | "cli" | "api" | "schedule";

export type JobTriggerResult = {
  runId: string;
  /** coalesced: an equivalent job was already queued; runId points at its run when known. */
  status: "queued" | "coalesced" | "succeeded" | "failed";
  error?: string | null;
  stats?: Record<string, unknown>;
};

type Common = {
  trigger: JobTrigger;
  triggeredBy?: string | null;
  /** Run in this process instead of enqueueing (CLI --inline). */
  inline?: boolean;
  boss?: PgBoss;
  fetcher?: Fetcher;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

/** Most recent queued/running run of this kind whose scope matches, if any. */
async function findActiveRun(db: Db, kind: "enrich" | "recluster", scope: Record<string, string>, exclude: string) {
  const conditions = Object.entries(scope).map(([k, v]) => sql`${ingestionRuns.scope}->>${k} = ${v}`);
  const [row] = await db
    .select({ id: ingestionRuns.id })
    .from(ingestionRuns)
    .where(
      and(
        eq(ingestionRuns.kind, kind),
        inArray(ingestionRuns.status, ["queued", "running"]),
        sql`${ingestionRuns.id} <> ${exclude}`,
        ...conditions,
      ),
    )
    .orderBy(desc(ingestionRuns.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * pg-boss rejected the job (policy). Point the caller at the run that owns the
 * queued job when there is one, and drop the run row we just created.
 */
async function coalesce(
  db: Db,
  runId: string,
  kind: "enrich" | "recluster",
  scope: Record<string, string>,
  what: string,
): Promise<JobTriggerResult> {
  const existing = await findActiveRun(db, kind, scope, runId);
  if (existing) {
    await db.delete(ingestionRuns).where(eq(ingestionRuns.id, runId));
    return { runId: existing, status: "coalesced" };
  }
  // Queued by the pipeline (no run row): keep ours as a record of the request.
  await completeJobRun(db, runId, { status: "succeeded", stats: { coalesced: true }, error: null });
  return { runId, status: "coalesced", error: `${what} was already queued` };
}

// ---------------------------------------------------------------------------
// Re-enrich one CVE
// ---------------------------------------------------------------------------

export async function runEnrichCve(
  db: Db,
  runId: string | undefined,
  data: Pick<EnrichCveJob, "cveId" | "epss">,
  deps: EnrichDeps,
): Promise<EnrichCveResult> {
  if (runId) await markJobRunRunning(db, runId);
  const r = await enrichCve(data.cveId, { epss: data.epss }, deps);
  if (runId) {
    await completeJobRun(db, runId, { status: "succeeded", stats: r as unknown as Record<string, unknown>, error: r.epssError });
  }
  return r;
}

export async function triggerEnrichCve(input: Common & { cveId: string }): Promise<JobTriggerResult> {
  const db = getDb();
  const cveId = normalizeCveId(input.cveId);
  if (!cveId) throw new InvalidCveIdError(input.cveId);
  const runId = await createJobRun(db, {
    trigger: input.trigger,
    triggeredBy: input.triggeredBy,
    kind: "enrich",
    scope: { mode: "cve", cveId },
  });

  if (input.inline) {
    try {
      const r = await runEnrichCve(db, runId, { cveId, epss: true }, { fetcher: input.fetcher });
      return { runId, status: "succeeded", stats: r as unknown as Record<string, unknown> };
    } catch (err) {
      await completeJobRun(db, runId, { status: "failed", error: errorMessage(err) });
      return { runId, status: "failed", error: errorMessage(err) };
    }
  }

  const boss = input.boss ?? (await getSenderBoss());
  const job: EnrichCveJob = { cveId, runId, epss: true };
  const jobId = await boss.send(QUEUES.enrichCve, job, { singletonKey: cveId });
  if (jobId) return { runId, status: "queued" };
  return coalesce(db, runId, "enrich", { mode: "cve", cveId }, `Enrichment of ${cveId}`);
}

// ---------------------------------------------------------------------------
// Stale refresh (daily schedule, `pnpm enrich --stale`)
// ---------------------------------------------------------------------------

export type RefreshStats = {
  nvdTargets: number;
  nvdQueued: number;
  nvdAlreadyQueued: number;
  nvdEnriched: number;
  nvdFailed: number;
  epssTargets: number;
  epssScored: number;
  epssError: string | null;
};

/**
 * SPEC §6.6 daily refresh. EPSS is fetched here in batches of 100; NVD
 * lookups are enqueued as enrich.cve jobs (throttled by the worker), or run
 * one by one when inline.
 */
export async function runRefresh(
  db: Db,
  runId: string,
  opts: { inline: boolean; boss?: PgBoss; deps?: EnrichDeps; onProgress?: (msg: string) => void },
): Promise<RefreshStats> {
  await markJobRunRunning(db, runId);
  const targets = await selectRefreshTargets(db);
  const stats: RefreshStats = {
    nvdTargets: targets.nvd.length,
    nvdQueued: 0,
    nvdAlreadyQueued: 0,
    nvdEnriched: 0,
    nvdFailed: 0,
    epssTargets: targets.epss.length,
    epssScored: 0,
    epssError: null,
  };

  try {
    stats.epssScored = await refreshEpss(targets.epss, opts.deps);
  } catch (err) {
    stats.epssError = errorMessage(err);
  }
  opts.onProgress?.(`EPSS: ${stats.epssScored}/${stats.epssTargets} scored${stats.epssError ? ` (error: ${stats.epssError})` : ""}`);

  if (opts.inline) {
    for (const [i, cveId] of targets.nvd.entries()) {
      try {
        const r = await enrichCve(cveId, { epss: false }, opts.deps);
        stats.nvdEnriched++;
        opts.onProgress?.(`NVD ${i + 1}/${targets.nvd.length} ${cveId}: ${r.nvd}${r.cvssScore !== null ? ` CVSS ${r.cvssScore}` : ""}`);
      } catch (err) {
        stats.nvdFailed++;
        opts.onProgress?.(`NVD ${i + 1}/${targets.nvd.length} ${cveId}: failed — ${errorMessage(err)}`);
      }
    }
  } else {
    const boss = opts.boss ?? (await getSenderBoss());
    for (const cveId of targets.nvd) {
      const job: EnrichCveJob = { cveId, epss: false };
      if (await boss.send(QUEUES.enrichCve, job, { singletonKey: cveId })) stats.nvdQueued++;
      else stats.nvdAlreadyQueued++;
    }
  }

  const failed = stats.nvdFailed > 0 && stats.nvdEnriched === 0 && stats.nvdTargets > 0;
  await completeJobRun(db, runId, {
    status: failed ? "failed" : "succeeded",
    stats,
    error: [stats.epssError && `EPSS: ${stats.epssError}`, stats.nvdFailed && `NVD: ${stats.nvdFailed} failed`]
      .filter(Boolean)
      .join("; ") || null,
  });
  return stats;
}

export async function triggerEnrichRefresh(
  input: Common & { onProgress?: (msg: string) => void },
): Promise<JobTriggerResult> {
  const db = getDb();
  const runId = await createJobRun(db, {
    trigger: input.trigger,
    triggeredBy: input.triggeredBy,
    kind: "enrich",
    scope: { mode: "refresh" },
  });
  if (input.inline) {
    try {
      const stats = await runRefresh(db, runId, {
        inline: true,
        deps: { fetcher: input.fetcher },
        onProgress: input.onProgress,
      });
      return { runId, status: stats.nvdFailed && !stats.nvdEnriched ? "failed" : "succeeded", stats };
    } catch (err) {
      await completeJobRun(db, runId, { status: "failed", error: errorMessage(err) });
      return { runId, status: "failed", error: errorMessage(err) };
    }
  }
  const boss = input.boss ?? (await getSenderBoss());
  const job: EnrichRefreshJob = { runId };
  if (await boss.send(QUEUES.enrichRefresh, job)) return { runId, status: "queued" };
  return coalesce(db, runId, "enrich", { mode: "refresh" }, "A refresh");
}

// ---------------------------------------------------------------------------
// Cluster / recluster
// ---------------------------------------------------------------------------

export async function runCluster(
  db: Db,
  runId: string | undefined,
  data: ClusterJob,
): Promise<ClusterStats | ReclusterStats> {
  if (runId) await markJobRunRunning(db, runId);
  const stats = data.since ? await recluster(new Date(data.since)) : await clusterItems();
  if (runId) await completeJobRun(db, runId, { status: "succeeded", stats });
  return stats;
}

export class InvalidSinceError extends Error {
  constructor(input: string) {
    super(`Invalid date: ${input} (expected an ISO date such as 2026-10-01)`);
    this.name = "InvalidSinceError";
  }
}

/** Parses YYYY-MM-DD (midnight UTC) or a full ISO timestamp; rejects future dates. */
export function parseSince(input: string, now = new Date()): Date {
  const s = input.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) {
    throw new InvalidSinceError(input);
  }
  return d;
}

export async function triggerRecluster(input: Common & { since: Date }): Promise<JobTriggerResult> {
  const db = getDb();
  const since = input.since.toISOString();
  const runId = await createJobRun(db, {
    trigger: input.trigger,
    triggeredBy: input.triggeredBy,
    kind: "recluster",
    scope: { since },
  });
  if (input.inline) {
    try {
      const stats = await runCluster(db, runId, { since });
      return { runId, status: "succeeded", stats };
    } catch (err) {
      await completeJobRun(db, runId, { status: "failed", error: errorMessage(err) });
      return { runId, status: "failed", error: errorMessage(err) };
    }
  }
  // cluster.items is stately: this queues behind any active clustering (SPEC §7.4).
  const boss = input.boss ?? (await getSenderBoss());
  const job: ClusterJob = { runId, since };
  if (await boss.send(QUEUES.cluster, job, { singletonKey: RECLUSTER_SINGLETON_KEY })) {
    return { runId, status: "queued" };
  }
  return coalesce(db, runId, "recluster", {}, "A recluster");
}
