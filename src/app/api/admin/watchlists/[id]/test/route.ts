import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { sendTestAlert } from "@/ingest/alerts";

/** POST /api/admin/watchlists/:id/test — send a test alert to the watchlist's configured channels. */
export async function POST(req: Request, ctx: RouteContext<"/api/admin/watchlists/[id]/test">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const r = await sendTestAlert(id);
  return r ? json(r) : json({ error: "Watchlist not found" }, 404);
}
