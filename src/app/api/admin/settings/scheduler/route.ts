import { z } from "zod";
import { guardAdminApi } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { getSchedulerState, SettingsValidationError, updateSchedulerSettings } from "@/ingest/scheduler-service";

/** GET /api/admin/settings/scheduler — SPEC §7.3 */
export async function GET(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  return json(await getSchedulerState());
}

const putSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().optional(),
    enrichRefreshEnabled: z.boolean().optional(),
    cancelQueuedScheduled: z.boolean().optional(),
  })
  .strict();

/** PUT /api/admin/settings/scheduler — saves, sends scheduler.sync, returns the GET shape. 400 for a non-preset interval. */
export async function PUT(req: Request) {
  const denied = await guardAdminApi(req);
  if (denied) return denied;
  const body = await readJson(req, putSchema);
  if (body.error) return body.error;
  try {
    const r = await updateSchedulerSettings(body.data, "admin");
    return json({ ...r.state, syncQueued: r.syncQueued, workerOnline: r.workerOnline, cancelledJobs: r.cancelledJobs });
  } catch (err) {
    if (err instanceof SettingsValidationError) return json({ error: err.message }, 400);
    throw err;
  }
}
