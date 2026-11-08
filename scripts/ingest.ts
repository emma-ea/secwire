/**
 * Ingestion CLI (SPEC §7.2 C). Exits non-zero if any source failed.
 *
 *   pnpm ingest --all                       enqueue all enabled sources
 *   pnpm ingest --source bleepingcomputer   one source (repeatable)
 *   pnpm ingest --source x --force          skip ETag/If-Modified-Since and cooldown
 *   pnpm ingest --all --wait                enqueue, then poll until done
 *   pnpm ingest --source x --inline         run in-process (no worker needed)
 *   pnpm ingest --source x --dry-run        fetch + parse + print, no DB writes
 *   pnpm ingest --source x --include-disabled
 */
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { getRun } from "../src/ingest/runs";
import { isWorkerOnline } from "../src/ingest/scheduler-service";
import { triggerIngestion, UnknownSourcesError } from "../src/ingest/trigger";
import { cliUser, printTable, runCli, sleep } from "./lib/cli";

const WAIT_POLL_MS = 2_000;
const WAIT_MAX_MS = 15 * 60_000;

const USAGE = `usage: pnpm ingest (--all | --source <id> [--source <id> …]) [--force] [--wait | --inline | --dry-run] [--include-disabled]`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean", default: false },
      source: { type: "string", multiple: true, default: [] },
      force: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      inline: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "include-disabled": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help || (!values.all && !values.source.length) || (values.all && values.source.length)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  if ([values.wait, values.inline, values["dry-run"]].filter(Boolean).length > 1) {
    console.error("--wait, --inline and --dry-run are mutually exclusive\n" + USAGE);
    return 2;
  }

  const db = getDb();
  const sourceIds = values.all ? ("all" as const) : values.source;
  const dryRun = values["dry-run"];

  if (!values.inline && !dryRun && !(await isWorkerOnline(db))) {
    console.warn("⚠ Worker looks offline (no heartbeat in 90s). Jobs will wait in the queue until `pnpm dev:worker` runs; use --inline to run now.\n");
  }

  let result;
  try {
    result = await triggerIngestion({
      trigger: "cli",
      triggeredBy: cliUser(),
      sourceIds,
      force: values.force,
      includeDisabled: values["include-disabled"],
      inline: values.inline,
      dryRun,
    });
  } catch (err) {
    if (err instanceof UnknownSourcesError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (dryRun) {
    let failed = false;
    for (const s of result.sources) {
      console.log(`\n== ${s.sourceId}${s.error ? ` — FAILED: ${s.error}` : ` — ${s.preview?.length ?? 0} item(s)`}`);
      if (s.error) failed = true;
      printTable(
        (s.preview ?? []).map((i) => ({
          published: i.publishedAt,
          title: i.title,
          cves: i.cveIds.join(" "),
        })),
        70,
      );
    }
    return failed ? 1 : 0;
  }

  console.log(`run ${result.runId}`);
  printTable(result.sources.map((s) => ({ source: s.sourceId, status: s.status, job: s.jobId ?? s.coalescedIntoJobId ?? "", error: s.error ?? "" })));

  if (values.wait && result.runId) {
    process.stdout.write("\nwaiting");
    const deadline = Date.now() + WAIT_MAX_MS;
    let run = await getRun(db, result.runId);
    while (run && ["queued", "running"].includes(run.status) && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      process.stdout.write(".");
      run = await getRun(db, result.runId);
    }
    process.stdout.write("\n\n");
    if (!run || ["queued", "running"].includes(run.status)) {
      console.error(`timed out after ${WAIT_MAX_MS / 60_000} min; run is still ${run?.status}`);
      return 1;
    }
  }

  const run = result.runId ? await getRun(db, result.runId) : null;
  if (run && (values.wait || values.inline)) {
    printTable(
      run.sources.map((s) => ({
        source: s.sourceId,
        status: s.status,
        http: s.httpStatus ?? "",
        seen: s.itemsSeen,
        new: s.itemsNew,
        updated: s.itemsUpdated,
        ms: s.durationMs ?? "",
        error: s.error ?? "",
      })),
    );
    console.log(`\nrun ${run.id}: ${run.status}`);
  }
  const anyFailed = (run?.sources ?? result.sources).some((s) => s.status === "failed");
  return anyFailed ? 1 : 0;
}

runCli(main);
