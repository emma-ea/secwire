import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { workerHeartbeats } from "../db/schema";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export type WorkerIdentity = {
  workerId: string;
  hostname: string;
  startedAt: Date;
  version: string;
};

/** Upserts this worker's heartbeat. Uses DB time so age checks aren't skewed by host clocks. */
export async function writeHeartbeat(db: Db, w: WorkerIdentity): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ ...w, lastBeatAt: sql`now()` })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { lastBeatAt: sql`now()` },
    });
}

/** Removes rows left behind by workers that stopped beating more than `olderThanHours` ago. */
export async function pruneHeartbeats(db: Db, olderThanHours = 24): Promise<number> {
  const deleted = await db
    .delete(workerHeartbeats)
    .where(
      lt(
        workerHeartbeats.lastBeatAt,
        sql`now() - make_interval(hours => ${olderThanHours})`,
      ),
    )
    .returning({ workerId: workerHeartbeats.workerId });
  return deleted.length;
}
