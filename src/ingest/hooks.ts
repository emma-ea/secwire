/**
 * Post-commit hook for runSource (SPEC §6.2 step 5): enqueue enrich.cve for
 * CVEs NVD hasn't been asked about yet, and cluster.items for new items.
 * Failures are logged, never thrown: the ingest itself already succeeded, the
 * tick re-enqueues clustering for leftover items, and the daily refresh picks
 * up CVEs that were never enriched.
 */
import type { PgBoss } from "pg-boss";
import { getPool } from "../db/client";
import { getSenderBoss, QUEUES, type ClusterJob, type EnrichCveJob } from "./boss";
import { unenrichedCvesForItems } from "./enrich/service";

export type AfterIngestEvent = { sourceId: string; newCveIds: string[]; itemIds: string[] };
export type AfterIngestResult = { clusterQueued: boolean; enrichQueued: number; enrichAlreadyQueued: number };

export async function afterIngest(event: AfterIngestEvent, deps: { boss?: PgBoss } = {}): Promise<AfterIngestResult> {
  const out: AfterIngestResult = { clusterQueued: false, enrichQueued: 0, enrichAlreadyQueued: 0 };
  if (!event.itemIds.length) return out;
  try {
    const boss = deps.boss ?? (await getSenderBoss());
    const pending = await getPool().query<{ any: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM items WHERE id = ANY($1::uuid[]) AND story_id IS NULL) AS any",
      [event.itemIds],
    );
    // cluster.items is stately: null = one is already queued and will pick these up.
    if (pending.rows[0]?.any) out.clusterQueued = (await boss.send(QUEUES.cluster, {} satisfies ClusterJob)) !== null;

    // Only CVEs that items mention: KEV catalog-only CVEs aren't enriched (DECISIONS.md).
    for (const cveId of await unenrichedCvesForItems(event.itemIds)) {
      const job: EnrichCveJob = { cveId };
      if (await boss.send(QUEUES.enrichCve, job, { singletonKey: cveId })) out.enrichQueued++;
      else out.enrichAlreadyQueued++;
    }
  } catch (err) {
    console.error(`[afterIngest] ${event.sourceId}: enqueue failed:`, err);
  }
  return out;
}

/** Sends cluster.items if any item is still unassigned (tick self-healing). */
export async function enqueueClusterIfPending(deps: { boss?: PgBoss } = {}): Promise<boolean> {
  const r = await getPool().query<{ any: boolean }>("SELECT EXISTS (SELECT 1 FROM items WHERE story_id IS NULL) AS any");
  if (!r.rows[0]?.any) return false;
  const boss = deps.boss ?? (await getSenderBoss());
  return (await boss.send(QUEUES.cluster, {} satisfies ClusterJob)) !== null;
}
