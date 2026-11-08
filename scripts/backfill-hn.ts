/**
 * Hacker News backfill (SPEC §7.2 C). Runs inline (no worker needed) under the
 * same advisory lock as normal ingestion. RSS cannot be backfilled.
 *
 *   pnpm backfill:hn --since 2026-10-01 [--until 2026-10-15] [--source hackernews]
 */
import { parseArgs } from "node:util";
import { getDb } from "../src/db/client";
import { getRun } from "../src/ingest/runs";
import { BackfillNotSupportedError, triggerIngestion, UnknownSourcesError } from "../src/ingest/trigger";
import { cliUser, printTable, runCli } from "./lib/cli";

const USAGE = "usage: pnpm backfill:hn --since YYYY-MM-DD [--until YYYY-MM-DD] [--source <id>]";

function parseDay(s: string | undefined, name: string): Date | undefined {
  if (s === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`--${name} must be YYYY-MM-DD`);
  }
  return new Date(`${s}T00:00:00Z`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      since: { type: "string" },
      until: { type: "string" },
      source: { type: "string", multiple: true, default: ["hackernews"] },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help || !values.since) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }
  const since = parseDay(values.since, "since")!;
  const until = parseDay(values.until, "until");
  if (until && until <= since) {
    console.error("--until must be after --since");
    return 2;
  }

  try {
    const r = await triggerIngestion({
      trigger: "cli",
      triggeredBy: cliUser(),
      kind: "backfill",
      sourceIds: values.source,
      inline: true,
      force: true,
      includeDisabled: true,
      range: { since, until },
    });
    const run = await getRun(getDb(), r.runId!);
    printTable(
      (run?.sources ?? []).map((s) => ({ source: s.sourceId, status: s.status, seen: s.itemsSeen, new: s.itemsNew, updated: s.itemsUpdated, error: s.error ?? "" })),
    );
    console.log(`\nrun ${r.runId}: ${run?.status}`);
    return run?.sources.some((s) => s.status === "failed") ? 1 : 0;
  } catch (err) {
    if (err instanceof BackfillNotSupportedError || err instanceof UnknownSourcesError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

runCli(main);
