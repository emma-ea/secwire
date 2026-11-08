import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { cves, itemCves, items } from "@/db/schema";
import { clusterItems, recluster } from "@/ingest/cluster";
import { hashCanonicalUrl } from "@/lib/url";
import { addSource, count, resetDb } from "./helpers";

afterAll(() => closeDb());

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T12:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

let seq = 0;
async function item(opts: {
  source: string;
  day: number;
  title?: string;
  url?: string;
  cves?: string[];
}): Promise<string> {
  seq++;
  const url = opts.url ?? `https://news.example.com/${opts.source}/${seq}`;
  const [row] = await getDb()
    .insert(items)
    .values({
      sourceId: opts.source,
      externalId: `ext-${seq}`,
      url,
      canonicalUrlHash: hashCanonicalUrl(url),
      title: opts.title ?? `${opts.source} item ${seq}`,
      publishedAt: at(opts.day),
      fetchedAt: at(opts.day + 0.01),
    })
    .returning({ id: items.id });
  for (const c of opts.cves ?? []) {
    await getDb().insert(cves).values({ id: c }).onConflictDoNothing();
    await getDb().insert(itemCves).values({ itemId: row!.id, cveId: c });
  }
  return row!.id;
}

async function storyOf(itemId: string): Promise<string | null> {
  const r = await getDb().execute<{ story_id: string | null }>(sql`SELECT story_id FROM items WHERE id = ${itemId}`);
  return r.rows[0]!.story_id;
}

type StoryRow = {
  id: string;
  title: string;
  item_count: number;
  first_seen_at: string;
  last_activity_at: string;
  max_cvss: number | null;
  has_kev: boolean;
  max_epss: string | null;
  max_epss_percentile: string | null;
  has_ransomware: boolean;
  cve_ids: string[];
  vendors: string[];
  source_ids: string[];
};

async function story(id: string): Promise<StoryRow> {
  const r = await getDb().execute<StoryRow>(sql`SELECT * FROM stories WHERE id = ${id}`);
  return r.rows[0]!;
}

