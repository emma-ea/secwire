import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { ingestionRuns } from "../../src/db/schema";
import { sleep } from "./cli";

/** Polls a job run (enrich/recluster) until it finishes; returns the final row, or null on timeout. */
export async function waitForJobRun(db: Db, runId: string, maxMs = 30 * 60_000, pollMs = 2_000) {
  const deadline = Date.now() + maxMs;
  let last = "";
  for (;;) {
    const [run] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    if (!run) return null;
    if (run.status !== last) {
      console.log(`  run ${runId}: ${run.status}`);
      last = run.status;
    }
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > deadline) return null;
    await sleep(pollMs);
  }
}
