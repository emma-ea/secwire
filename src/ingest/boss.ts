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
  enrichCve: "enrich.cve",
  enrichRefresh: "enrich.refresh",
  cluster: "cluster.items",
  summarize: "summarize.story",
  alertsScan: "alerts.scan",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

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
  // At most one queued + one active job per CVE (singletonKey = cveId). The
  // worker runs it at concurrency 1 behind an NVD throttle; rate-limit
  // responses throw and retry with backoff. Expiry allows for throttle waits.
  [QUEUES.enrichCve]: {
    policy: "stately",
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
  },
  [QUEUES.enrichRefresh]: { policy: "exclusive", retryLimit: 2, retryDelay: 300, expireInSeconds: 1800 },
  // Pipeline jobs have no key, so one queued + one active at a time; recluster
  // jobs use RECLUSTER_SINGLETON_KEY so a queued pipeline job can't swallow
  // them. Both serialize on the story advisory lock.
  [QUEUES.cluster]: { policy: "stately", retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 1800 },
  // Phase 3: one queued job per story (singletonKey = story id); paid, so few retries.
  [QUEUES.summarize]: { policy: "stately", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 },
  // One queued + one active scan; failed deliveries are retried by the next scan, not by pg-boss.
  [QUEUES.alertsScan]: { policy: "stately", retryLimit: 1, retryDelay: 60, expireInSeconds: 600 },
};

export const RECLUSTER_SINGLETON_KEY = "recluster";

export const SCHEDULE_KEYS = {
  tick: "ingest-tick",
  prune: "maintenance-prune",
  enrichRefresh: "enrich-refresh",
} as const;

export type IngestSourceJob = { runId: string; sourceId: string; force: boolean };
/** `epss: false` when the caller batches EPSS itself (daily refresh). `runId` only for admin/CLI requests. */
export type EnrichCveJob = { cveId: string; runId?: string; epss?: boolean };
export type EnrichRefreshJob = { runId?: string };
/** `since` (ISO) makes it a recluster. */
export type ClusterJob = { runId?: string; since?: string };
export type SummarizeStoryJob = { storyId: string };

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
