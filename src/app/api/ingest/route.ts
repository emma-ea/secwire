import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingestionRuns } from "@/db/schema";
import { getEnv } from "@/env";
import { tokenMatches } from "@/lib/auth";
import { json, readJson } from "@/lib/http";
import { ingestRequestSchema } from "@/ingest/sources-service";
import { triggerIngestion, UnknownSourcesError } from "@/ingest/trigger";

const API_MIN_INTERVAL_SECONDS = 60;

/**
 * POST /api/ingest — external trigger (SPEC §7.2 D) for system cron, CI, or
 * another scheduler when WORKER_SCHEDULES_ENABLED=false.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  if (!tokenMatches(token, getEnv().INGEST_API_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await readJson(req, ingestRequestSchema);
  if (body.error) return body.error;

  const [recent] = await getDb()
    .select({ id: ingestionRuns.id })
    .from(ingestionRuns)
    .where(
      and(
        eq(ingestionRuns.trigger, "api"),
        gt(ingestionRuns.createdAt, sql`now() - make_interval(secs => ${API_MIN_INTERVAL_SECONDS})`),
      ),
    )
    .limit(1);
  if (recent) {
    return Response.json(
      { error: `An API-triggered run was created in the last ${API_MIN_INTERVAL_SECONDS}s`, runId: recent.id },
      { status: 429, headers: { "Retry-After": String(API_MIN_INTERVAL_SECONDS), "Cache-Control": "no-store" } },
    );
  }

  try {
    const r = await triggerIngestion({
      trigger: "api",
      triggeredBy: "api:token",
      sourceIds: body.data.sourceIds,
      force: body.data.force,
      includeDisabled: body.data.includeDisabled,
    });
    return json({ runId: r.runId }, 202);
  } catch (err) {
    if (err instanceof UnknownSourcesError) return json({ error: err.message, unknownIds: err.unknownIds }, 400);
    throw err;
  }
}
