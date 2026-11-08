import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/client";
import { cves, itemCves, items } from "@/db/schema";
import { clusterItems } from "@/ingest/cluster";
import { parseFeedParams, type FeedFilters } from "@/feed/params";
import { getCve, getFilterOptions, getStory, listStories } from "@/feed/queries";
import { hashCanonicalUrl } from "@/lib/url";
import { addSource, resetDb } from "./helpers";

afterAll(() => closeDb());

const NOW = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let n = 0;
async function item(source: string, h: number, title: string, opts: { cves?: string[]; excerpt?: string } = {}) {
  n++;
  const url = `https://news.example.com/${n}`;
  const [row] = await getDb()
    .insert(items)
    .values({ sourceId: source, externalId: `e${n}`, url, canonicalUrlHash: hashCanonicalUrl(url), title, excerpt: opts.excerpt ?? null, publishedAt: hoursAgo(h), fetchedAt: hoursAgo(h) })
    .returning({ id: items.id });
  for (const c of opts.cves ?? []) await getDb().insert(itemCves).values({ itemId: row!.id, cveId: c });
  return row!.id;
}

const f = (p: Record<string, string> = {}): FeedFilters => parseFeedParams(p);
const titles = async (filters: FeedFilters, limit?: number) =>
  (await listStories(filters, { now: NOW, limit })).stories.map((s) => s.title);

beforeAll(async () => {
  await resetDb();
  await addSource({ id: "bc", name: "BleepingComputer", category: "news" });
  await addSource({ id: "talos", name: "Talos", category: "research" });
  await addSource({ id: "hn", name: "Hacker News", type: "hackernews", category: "community" });

  await getDb().insert(cves).values([
    { id: "CVE-2026-0001", cvssScore: 9.8, inKev: true, kevVendor: "Microsoft", kevProduct: "Exchange Server", kevRansomware: "Known", epssScore: 0.9, epssPercentile: 0.99 },
    { id: "CVE-2026-0002", cvssScore: 7.5, nvdVendor: "Fortinet", nvdProduct: "FortiOS", epssScore: 0.2, epssPercentile: 0.9 },
    { id: "CVE-2026-0003", cvssScore: 5.0, nvdVendor: "Apache Software Foundation", epssScore: 0.01, epssPercentile: 0.5 },
    { id: "CVE-2026-0004" },
  ]);
  // Exchange story: 3 items (2 sources), KEV, ransomware.
  await item("bc", 30, "Microsoft Exchange zero-day exploited", { cves: ["CVE-2026-0001"] });
  await item("talos", 20, "Talos: Exchange exploitation chain", { cves: ["CVE-2026-0001"] });
  await item("bc", 2, "Exchange patch update", { cves: ["CVE-2026-0001"] });
  // FortiOS: 2 items, high.
  await item("hn", 10, "FortiOS SSL-VPN flaw", { cves: ["CVE-2026-0002"] });
  await item("bc", 5, "Fortinet warns of FortiOS bug", { cves: ["CVE-2026-0002"] });
  // Apache: 1 item, medium, research.
  await item("talos", 3, "Apache Struts deserialization", { cves: ["CVE-2026-0003"] });
  // Unscored CVE, community.
  await item("hn", 1, "Mystery router bug", { cves: ["CVE-2026-0004"] });
  // No CVE, older than 7 days.
  await item("bc", 24 * 10, "Old ransomware gang arrest", { excerpt: "Police arrested members of a ransomware gang." });
  // No CVE, 26 hours old.
  await item("bc", 26, "Credential phishing kit sold on forums", { excerpt: "A phishing-as-a-service operation." });
  await clusterItems({ windowDays: 14 });
});

