import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { InvalidCveIdError, triggerEnrichCve } from "@/ingest/trigger-jobs";

/**
 * POST /api/admin/cves/:id/enrich — SPEC §7.3. Queues NVD + EPSS for one CVE.
 * 202 { runId, status } (status "coalesced" when a job for it was already queued).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/cves/[id]/enrich">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const r = await triggerEnrichCve({ trigger: "admin", triggeredBy: "admin", cveId: id });
    return json({ runId: r.runId, status: r.status }, 202);
  } catch (err) {
    if (err instanceof InvalidCveIdError) return json({ error: err.message }, 400);
    throw err;
  }
}