/** Story contents as sorted lists of item ids — comparable across runs (story ids change). */
async function groupings(): Promise<string[][]> {
  const r = await getDb().execute<{ ids: string[] }>(
    sql`SELECT array_agg(id::text ORDER BY id) AS ids FROM items WHERE story_id IS NOT NULL GROUP BY story_id`,
  );
  return r.rows.map((x) => x.ids).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

async function storySnapshot() {
  const r = await getDb().execute(
    sql`SELECT title, item_count, first_seen_at, last_activity_at, max_cvss, has_kev, max_epss, cve_ids, vendors, source_ids,
               (SELECT array_agg(cve_id ORDER BY cve_id) FROM story_cves sc WHERE sc.story_id = s.id) AS story_cves,
               (SELECT array_agg(id::text ORDER BY id) FROM items i WHERE i.story_id = s.id) AS item_ids
          FROM stories s ORDER BY (SELECT min(id::text) FROM items i WHERE i.story_id = s.id)`,
  );
  return r.rows;
}

beforeEach(async () => {
  await resetDb();
  await addSource({ id: "bc", category: "news" });
  await addSource({ id: "thn", category: "news" });
  await addSource({ id: "talos", category: "research" });
  await addSource({ id: "hn", type: "hackernews", category: "community" });
  await addSource({ id: "kev", type: "cisa_kev", category: "advisory" });
});

describe("clustering (SPEC §6.5)", () => {
  it("rule 3: an item with no match starts its own story", async () => {
    const a = await item({ source: "bc", day: 0, title: "Unrelated breach" });
    const b = await item({ source: "thn", day: 0, title: "Another thing" });
    const stats = await clusterItems({ windowDays: 14 });
    expect(stats).toMatchObject({ processed: 2, created: 2, joinedByUrl: 0, joinedByCve: 0 });
    expect(await storyOf(a)).not.toBe(await storyOf(b));
    const s = await story((await storyOf(a))!);
    expect(s).toMatchObject({ title: "Unrelated breach", item_count: 1, cve_ids: [], source_ids: ["bc"] });
  });

  it("rule 1: an HN post linking to an article joins the article's story, whatever its CVEs", async () => {
    const article = await item({ source: "bc", day: 0, url: "https://www.bleepingcomputer.com/news/x/", cves: ["CVE-2026-1000"] });
    await clusterItems({ windowDays: 14 });
    // Different tracking params and trailing slash: same canonical URL. 30 days later: URL rule has no window.
    const hn = await item({
      source: "hn",
      day: 30,
      url: "https://WWW.bleepingcomputer.com/news/x?utm_source=hn",
      cves: ["CVE-2026-2000"],
    });
    const stats = await clusterItems({ windowDays: 14 });
    expect(stats).toMatchObject({ processed: 1, joinedByUrl: 1, created: 0 });
    expect(await storyOf(hn)).toBe(await storyOf(article));
    const s = await story((await storyOf(article))!);
    expect(s.item_count).toBe(2);
    expect(s.cve_ids).toEqual(["CVE-2026-1000", "CVE-2026-2000"]);
    expect(s.source_ids).toEqual(["bc", "hn"]);
  });

  it("rule 1 applies within one batch too", async () => {
    const a = await item({ source: "bc", day: 0, url: "https://example.org/post" });
    const b = await item({ source: "hn", day: 1, url: "https://example.org/post/" });
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(a)).toBe(await storyOf(b));
  });

  it("rule 2: articles about the same CVE within the window become one story", async () => {
    await getDb().insert(cves).values({
      id: "CVE-2026-3400",
      cvssScore: 9.8,
      inKev: true,
      kevRansomware: "Known",
      kevVendor: "Palo Alto Networks",
      kevName: "PAN-OS Command Injection",
      epssScore: 0.94,
      epssPercentile: 0.999,
    });
    const a = await item({ source: "bc", day: 0, title: "PAN-OS zero-day exploited", cves: ["CVE-2026-3400"] });
    const b = await item({ source: "thn", day: 2, title: "Palo Alto patches CVE-2026-3400", cves: ["CVE-2026-3400"] });
    const c = await item({ source: "talos", day: 5, cves: ["CVE-2026-3400"] });
    const stats = await clusterItems({ windowDays: 14 });
    expect(stats).toMatchObject({ processed: 3, created: 1, joinedByCve: 2 });
    const id = (await storyOf(a))!;
    expect(await storyOf(b)).toBe(id);
    expect(await storyOf(c)).toBe(id);
    const s = await story(id);
    expect(s).toMatchObject({
      title: "PAN-OS zero-day exploited",
      item_count: 3,
      has_kev: true,
      has_ransomware: true,
      cve_ids: ["CVE-2026-3400"],
      vendors: ["Palo Alto Networks"],
      source_ids: ["bc", "talos", "thn"],
    });
    expect(Number(s.max_cvss)).toBe(9.8);
    expect(Number(s.max_epss)).toBeCloseTo(0.94);
    expect(Number(s.max_epss_percentile)).toBeCloseTo(0.999);
    expect(new Date(s.first_seen_at).toISOString()).toBe(at(0).toISOString());
    expect(new Date(s.last_activity_at).toISOString()).toBe(at(5).toISOString());
    expect(await count("story_cves")).toBe(1);
  });

  it("rule 2 respects CLUSTER_WINDOW_DAYS, measured from the item's time", async () => {
    const a = await item({ source: "bc", day: 0, cves: ["CVE-2026-5000"] });
    const b = await item({ source: "thn", day: 14, cves: ["CVE-2026-5000"] }); // exactly at the edge → joins
    const c = await item({ source: "bc", day: 29, cves: ["CVE-2026-5000"] }); // 15 days after b → new story
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(b)).toBe(await storyOf(a));
    expect(await storyOf(c)).not.toBe(await storyOf(a));
  });

  it("rule 2 picks the most recently active story when several share the CVE", async () => {
    const early = await item({ source: "bc", day: 0, cves: ["CVE-2026-6000"] });
    const late = await item({ source: "thn", day: 20, cves: ["CVE-2026-6000"] }); // outside window → its own story
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(late)).not.toBe(await storyOf(early));
    // Day 12 is within the window of both (0 and 20); the day-20 story is more recent.
    const mid = await item({ source: "talos", day: 12, cves: ["CVE-2026-6000"] });
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(mid)).toBe(await storyOf(late));
  });

  it("multi-CVE items join one story (the most recent match) without merging stories", async () => {
    const a = await item({ source: "bc", day: 0, cves: ["CVE-2026-7001"] });
    const b = await item({ source: "thn", day: 3, cves: ["CVE-2026-7002"] });
    await clusterItems({ windowDays: 14 });
    const sa = (await storyOf(a))!;
    const sb = (await storyOf(b))!;
    expect(sa).not.toBe(sb);

    const both = await item({ source: "talos", day: 4, cves: ["CVE-2026-7001", "CVE-2026-7002"] });
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(both)).toBe(sb);
    expect(await count("stories")).toBe(2);
    expect((await story(sb)).cve_ids).toEqual(["CVE-2026-7001", "CVE-2026-7002"]);
    expect((await story(sa)).cve_ids).toEqual(["CVE-2026-7001"]);

    // A later item about 7001 alone now joins the more recently active story B.
    const later = await item({ source: "bc", day: 6, cves: ["CVE-2026-7001"] });
    await clusterItems({ windowDays: 14 });
    expect(await storyOf(later)).toBe(sb);
  });

  it("title: earliest news/advisory item, else the KEV name, else the earliest item", async () => {
    // Community post first, news later → news title.
    const hn = await item({ source: "hn", day: 0, title: "HN: look at this", cves: ["CVE-2026-8001"] });
    await item({ source: "bc", day: 1, title: "BleepingComputer headline", cves: ["CVE-2026-8001"] });
    // Research + community only, CVE in KEV → KEV name.
    await getDb().insert(cves).values({ id: "CVE-2026-8002", inKev: true, kevName: "Acme Router RCE" });
    const r1 = await item({ source: "talos", day: 0, title: "Talos deep dive", cves: ["CVE-2026-8002"] });
    // Research only, no KEV → earliest item.
    const r2 = await item({ source: "talos", day: 0, title: "Earliest research", cves: ["CVE-2026-8003"] });
    await item({ source: "hn", day: 1, title: "Later community", cves: ["CVE-2026-8003"] });
    await clusterItems({ windowDays: 14 });

    expect((await story((await storyOf(hn))!)).title).toBe("BleepingComputer headline");
    expect((await story((await storyOf(r1))!)).title).toBe("Acme Router RCE");
    expect((await story((await storyOf(r2))!)).title).toBe("Earliest research");
  });

  it("is safe to re-run: nothing left to do, nothing changes", async () => {
    await item({ source: "bc", day: 0, cves: ["CVE-2026-9001"] });
    await item({ source: "thn", day: 1, cves: ["CVE-2026-9001"] });
    await clusterItems({ windowDays: 14 });
    const before = await storySnapshot();
    expect(await clusterItems({ windowDays: 14 })).toMatchObject({ processed: 0, created: 0 });
    expect(await storySnapshot()).toEqual(before);
  });

  it("processes large backlogs in batches with the same result", async () => {
    for (let d = 0; d < 7; d++) await item({ source: d % 2 ? "bc" : "thn", day: d, cves: ["CVE-2026-9100"] });
    await item({ source: "bc", day: 3, url: "https://example.org/dup" });
    await item({ source: "hn", day: 4, url: "https://example.org/dup" });
    await clusterItems({ windowDays: 14, batchSize: 2 });
    expect(await count("stories")).toBe(2);
    expect(await count("items WHERE story_id IS NULL")).toBe(0);
  });
});