describe("story feed (SPEC §8)", () => {
  it("default: last 7 days, latest activity first", async () => {
    expect(await titles(f())).toEqual([
      "Mystery router bug",
      "Microsoft Exchange zero-day exploited",
      "Apache Struts deserialization",
      "Fortinet warns of FortiOS bug",
      "Credential phishing kit sold on forums",
    ]);
  });

  it("time ranges", async () => {
    expect(await titles(f({ range: "24h" }))).toHaveLength(4);
    expect(await titles(f({ range: "30d" }))).toContain("Old ransomware gang arrest");
  });

  it("KEV only, min CVSS", async () => {
    expect(await titles(f({ kev: "1" }))).toEqual(["Microsoft Exchange zero-day exploited"]);
    expect(await titles(f({ minCvss: "7" }))).toEqual(["Microsoft Exchange zero-day exploited", "Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ minCvss: "9" }))).toEqual(["Microsoft Exchange zero-day exploited"]);
  });

  it("source category and specific source", async () => {
    expect(await titles(f({ category: "research" }))).toEqual(["Microsoft Exchange zero-day exploited", "Apache Struts deserialization"]);
    expect(await titles(f({ source: "hn" }))).toEqual(["Mystery router bug", "Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ source: "nope" }))).toEqual([]);
  });

  it("vendor (KEV, else NVD; case-insensitive substring)", async () => {
    expect(await titles(f({ vendor: "microsoft" }))).toEqual(["Microsoft Exchange zero-day exploited"]);
    expect(await titles(f({ vendor: "Fortinet" }))).toEqual(["Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ vendor: "apache" }))).toEqual(["Apache Struts deserialization"]);
    expect(await titles(f({ vendor: "100%_" }))).toEqual([]);
  });

  it("full-text search across every item in the story, and CVE-id lookup", async () => {
    // "patch" only appears in the Exchange story's third item.
    expect(await titles(f({ q: "patch" }))).toEqual(["Microsoft Exchange zero-day exploited"]);
    expect(await titles(f({ q: "phishing" }))).toEqual(["Credential phishing kit sold on forums"]);
    expect(await titles(f({ q: "ransomware", range: "30d" }))).toEqual(["Old ransomware gang arrest"]);
    expect(await titles(f({ q: "fortinet OR struts" }))).toEqual(["Apache Struts deserialization", "Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ q: "cve-2026-0002" }))).toEqual(["Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ q: "the" }))).toEqual([]); // stop words only
  });

  it("sorts: most covered, highest risk (KEV, then EPSS, then CVSS)", async () => {
    expect((await titles(f({ sort: "covered" }))).slice(0, 2)).toEqual(["Microsoft Exchange zero-day exploited", "Fortinet warns of FortiOS bug"]);
    expect(await titles(f({ sort: "risk" }))).toEqual([
      "Microsoft Exchange zero-day exploited",
      "Fortinet warns of FortiOS bug",
      "Apache Struts deserialization",
      "Mystery router bug",
      "Credential phishing kit sold on forums",
    ]);
  });

  it.each(["recent", "covered", "risk"])("cursor pagination (%s) visits every story exactly once", async (sort) => {
    const all = await titles(f({ sort, range: "30d" }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await listStories(f({ sort, range: "30d", ...(cursor ? { cursor } : {}) }), { now: NOW, limit: 2 });
      seen.push(...r.stories.map((s) => s.title));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(6);
  });

  it("a cursor from another sort or a tampered cursor is ignored (first page)", async () => {
    const r = await listStories(f({ sort: "recent" }), { now: NOW, limit: 2 });
    expect(await titles(f({ sort: "risk", cursor: r.nextCursor! }), 2)).toEqual(await titles(f({ sort: "risk" }), 2));
    expect(await titles(f({ cursor: "garbage" }), 2)).toEqual(await titles(f(), 2));
  });

  it("titles follow §6.5: the HN post came first, but the news article names the story", async () => {
    expect(await titles(f({ source: "hn" }))).toContain("Fortinet warns of FortiOS bug");
    expect(await titles(f())).not.toContain("FortiOS SSL-VPN flaw");
  });

  it("rows carry badges and vendor/product", async () => {
    const [ex] = (await listStories(f({ kev: "1" }), { now: NOW })).stories;
    expect(ex).toMatchObject({
      item_count: 3,
      has_kev: true,
      has_ransomware: true,
      max_cvss: 9.8,
      max_epss_percentile: 0.99,
      cve_ids: ["CVE-2026-0001"],
      source_ids: ["bc", "talos"],
      vendor_products: ["Microsoft Exchange Server"],
    });
  });

  it("filter options list sources and recent vendors", async () => {
    const o = await getFilterOptions();
    expect(o.sources.map((s) => s.id)).toEqual(["bc", "hn", "talos"]);
    expect(o.vendors).toEqual(["Apache Software Foundation", "Fortinet", "Microsoft"]);
  });
});

describe("story and CVE pages", () => {
  it("story: CVEs with enrichment and items in chronological order", async () => {
    const [ex] = (await listStories(f({ kev: "1" }), { now: NOW })).stories;
    const s = (await getStory(ex!.id))!;
    expect(s.cves.map((c) => [c.id, c.cvss_score, c.in_kev])).toEqual([["CVE-2026-0001", 9.8, true]]);
    expect(s.items.map((i) => i.title)).toEqual([
      "Microsoft Exchange zero-day exploited",
      "Talos: Exchange exploitation chain",
      "Exchange patch update",
    ]);
    expect(s.items[1]).toMatchObject({ source_name: "Talos", category: "research" });
    expect(await getStory("not-a-uuid")).toBeNull();
    expect(await getStory("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("CVE: details plus every story mentioning it; ids are normalized", async () => {
    const c = (await getCve("cve-2026-0002"))!;
    expect(c.cve).toMatchObject({ id: "CVE-2026-0002", cvss_score: 7.5, nvd_vendor: "Fortinet" });
    expect(c.stories.map((s) => s.title)).toEqual(["Fortinet warns of FortiOS bug"]);
    expect(c.itemCount).toBe(2);
    expect(await getCve("CVE-2026-9999")).toBeNull();
    expect(await getCve("nonsense")).toBeNull();
  });
});
