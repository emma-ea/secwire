import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { cancelRun } from "@/ingest/cancel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin/runs/:id/cancel — queued jobs are cancelled; running jobs finish. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/runs/[id]/cancel">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json({ error: "Not found" }, 404);
  const r = await cancelRun(id);
  return r ? json(r) : json({ error: "Not found" }, 404);
}
