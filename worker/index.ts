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
import {
  createWorkerBoss,
  ensureQueues,
  QUEUES,
  type ClusterJob,
  type EnrichCveJob,
  type EnrichRefreshJob,
  type IngestSourceJob,
  type SummarizeStoryJob,
} from "../src/ingest/boss";
import { nvdSpacingMs } from "../src/ingest/enrich/throttle";
import {
  handleAlertScanJob,
  handleClusterJob,
  handleEnrichCveJob,
  handleEnrichRefreshJob,
  handlePrune,
  handleSchedulerSync,
  handleSourceJob,
  handleSummarizeJob,
  handleTick,
} from "../src/ingest/handlers";
import { enqueueClusterIfPending } from "../src/ingest/hooks";
import { reconcileStaleJobRuns, reconcileStaleRunSources } from "../src/ingest/runs";
import { PROVIDERS, providerStatus } from "../src/ingest/spend";
import { channelStatus } from "../src/ingest/alerts";
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
  const staleJobs = await reconcileStaleJobRuns(db);
  if (staleJobs > 0) log(`marked ${staleJobs} abandoned enrich/recluster run(s) as failed`);

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

  // NVD allows 5 req/30s without a key: one job at a time behind the throttle (SPEC §6.6).
  await boss.work<EnrichCveJob>(QUEUES.enrichCve, { localConcurrency: 1 }, async ([job]: Job<EnrichCveJob>[]) => {
    if (!job) return;
    const r = await handleEnrichCveJob(job);
    if (r) {
      log(
        `enrich ${r.cveId}: NVD ${r.nvd}${r.cvssScore !== null ? ` (CVSS ${r.cvssScore})` : ""}, EPSS ${r.epssUpdated} scored${r.epssError ? ` (EPSS error: ${r.epssError})` : ""}, ${r.storiesRefreshed} stor${r.storiesRefreshed === 1 ? "y" : "ies"} refreshed`,
      );
    }
  });

  await boss.work<EnrichRefreshJob>(QUEUES.enrichRefresh, { localConcurrency: 1 }, async ([job]: Job<EnrichRefreshJob>[]) => {
    if (!job) return;
    const r = await handleEnrichRefreshJob(job, { boss });
    if (r) log(`enrich.refresh → NVD ${r.nvdQueued} queued (${r.nvdAlreadyQueued} already), EPSS ${r.epssScored}/${r.epssTargets}`);
  });

  await boss.work<ClusterJob>(QUEUES.cluster, { localConcurrency: 1 }, async ([job]: Job<ClusterJob>[]) => {
    if (!job) return;
    const r = await handleClusterJob(job, { boss });
    if (r.processed > 0 || job.data.since) {
      log(
        `${job.data.since ? `recluster since ${job.data.since}` : "cluster"} → ${r.processed} item(s): ${r.joinedByUrl} by URL, ${r.joinedByCve} by CVE, ${r.created} new stor${r.created === 1 ? "y" : "ies"}`,
      );
    }
  });

  // Paid: one at a time (the spend lock serializes them anyway).
  await boss.work<SummarizeStoryJob>(QUEUES.summarize, { localConcurrency: 1 }, async ([job]: Job<SummarizeStoryJob>[]) => {
    if (!job) return;
    const r = await handleSummarizeJob(job);
    if (r.status === "summarized") log(`summarize ${job.data.storyId}: ${r.itemCount} items, $${r.usd.toFixed(5)}`);
    else if (r.status === "no_summary") log(`summarize ${job.data.storyId}: no summary (${r.reason})`);
    else if (r.reason.includes("cap") || r.reason.startsWith("API error")) log(`summarize ${job.data.storyId}: skipped (${r.reason})`);
  });

  await boss.work(QUEUES.alertsScan, { localConcurrency: 1 }, async () => {
    const r = await handleAlertScanJob();
    if (r.created || r.sent || r.failed) log(`alerts.scan → ${r.created} new alert(s), ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped`);
  });

  await boss.work(QUEUES.prune, { localConcurrency: 1 }, async () => {
    const r = await handlePrune();
    log(`prune → ${r.runs} run(s), ${r.logins} login attempt(s), ${r.heartbeats} heartbeat(s)`);
  });

  // Database settings win over whatever schedules exist (SPEC §7.5).
  await handleSchedulerSync(boss);
  // Cluster anything left unassigned (e.g. items ingested by an older version).
  if (await enqueueClusterIfPending({ boss })) log("queued cluster.items for unassigned items");
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
  const ch = channelStatus();
  log(`alert channels: slack ${ch.slack.configured ? "on" : "off"}, email ${ch.email.configured ? "on" : "off"}`);
  for (const p of PROVIDERS) {
    const st = providerStatus(p);
    log(`${st.label}: ${st.enabled ? `on, monthly cap $${st.capUsd}` : `off (${st.disabledReason})`}`);
  }
  log(
    `heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s; source concurrency ${SOURCE_CONCURRENCY}; NVD spacing ${nvdSpacingMs(Boolean(env.NVD_API_KEY)) / 1000}s (${env.NVD_API_KEY ? "with" : "no"} API key)`,
  );

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
