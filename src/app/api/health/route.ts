import { connection } from "next/server";
import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { getSenderBoss } from "@/ingest/boss";
import { buildHealth, readHealthSnapshot, type HealthSnapshot } from "@/lib/health";

async function queueDepths(): Promise<Record<string, number> | null> {
  try {
    const boss = await getSenderBoss();
    const queues = await boss.getQueues();
    return Object.fromEntries(
      queues.filter((q) => !q.name.startsWith("__")).map((q) => [q.name, q.queuedCount + q.activeCount]),
    );
  } catch (err) {
    console.error("[health] queue depth check failed:", err);
    return null;
  }
}

export async function GET() {
  await connection();

  let snapshot: HealthSnapshot | Error;
  try {
    const [base, queues] = await Promise.all([readHealthSnapshot(getDb()), queueDepths()]);
    snapshot = { ...base, queues, managedExternally: !getEnv().WORKER_SCHEDULES_ENABLED };
  } catch (err) {
    // Log details server-side only; the public response just says "error".
    console.error("[health] database check failed:", err);
    snapshot = err instanceof Error ? err : new Error(String(err));
  }

  const { status, body } = buildHealth(snapshot);
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
