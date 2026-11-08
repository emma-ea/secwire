import { PgBoss, type Queue } from "pg-boss";
import { getEnv } from "../env";

/**
 * pg-boss client setup (SPEC §7.1).
 *
 * pg-boss creates and migrates its own `pgboss` schema on start() in the
 * worker, so the database user needs CREATE privilege on the database.
 */

export const QUEUES = {
  tick: "ingest.tick",
  schedulerSync: "scheduler.sync",
  source: "ingest.source",
  prune: "maintenance.prune",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Phase 2 adds enrich.cve, enrich.refresh and cluster.items. */
export const QUEUE_DEFINITIONS: Record<QueueName, Omit<Queue, "name">> = {
  [QUEUES.tick]: { policy: "exclusive", retryLimit: 0, expireInSeconds: 300 },
  [QUEUES.schedulerSync]: { policy: "exclusive", retryLimit: 5, retryDelay: 10, retryBackoff: true },
  // At most one queued + one active job per source (singletonKey = sourceId).
  [QUEUES.source]: {
    policy: "stately",
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  [QUEUES.prune]: { policy: "exclusive", retryLimit: 2 },
};

export const SCHEDULE_KEYS = {
  tick: "ingest-tick",
  prune: "maintenance-prune",
} as const;

export type IngestSourceJob = { runId: string; sourceId: string; force: boolean };

function attachErrorLogger(boss: PgBoss, label: string): PgBoss {
  boss.on("error", (err) => console.error(`[pg-boss:${label}] error:`, err));
  return boss;
}

/** Full instance: schema migration, supervision, scheduling. Worker process only. */
export function createWorkerBoss(): PgBoss {
  return attachErrorLogger(
    new PgBoss({
      connectionString: getEnv().DATABASE_URL,
      application_name: "secwire-worker",
      max: 10,
    }),
    "worker",
  );
}

/**
 * Send-only instance for the web app and CLI: no scheduling, supervision,
 * schema creation or migration. Workers are never registered on it.
 */
export function createSenderBoss(label = "web"): PgBoss {
  return attachErrorLogger(
    new PgBoss({
      connectionString: getEnv().DATABASE_URL,
      application_name: `secwire-${label}`,
      max: 3,
      schedule: false,
      supervise: false,
      migrate: false,
      createSchema: false,
    }),
    label,
  );
}

const globalForBoss = globalThis as unknown as { __secwireSender?: Promise<PgBoss> };

/** Lazily started process-wide sender (survives Next dev HMR). */
export function getSenderBoss(label = "web"): Promise<PgBoss> {
  globalForBoss.__secwireSender ??= (async () => {
    const boss = createSenderBoss(label);
    await boss.start();
    return boss;
  })().catch((err: unknown) => {
    globalForBoss.__secwireSender = undefined;
    throw err;
  });
  return globalForBoss.__secwireSender;
}

export async function stopSenderBoss(): Promise<void> {
  const p = globalForBoss.__secwireSender;
  globalForBoss.__secwireSender = undefined;
  if (p) await (await p).stop({ graceful: false, timeout: 5_000 }).catch(() => {});
}

/** Creates any queues that don't exist yet and brings policies up to date. Worker startup. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of Object.entries(QUEUE_DEFINITIONS)) {
    const existing = await boss.getQueue(name);
    if (!existing) {
      await boss.createQueue(name, options);
    } else {
      // Policy can't be changed after creation; everything else can.
      const { policy: _policy, ...rest } = options;
      await boss.updateQueue(name, rest);
    }
  }
}
