/**
 * Enrichment CLI (SPEC §7.2 C). Exits non-zero on failure.
 *
 *   pnpm enrich --cve CVE-2026-12345           re-enrich one CVE (NVD + EPSS)
 *   pnpm enrich --stale                        the daily refresh, now
 *   add --inline to run in this process (no worker), --wait to poll a queued job
 *
 * Without an NVD_API_KEY, NVD allows 5 requests per 30s, so an inline --stale
 * run spaces lookups 6.5s apart.
 */
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { getEnv } from "../src/env";
import { nvdSpacingMs } from "../src/ingest/enrich/throttle";
import { isWorkerOnline } from "../src/ingest/scheduler-service";
import { InvalidCveIdError, triggerEnrichCve, triggerEnrichRefresh, type JobTriggerResult } from "../src/ingest/trigger-jobs";
import { cliUser, printTable, runCli } from "./lib/cli";
import { waitForJobRun } from "./lib/wait";

const USAGE = "usage: pnpm enrich (--cve <CVE-ID> | --stale) [--inline | --wait]";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cve: { type: "string" },
      stale: { type: "boolean", default: false },
      inline: { type: "boolean", default: false },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help || (!values.cve && !values.stale) || (values.cve && values.stale) || (values.inline && values.wait)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }

  const db = getDb();
  if (!values.inline && !(await isWorkerOnline(db))) {
    console.warn("⚠ Worker looks offline (no heartbeat in 90s). The job will wait in the queue; use --inline to run now.\n");
  }
  if (values.inline && values.stale) {
    const s = nvdSpacingMs(Boolean(getEnv().NVD_API_KEY)) / 1000;
    console.log(`NVD lookups are spaced ${s}s apart (${getEnv().NVD_API_KEY ? "with" : "no"} NVD_API_KEY).`);
  }

  let r: JobTriggerResult;
  try {
    r = values.cve
      ? await triggerEnrichCve({ trigger: "cli", triggeredBy: cliUser(), cveId: values.cve, inline: values.inline })
      : await triggerEnrichRefresh({
          trigger: "cli",
          triggeredBy: cliUser(),
          inline: values.inline,
          onProgress: (m) => console.log(`  ${m}`),
        });
  } catch (err) {
    if (err instanceof InvalidCveIdError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

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