describe("recluster --since (SPEC §6.5)", () => {
  async function dataset() {
    await getDb().insert(cves).values({ id: "CVE-2026-1111", inKev: true, kevName: "Thing", cvssScore: 7.5 });
    await item({ source: "bc", day: 0, cves: ["CVE-2026-1111"] });
    await item({ source: "thn", day: 3, cves: ["CVE-2026-1111"] });
    await item({ source: "hn", day: 4, url: "https://news.example.com/bc/1" }); // same URL as the first item
    await item({ source: "talos", day: 6, cves: ["CVE-2026-1111", "CVE-2026-2222"] });
    await item({ source: "bc", day: 8, cves: ["CVE-2026-2222"] });
    await item({ source: "kev", day: 9, cves: ["CVE-2026-3333"] });
    await item({ source: "thn", day: 25, cves: ["CVE-2026-1111"] }); // outside window → new story
    await item({ source: "bc", day: 26, title: "No CVE" });
  }

  it("is idempotent: same grouping and story fields every time", async () => {
    seq = 0;
    await dataset();
    await clusterItems({ windowDays: 14 });
    const original = await storySnapshot();
    const originalGroups = await groupings();

    const first = await recluster(at(5), { windowDays: 14 });
    expect(first.released).toBeGreaterThan(0);
    expect(await groupings()).toEqual(originalGroups);
    expect(await storySnapshot()).toEqual(original);

    await recluster(at(5), { windowDays: 14 });
    expect(await groupings()).toEqual(originalGroups);
    expect(await storySnapshot()).toEqual(original);

    // A full recluster from the beginning gives the same result too.
    const all = await recluster(at(-1), { windowDays: 14 });
    expect(all.released).toBe(8);
    expect(await groupings()).toEqual(originalGroups);
    expect(await storySnapshot()).toEqual(original);
  });

  it("deletes stories left empty and leaves no orphans", async () => {
    await dataset();
    await clusterItems({ windowDays: 14 });
    const stories = await count("stories");
    const r = await recluster(at(20), { windowDays: 14 });
    // Items from day 25 and 26 formed two stories; both were emptied, deleted and recreated.
    expect(r).toMatchObject({ released: 2, deletedStories: 2, created: 2 });
    expect(await count("stories")).toBe(stories);
    expect(await count("stories s WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id)")).toBe(0);
  });

  it("recomputes stories that keep older items", async () => {
    const a = await item({ source: "bc", day: 0, cves: ["CVE-2026-4444"] });
    const b = await item({ source: "thn", day: 10, cves: ["CVE-2026-4444"] });
    await clusterItems({ windowDays: 14 });
    // Shrink the window: b now falls outside a's story and must split off.
    await recluster(at(5), { windowDays: 5 });
    const sa = (await storyOf(a))!;
    expect(await storyOf(b)).not.toBe(sa);
    const s = await story(sa);
    expect(s.item_count).toBe(1);
    expect(new Date(s.last_activity_at).toISOString()).toBe(at(0).toISOString());
  });
});
