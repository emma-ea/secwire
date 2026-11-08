import { getDb } from "@/db/client";
import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { listRuns } from "@/ingest/runs";

/** GET /api/admin/runs?limit= */
export async function GET(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  return json({ runs: await listRuns(getDb(), Number.isFinite(limit) ? limit : 20) });
}
