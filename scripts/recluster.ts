/**
 * Recluster CLI (SPEC §6.5, §7.2 C): unassigns items whose activity time is on
 * or after --since, deletes stories left empty, and clusters again.
 *
 *   pnpm recluster --since 2026-10-01            enqueue (queues behind any active clustering)
 *   pnpm recluster --since 2026-10-01 --inline   run now in this process
 *   pnpm recluster --since 2026-10-01 --wait     enqueue, then poll until done
 */
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { isWorkerOnline } from "../src/ingest/scheduler-service";
import { InvalidSinceError, parseSince, triggerRecluster } from "../src/ingest/trigger-jobs";
import { cliUser, printTable, runCli } from "./lib/cli";
import { waitForJobRun } from "./lib/wait";

const USAGE = "usage: pnpm recluster --since YYYY-MM-DD [--inline | --wait]";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      inline: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help || !values.since || (values.inline && values.wait)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  let since: Date;
  try {
    since = parseSince(values.since);
  } catch (err) {
    if (err instanceof InvalidSinceError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const db = getDb();
  if (!values.inline && !(await isWorkerOnline(db))) {
    console.warn("⚠ Worker looks offline (no heartbeat in 90s). The job will wait in the queue; use --inline to run now.\n");
  }
  const r = await triggerRecluster({ trigger: "cli", triggeredBy: cliUser(), since, inline: values.inline });
  console.log(`run ${r.runId}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  if (r.stats) printTable([r.stats]);

  if (values.wait && (r.status === "queued" || r.status === "coalesced")) {
    const run = await waitForJobRun(db, r.runId);
    if (!run) {
      console.error("Timed out waiting for the run.");
      return 1;
    }
    if (Object.keys(run.stats).length) printTable([run.stats]);
    if (run.error) console.log(run.error);
    return run.status === "failed" ? 1 : 0;
  }
  return r.status === "failed" ? 1 : 0;
}

runCli(main);
