import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { getSource } from "@/ingest/sources-service";
import { testSource } from "@/ingest/test-source";

/** POST /api/admin/sources/:id/test — dry run, no writes (SPEC §7.2 B). */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/sources/[id]/test">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const source = await getSource(id);
  if (!source) return json({ error: `Unknown source ${id}` }, 404);

  const r = await testSource(source);
  return json({ ok: r.ok, items: r.items, httpStatus: r.httpStatus, durationMs: r.durationMs, error: r.error });
}
