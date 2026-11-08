import { connection } from "next/server";
import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { channelStatus, createWatchlist, listWatchlists, recentDeliveries, watchlistInputSchema } from "@/ingest/alerts";

/** GET /api/admin/watchlists — watchlists, channel availability and recent alerts. */
export async function GET(req: Request) {
  await connection();
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const [watchlists, deliveries] = await Promise.all([listWatchlists(), recentDeliveries()]);
  return json({ watchlists, channels: channelStatus(), deliveries });
}

/** POST /api/admin/watchlists — create; stories that already match are baselined (no alert). 201. */
export async function POST(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const body = await readJson(req, watchlistInputSchema);
  if (body.error) return body.error;
  const r = await createWatchlist(body.data);
  return json(r, 201);
}
