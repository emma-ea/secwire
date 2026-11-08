import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { ingestRequestSchema } from "@/ingest/sources-service";
import { triggerIngestion, UnknownSourcesError } from "@/ingest/trigger";

/** POST /api/admin/ingest — SPEC §7.3 */
export async function POST(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const body = await readJson(req, ingestRequestSchema);
  if (body.error) return body.error;

  try {
    const r = await triggerIngestion({
      trigger: "admin",
      triggeredBy: "admin",
      sourceIds: body.data.sourceIds,
      force: body.data.force,
      includeDisabled: body.data.includeDisabled,
    });
    return json({ runId: r.runId, sources: r.sources.map((s) => ({ sourceId: s.sourceId, status: s.status })) }, 202);
  } catch (err) {
    if (err instanceof UnknownSourcesError) {
      return json({ error: err.message, unknownIds: err.unknownIds }, 400);
    }
    throw err;
  }
}
