import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { WORKER_OFFLINE_AFTER_SEC } from "./scheduler";

/** Raw facts read from the DB in a single round trip. */
export type HealthSnapshot = {
  lastBeatAgeSec: number | null;
  settings: {
    schedulerEnabled: boolean;
    schedulerIntervalMinutes: number;
    lastTickAt: Date | null;
  } | null;
};

export type HealthBody = {
  db: "ok" | "error";
  worker: { lastBeatAgeSec: number | null; online: boolean };
  scheduler: {
    enabled: boolean | null;
    intervalMinutes: number | null;
    lastTickAt: string | null;
    nextRunAt: string | null;
  };
  queues: Record<string, number>;
};

type Row = {
  last_beat_age_sec: number | string | null;
  scheduler_enabled: boolean | null;
  scheduler_interval_minutes: number | null;
  last_tick_at: Date | string | null;
};

export async function readHealthSnapshot(db: Db): Promise<HealthSnapshot> {
  const result = await db.execute<Row>(sql`
    SELECT
      (SELECT extract(epoch FROM now() - max(last_beat_at))::float8
         FROM worker_heartbeats) AS last_beat_age_sec,
      s.scheduler_enabled,
      s.scheduler_interval_minutes,
      s.last_tick_at
    FROM (SELECT 1) AS one
    LEFT JOIN app_settings s ON s.id
  `);
  const row = result.rows[0];
  if (!row) return { lastBeatAgeSec: null, settings: null };

  return {
    lastBeatAgeSec:
      row.last_beat_age_sec === null ? null : Number(row.last_beat_age_sec),
    settings:
      row.scheduler_enabled === null || row.scheduler_interval_minutes === null
        ? null
        : {
            schedulerEnabled: row.scheduler_enabled,
            schedulerIntervalMinutes: row.scheduler_interval_minutes,
            lastTickAt: row.last_tick_at ? new Date(row.last_tick_at) : null,
          },
  };
}

/**
 * Pure: turns a snapshot (or the error from reading it) into the §7.3 health
 * response. Only an unreachable DB is a 503; a stale worker is reported in the
 * body but the web app itself is still healthy.
 *
 * Phase 0: `nextRunAt` is null and `queues` is empty — both arrive in Phase 1
 * with the scheduler module and the web-side pg-boss client.
 */
export function buildHealth(snapshot: HealthSnapshot | Error): {
  status: 200 | 503;
  body: HealthBody;
} {
  if (snapshot instanceof Error) {
    return {
      status: 503,
      body: {
        db: "error",
        worker: { lastBeatAgeSec: null, online: false },
        scheduler: {
          enabled: null,
          intervalMinutes: null,
          lastTickAt: null,
          nextRunAt: null,
        },
        queues: {},
      },
    };
  }

  const age =
    snapshot.lastBeatAgeSec === null
      ? null
      : Math.max(0, Math.round(snapshot.lastBeatAgeSec));

  return {
    status: 200,
    body: {
      db: "ok",
      worker: {
        lastBeatAgeSec: age,
        online: age !== null && age <= WORKER_OFFLINE_AFTER_SEC,
      },
      scheduler: {
        enabled: snapshot.settings?.schedulerEnabled ?? null,
        intervalMinutes: snapshot.settings?.schedulerIntervalMinutes ?? null,
        lastTickAt: snapshot.settings?.lastTickAt?.toISOString() ?? null,
        nextRunAt: null,
      },
      queues: {},
    },
  };
}
