import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { sourcePatchSchema, updateSource } from "@/ingest/sources-service";

/** PATCH /api/admin/sources/:id — { enabled?, minIntervalMinutes? | null } */
export async function PATCH(req: Request, ctx: RouteContext<"/api/admin/sources/[id]">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson(req, sourcePatchSchema);
  if (body.error) return body.error;

  const row = await updateSource(id, body.data);
  if (!row) return json({ error: `Unknown source ${id}` }, 404);
  return json(row);
}
