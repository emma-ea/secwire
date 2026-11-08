import { guardAdminApi } from "@/lib/auth";
import { json } from "@/lib/http";
import { getDashboardStatus } from "@/ingest/dashboard";

/** GET /api/admin/status — dashboard polling (runs, sources, worker, queues). */
export async function GET(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  return json(await getDashboardStatus());
}
