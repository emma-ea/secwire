import { connection } from "next/server";
import { getDb } from "@/db/client";
import { buildHealth, readHealthSnapshot, type HealthSnapshot } from "@/lib/health";

export async function GET() {
  // Always evaluate at request time (Cache Components would otherwise try to prerender).
  await connection();

  let snapshot: HealthSnapshot | Error;
  try {
    snapshot = await readHealthSnapshot(getDb());
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
