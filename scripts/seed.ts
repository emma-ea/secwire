/**
 * Seeds the SPEC §9 sources. Each URL is verified (fetch + parse once): working
 * sources are inserted enabled, failing ones disabled with last_error set.
 * Existing sources are left untouched, so admin edits survive a re-seed.
 *
 *   pnpm db:seed
 */
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { sources } from "../src/db/schema";
import { HN_DEFAULT_MIN_POINTS, HN_DEFAULT_QUERIES } from "../src/ingest/adapters/hackernews";
import { testSource } from "../src/ingest/test-source";
import { printTable, runCli } from "./lib/cli";

type Seed = typeof sources.$inferInsert;

export const SEED_SOURCES: Seed[] = [
  { id: "cisa-kev", name: "CISA KEV", type: "cisa_kev", category: "advisory", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", minIntervalMinutes: 60 },
  { id: "cisa-advisories", name: "CISA Advisories", type: "rss", category: "advisory", url: "https://www.cisa.gov/cybersecurity-advisories/cybersecurity-advisories.xml" },
  { id: "bleepingcomputer", name: "BleepingComputer", type: "rss", category: "news", url: "https://www.bleepingcomputer.com/feed/" },
  { id: "thehackernews", name: "The Hacker News", type: "rss", category: "news", url: "https://feeds.feedburner.com/TheHackersNews" },
  { id: "krebsonsecurity", name: "Krebs on Security", type: "rss", category: "news", url: "https://krebsonsecurity.com/feed/" },
  { id: "securityweek", name: "SecurityWeek", type: "rss", category: "news", url: "https://www.securityweek.com/feed/" },
  { id: "therecord", name: "The Record", type: "rss", category: "news", url: "https://therecord.media/feed" },
  { id: "darkreading", name: "Dark Reading", type: "rss", category: "news", url: "https://www.darkreading.com/rss.xml" },
  { id: "schneier", name: "Schneier on Security", type: "rss", category: "research", url: "https://www.schneier.com/feed/atom/" },
  { id: "talos", name: "Cisco Talos", type: "rss", category: "research", url: "https://blog.talosintelligence.com/rss/" },
  { id: "unit42", name: "Unit 42", type: "rss", category: "research", url: "https://unit42.paloaltonetworks.com/feed/" },
  { id: "msrc", name: "Microsoft MSRC", type: "rss", category: "advisory", url: "https://msrc.microsoft.com/blog/feed" },
  {
    id: "hackernews",
    name: "Hacker News",
    type: "hackernews",
    category: "community",
    url: "https://hn.algolia.com/api/v1/search_by_date",
    config: { queries: HN_DEFAULT_QUERIES, minPoints: HN_DEFAULT_MIN_POINTS },
  },
];

// SPEC §9 lists cisa-advisories as .../all.xml, but that feed embeds full
// advisory HTML and is ~5.7 MB decompressed, over safe-fetch's 5 MB cap.
// cybersecurity-advisories.xml (~1.4 MB) is the closest feed that fits.
// See DECISIONS.md.

const CONCURRENCY = 4;

async function main(): Promise<number> {
  const db = getDb();
  const existing = new Set(
    (await db.select({ id: sources.id }).from(sources).where(inArray(sources.id, SEED_SOURCES.map((s) => s.id)))).map(
      (r) => r.id,
    ),
  );
  const todo = SEED_SOURCES.filter((s) => !existing.has(s.id));
  console.log(`Verifying ${todo.length} source(s) (${existing.size} already present, left unchanged)…\n`);

  const report: Array<Record<string, unknown>> = [];
  for (const s of SEED_SOURCES.filter((s) => existing.has(s.id))) {
    report.push({ id: s.id, result: "exists", http: "", items: "", ms: "", error: "" });
  }

  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const r = await testSource({ type: s.type, url: s.url, config: s.config ?? {} });
        await db
          .insert(sources)
          .values({ ...s, enabled: r.ok, lastError: r.ok ? null : r.error })
          .onConflictDoNothing();
        report.push({
          id: s.id,
          result: r.ok ? "ok → enabled" : "FAILED → disabled",
          http: r.httpStatus ?? "",
          items: r.ok ? r.items.length : "",
          ms: r.durationMs,
          error: r.error ?? "",
        });
      }
    }),
  );

  const order = new Map(SEED_SOURCES.map((s, i) => [s.id, i]));
  report.sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);
  printTable(report, 70);
  const failed = report.filter((r) => String(r.result).startsWith("FAILED")).length;
  console.log(`\n${todo.length - failed} enabled, ${failed} disabled, ${existing.size} unchanged.`);
  return 0;
}

runCli(main);
