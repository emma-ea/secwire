/**
 * SecWire worker process (SPEC §2, §7.1). The only place pg-boss workers and
 * schedules are registered. Writes a heartbeat every 30s.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Job } from "pg-boss";
import { closeDb, getDb } from "../src/db/client";
import { getEnv } from "../src/env";
import { createWorkerBoss, ensureQueues, QUEUES, type IngestSourceJob } from "../src/ingest/boss";
import { handlePrune, handleSchedulerSync, handleSourceJob, handleTick } from "../src/ingest/handlers";
import { reconcileStaleRunSources } from "../src/ingest/runs";
import {
  HEARTBEAT_INTERVAL_MS,
  pruneHeartbeats,
  writeHeartbeat,
  type WorkerIdentity,
} from "../src/lib/heartbeat";

/** Sources fetched in parallel. Each source is still limited to one active job by the stately policy. */
const SOURCE_CONCURRENCY = 4;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const log = (...args: unknown[]) => console.log("[worker]", ...args);

async function main() {
  const env = getEnv(); // fail fast on bad config
  const db = getDb();

  const startedAt = new Date();
  const identity: WorkerIdentity = {
    workerId: `${os.hostname()}:${process.pid}:${startedAt.getTime().toString(36)}`,
    hostname: os.hostname(),
    startedAt,
    version: readVersion(),
  };

  const boss = createWorkerBoss();
  await boss.start();
  await ensureQueues(boss);
  log(`pg-boss started (worker ${identity.workerId}, v${identity.version})`);

  const pruned = await pruneHeartbeats(db);
  if (pruned > 0) log(`pruned ${pruned} stale heartbeat row(s)`);
  const stale = await reconcileStaleRunSources(db);
  if (stale > 0) log(`marked ${stale} abandoned run-source row(s) as failed`);

  // --- Handlers -----------------------------------------------------------

  await boss.work(QUEUES.tick, { localConcurrency: 1 }, async () => {
    const r = await handleTick();
    if (r.runId) log(`tick → run ${r.runId} for ${r.due.length} due source(s): ${r.due.join(", ")}`);
  });

  await boss.work<IngestSourceJob>(
    QUEUES.source,
    { localConcurrency: SOURCE_CONCURRENCY },
    async ([job]: Job<IngestSourceJob>[]) => {
      if (!job) return;
      await handleSourceJob(job);
    },
  );

  await boss.work(QUEUES.schedulerSync, { localConcurrency: 1 }, async () => {
    await handleSchedulerSync(boss);
  });

  await boss.work(QUEUES.prune, { localConcurrency: 1 }, async () => {
    const r = await handlePrune();
    log(`prune → ${r.runs} run(s), ${r.logins} login attempt(s), ${r.heartbeats} heartbeat(s)`);
  });

  // Database settings win over whatever schedules exist (SPEC §7.5).
  await handleSchedulerSync(boss);
  if (!env.WORKER_SCHEDULES_ENABLED) log("WORKER_SCHEDULES_ENABLED=false — no schedules; use POST /api/ingest");

  // --- Heartbeat ----------------------------------------------------------

  const beat = async () => {
    try {
      await writeHeartbeat(db, identity);
    } catch (err) {
      // Transient DB errors must not kill the worker; health will show the gap.
      console.error("[worker] heartbeat failed:", err);
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  log(`heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s; source concurrency ${SOURCE_CONCURRENCY}`);

  // --- Shutdown -----------------------------------------------------------

  // Dev wrappers (concurrently, tsx watch) often relay the same Ctrl-C twice
  // within milliseconds; only a deliberate second signal forces an exit.
  let stoppingSince: number | undefined;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stoppingSince !== undefined) {
      if (Date.now() - stoppingSince < 2_000) return;
      console.warn(`[worker] second ${signal}, exiting immediately`);
      process.exit(1);
    }
    stoppingSince = Date.now();
    log(`${signal} received, shutting down (waiting up to 30s for active jobs)`);
    clearInterval(timer);
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      console.error("[worker] error stopping pg-boss:", err);
    }
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", (s) => void shutdown(s));
  process.on("SIGTERM", (s) => void shutdown(s));
}

main().catch(async (err: unknown) => {
  console.error("[worker] fatal:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
