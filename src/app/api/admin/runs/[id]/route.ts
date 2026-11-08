import { getDb } from "@/db/client";
import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { getRun } from "@/ingest/runs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/admin/runs/:id — run + per-source rows */
export async function GET(req: Request, ctx: RouteContext<"/api/admin/runs/[id]">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json({ error: "Not found" }, 404);
  const run = await getRun(getDb(), id);
  return run ? json(run) : json({ error: "Not found" }, 404);
}
