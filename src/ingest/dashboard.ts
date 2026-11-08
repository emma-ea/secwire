/** Everything the admin dashboard polls for, in one call. */
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { WORKER_OFFLINE_AFTER_SEC } from "../lib/scheduler";
import { getSenderBoss } from "./boss";
import { listRuns } from "./runs";
import { listSourcesForAdmin } from "./sources-service";

export type DashboardStatus = Awaited<ReturnType<typeof getDashboardStatus>>;

export async function getDashboardStatus() {
  const db = getDb();
  const [runs, sources, beat, queues] = await Promise.all([
    listRuns(db, 15),
    listSourcesForAdmin(),
    db.execute<{ age: number | null }>(
      sql`SELECT extract(epoch FROM now() - max(last_beat_at))::float8 AS age FROM worker_heartbeats`,
    ),
    queueDepths(),
  ]);
  const age = beat.rows[0]?.age ?? null;
  return {
    runs: runs.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      triggeredBy: r.triggeredBy,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      stats: r.stats as { sources?: number; itemsNew?: number; byStatus?: Record<string, number> },
    })),
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      category: s.category,
      url: s.url,
      enabled: s.enabled,
      minIntervalMinutes: s.minIntervalMinutes,
      lastFetchedAt: s.lastFetchedAt?.toISOString() ?? null,
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
      items24h: s.items24h,
      busy: s.busy,
      unhealthy: s.unhealthy,
    })),
    worker: {
      lastBeatAgeSec: age === null ? null : Math.max(0, Math.round(age)),
      online: age !== null && age <= WORKER_OFFLINE_AFTER_SEC,
    },
    queues,
  };
}

async function queueDepths(): Promise<Array<{ name: string; queued: number; active: number; failed: number }> | null> {
  try {
    const boss = await getSenderBoss();
    return (await boss.getQueues())
      .filter((q) => !q.name.startsWith("__"))
      .map((q) => ({ name: q.name, queued: q.queuedCount, active: q.activeCount, failed: q.failedCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
}
