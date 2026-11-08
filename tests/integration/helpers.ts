import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { getDb } from "@/db/client";
import { sources } from "@/db/schema";
import { QUEUES } from "@/ingest/boss";
import { fakeFetcher, fixture } from "../helpers/fake-fetch";

export { fakeFetcher, fixture };

/** Wipes app tables and pg-boss jobs/schedules. Keeps the app_settings row (reset to defaults). */
export async function resetDb(boss?: PgBoss) {
  const db = getDb();
  await db.execute(sql`TRUNCATE items, item_cves, story_cves, stories, cves, ingestion_run_sources, ingestion_runs, sources, login_attempts, worker_heartbeats CASCADE`);
  await db.execute(sql`UPDATE app_settings SET scheduler_enabled = true, scheduler_interval_minutes = 15, enrich_refresh_enabled = true, last_tick_at = NULL`);
  if (boss) {
    for (const q of Object.values(QUEUES)) await boss.deleteAllJobs(q);
    await db.execute(sql`DELETE FROM pgboss.schedule`);
  }
}

/** A full pg-boss instance against the test DB with no workers registered, so jobs stay queued. */
export async function startTestBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false });
  boss.on("error", () => {});
  await boss.start();
  return boss;
}

export async function addSource(overrides: Partial<typeof sources.$inferInsert> & { id: string }) {
  const [row] = await getDb()
    .insert(sources)
    .values({
      name: overrides.id,
      type: "rss",
      category: "news",
      url: `https://feeds.example.com/${overrides.id}.xml`,
      ...overrides,
    })
    .returning();
  return row!;
}

export async function count(table: string): Promise<number> {
  const r = await getDb().execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return r.rows[0]!.n;
}

/** RSS fixture with a single item whose title can be changed between runs. */
export function rssWith(items: Array<{ guid: string; title: string; link?: string; description?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>https://x.test/</link>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link ?? `https://news.example.com/${i.guid}`}</link><guid>${i.guid}</guid><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><description>${i.description ?? ""}</description></item>`,
    )
    .join("")}</channel></rss>`;
}
