import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { deleteWatchlist, updateWatchlist, watchlistInputSchema } from "@/ingest/alerts";

/** PUT /api/admin/watchlists/:id — replace settings (newly matching stories are baselined). */
export async function PUT(req: Request, ctx: RouteContext<"/api/admin/watchlists/[id]">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson(req, watchlistInputSchema);
  if (body.error) return body.error;
  const r = await updateWatchlist(id, body.data);
  return r ? json(r) : json({ error: "Watchlist not found" }, 404);
}

/** DELETE /api/admin/watchlists/:id — also removes its alert history. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/admin/watchlists/[id]">) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  return (await deleteWatchlist(id)) ? new Response(null, { status: 204 }) : json({ error: "Watchlist not found" }, 404);
}
