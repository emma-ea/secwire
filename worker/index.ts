/**
 * SecWire worker process (SPEC §2, §7.1). Phase 0: connects pg-boss (which
 * creates/migrates its schema) and writes a heartbeat every 30s.
 * Phase 1 registers queues, workers and schedules here.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../src/db/client";
import { getEnv } from "../src/env";
import { createWorkerBoss } from "../src/ingest/boss";
import {
  HEARTBEAT_INTERVAL_MS,
  pruneHeartbeats,
  writeHeartbeat,
  type WorkerIdentity,
} from "../src/lib/heartbeat";

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  getEnv(); // fail fast on bad config
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
  console.log(`[worker] pg-boss started (worker ${identity.workerId}, v${identity.version})`);

  const pruned = await pruneHeartbeats(db);
  if (pruned > 0) console.log(`[worker] pruned ${pruned} stale heartbeat row(s)`);

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
  console.log(`[worker] heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

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
    console.log(`[worker] ${signal} received, shutting down`);
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
