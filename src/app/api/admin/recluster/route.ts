import { z } from "zod";
import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { InvalidSinceError, parseSince, triggerRecluster } from "@/ingest/trigger-jobs";

const body = z.object({ since: z.string().min(1).max(40) });

/**
 * POST /api/admin/recluster { since: ISODate } — SPEC §7.3. Queues behind any
 * active clustering (cluster.items is stately). 202 { runId, status }.
 */
export async function POST(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const parsed = await readJson(req, body);
  if (parsed.error) return parsed.error;
  try {
    const since = parseSince(parsed.data.since);
    const r = await triggerRecluster({ trigger: "admin", triggeredBy: "admin", since });
    return json({ runId: r.runId, status: r.status }, 202);
  } catch (err) {
    if (err instanceof InvalidSinceError) return json({ error: err.message }, 400);
    throw err;
  }
}
