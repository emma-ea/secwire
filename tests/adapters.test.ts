import { describe, expect, it } from "vitest";
import { cisaKevAdapter, kevEntryUrl, parseKevCatalog } from "@/ingest/adapters/cisa-kev";
import {
  HN_DEFAULT_QUERIES,
  buildSearchUrl,
  hackerNewsAdapter,
  hnConfig,
  hnSince,
  parseHnHits,
} from "@/ingest/adapters/hackernews";
import { parseFeed, rssAdapter } from "@/ingest/adapters/rss";
import { SourceHttpError, SourceParseError } from "@/ingest/adapters/types";
import { fakeFetcher, fixture, makeSource } from "./helpers/fake-fetch";

const NOW = new Date("2026-11-08T12:00:00Z");
const ctx = (extra: Partial<Parameters<typeof rssAdapter.fetch>[1]> = {}) => ({
  force: false,
  signal: new AbortController().signal,
  now: NOW,
  ...extra,
});

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

describe("RSS adapter", () => {
  it("parses a real RSS 2.0 feed (BleepingComputer)", async () => {
    const items = await parseFeed(fixture("rss-bleepingcomputer.xml"), NOW);
    expect(items).toHaveLength(5);
    for (const it of items) {
      expect(it.url).toMatch(/^https:\/\/www\.bleepingcomputer\.com\//);
      expect(it.title.length).toBeGreaterThan(5);
      expect(it.title).not.toMatch(/<[a-z]/i);
      expect(it.excerpt === null || [...it.excerpt].length <= 400).toBe(true);
      expect(it.excerpt ?? "").not.toMatch(/<[a-z/]/i);
      expect(it.publishedAt).toBeInstanceOf(Date);
      expect(it.raw).toBeUndefined();
    }
    expect(items[0]!.author).toBe("Bill Toulas");
  });

  it("parses a real Atom feed (Schneier)", async () => {
    const items = await parseFeed(fixture("atom-schneier.xml"), NOW);
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.url).toMatch(/^https:\/\/www\.schneier\.com\//);
      expect(it.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("handles edge cases: HTML, unsafe links, duplicates, bad dates, empty titles", async () => {
    const items = await parseFeed(fixture("rss-edge-cases.xml"), NOW);
    expect(items.map((i) => i.externalId)).toEqual([
      "edge-1",
      "edge-dup",
      "https://edge.example.com/patch-tuesday",
    ]);

    const [first, dup, patch] = items;
    expect(first!.title).toBe("Critical flaw in Acme VPN & Gateway (CVE–2026–1234)");
    expect(first!.excerpt).toBe("Attackers exploit cve-2026-5678 in the wild. More at NVD.");
    expect(first!.excerpt).not.toContain("FULL ARTICLE BODY");
    expect(first!.author).toBe("Jane Doe");
    // CVE IDs from title + excerpt only; the NVD link lives in an href we stripped.
    expect(first!.cveIds).toEqual(["CVE-2026-1234", "CVE-2026-5678"]);
    expect(first!.url).toBe("https://edge.example.com/acme-vpn?utm_source=rss");

    expect(dup!.title).toBe("First copy");
    expect(patch!.publishedAt).toBeNull();
    expect(patch!.cveIds).toEqual(["CVE-2026-2000"]);
  });

  it("rejects non-feed content", async () => {
    await expect(parseFeed("<html><body>not a feed</body></html>")).rejects.toBeInstanceOf(SourceParseError);
  });

  it("sends conditional headers unless forced, and stores validators", async () => {
    const f = fakeFetcher(() => ({
      body: fixture("rss-edge-cases.xml"),
      headers: { etag: '"new"', "last-modified": "Sun, 08 Nov 2026 12:00:00 GMT" },
    }));
    const src = makeSource({ etag: '"old"', lastModified: "Sat, 07 Nov 2026 00:00:00 GMT" });

    const res = await rssAdapter.fetch(src, ctx({ fetcher: f }));
    expect(f.calls[0]!.opts.headers).toMatchObject({
      "if-none-match": '"old"',
      "if-modified-since": "Sat, 07 Nov 2026 00:00:00 GMT",
    });
    expect(res).toMatchObject({ status: "ok", etag: '"new"', lastModified: "Sun, 08 Nov 2026 12:00:00 GMT" });

    await rssAdapter.fetch(src, ctx({ fetcher: f, force: true }));
    expect(f.calls[1]!.opts.headers).not.toHaveProperty("if-none-match");
    expect(f.calls[1]!.opts.headers).not.toHaveProperty("if-modified-since");
  });

  it("returns not_modified on 304", async () => {
    const f = fakeFetcher(() => ({ status: 304 }));
    expect(await rssAdapter.fetch(makeSource({ etag: '"x"' }), ctx({ fetcher: f }))).toEqual({
      status: "not_modified",
      httpStatus: 304,
    });
  });

  it("throws SourceHttpError with the status for non-2xx", async () => {
    const f = fakeFetcher(() => ({ status: 503, body: "down" }));
    await expect(rssAdapter.fetch(makeSource(), ctx({ fetcher: f }))).rejects.toMatchObject({
      name: "SourceHttpError",
      httpStatus: 503,
    });
    await expect(rssAdapter.fetch(makeSource(), ctx({ fetcher: f }))).rejects.toBeInstanceOf(SourceHttpError);
  });

  it("passes the dry-run timeout through to the fetcher", async () => {
    const f = fakeFetcher(() => ({ body: fixture("rss-edge-cases.xml") }));
    await rssAdapter.fetch(makeSource(), ctx({ fetcher: f, timeoutMs: 20_000 }));
    expect(f.calls[0]!.opts.timeoutMs).toBe(20_000);
  });

  it("cannot be backfilled", () => {
    expect(rssAdapter.supportsBackfill).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CISA KEV
// ---------------------------------------------------------------------------

describe("CISA KEV adapter", () => {
  const catalog = JSON.parse(fixture("kev.json")) as { vulnerabilities: Array<{ cveID: string; dateAdded: string }> };

  it("upserts every catalog entry but only makes items for recent additions", () => {
    const { items, cves } = parseKevCatalog(catalog, { now: NOW, lookbackDays: 14 });
    expect(cves).toHaveLength(catalog.vulnerabilities.length);
    // Fixture: 4 entries added 2026-10-30..2026-11-06 are within 14 days of 2026-11-08.
    expect(items.map((i) => i.externalId)).toEqual([
      "CVE-2026-19868",
      "CVE-2024-27834",
      "CVE-2026-119977",
      "CVE-2026-118527",
    ]);
  });

  it("the lookback window is configurable", () => {
    expect(parseKevCatalog(catalog, { now: NOW, lookbackDays: 3 }).items.map((i) => i.externalId)).toEqual([
      "CVE-2026-19868",
    ]);
    expect(parseKevCatalog(catalog, { now: NOW, lookbackDays: 365 }).items).toHaveLength(catalog.vulnerabilities.length);
  });

  it("shapes items and CVE records per SPEC §6.7", () => {
    const { items, cves } = parseKevCatalog(catalog, { now: NOW, lookbackDays: 14 });
    const item = items[0]!;
    expect(item.title).toBe("Added to CISA KEV: SonicWall SonicOS SSLVPN Use of Single-factor Authentication Vulnerability");
    expect(item.url).toBe(kevEntryUrl("CVE-2026-19868"));
    expect(item.cveIds[0]).toBe("CVE-2026-19868");
    expect(item.publishedAt?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect([...(item.excerpt ?? "")].length).toBeLessThanOrEqual(400);
    expect(item.raw).toMatchObject({ cveID: "CVE-2026-19868", vendorProject: "SonicWall" });

    const ransom = cves.find((c) => c.kevRansomware === "Known")!;
    expect(ransom).toMatchObject({ inKev: true, kevDateAdded: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(cves.find((c) => c.id === "CVE-2026-19868")).toMatchObject({
      kevVendor: "SonicWall",
      kevProduct: "SonicOS SSLVPN",
      kevDueDate: "2026-11-20",
    });
  });

  it("skips malformed entries without failing the catalog", () => {
    const { cves, skipped } = parseKevCatalog(
      { vulnerabilities: [{ cveID: "not-a-cve", dateAdded: "2026-11-01" }, { foo: 1 }, catalog.vulnerabilities[0]] },
      { now: NOW, lookbackDays: 14 },
    );
    expect(cves).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("rejects a response that isn't a KEV catalog", () => {
    expect(() => parseKevCatalog({ hello: "world" }, { now: NOW, lookbackDays: 14 })).toThrow(SourceParseError);
  });

  it("fetches with conditional headers and returns cves alongside items", async () => {
    const f = fakeFetcher(() => ({ body: fixture("kev.json"), headers: { etag: '"k2"' } }));
    const res = await cisaKevAdapter.fetch(
      makeSource({ type: "cisa_kev", etag: '"k1"' }),
      ctx({ fetcher: f, kevItemLookbackDays: 14 }),
    );
    expect(f.calls[0]!.opts.headers).toMatchObject({ "if-none-match": '"k1"' });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.cves).toHaveLength(catalog.vulnerabilities.length);
      expect(res.items).toHaveLength(4);
      expect(res.etag).toBe('"k2"');
    }
  });

  it("returns not_modified on 304", async () => {
    const f = fakeFetcher(() => ({ status: 304 }));
    expect((await cisaKevAdapter.fetch(makeSource({ type: "cisa_kev" }), ctx({ fetcher: f }))).status).toBe("not_modified");
  });
});

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

describe("Hacker News adapter", () => {
  const response = JSON.parse(fixture("hn-search.json")) as { hits: Array<{ objectID: string; points: number; url?: string }> };
  const hnSource = makeSource({
    id: "hackernews",
    type: "hackernews",
    url: "https://hn.algolia.com/api/v1/search_by_date",
    category: "community",
  });

  it("keeps only stories with a URL and enough points", () => {
    const items = parseHnHits(response.hits, 20, NOW);
    const expected = response.hits.filter((h) => h.url && h.points >= 20).map((h) => h.objectID);
    expect(items.map((i) => i.externalId)).toEqual(expected);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(response.hits.length);
  });

  it("links to the article and keeps the HN discussion in raw", () => {
    const item = parseHnHits(response.hits, 20, NOW)[0]!;
    const src = response.hits.find((h) => h.objectID === item.externalId)!;
    expect(item.url).toBe(new URL(src.url!).href);
    expect(item.raw).toEqual({
      objectID: src.objectID,
      points: src.points,
      numComments: expect.any(Number),
      hnUrl: `https://news.ycombinator.com/item?id=${src.objectID}`,
    });
    expect(item.excerpt).toBeNull();
  });

  it("drops unsafe URLs", () => {
    expect(parseHnHits([{ objectID: "1", title: "x", url: "javascript:alert(1)", points: 500 }], 20)).toEqual([]);
  });

  it("reads config with defaults", () => {
    expect(hnConfig(hnSource)).toEqual({ queries: HN_DEFAULT_QUERIES, minPoints: 20 });
    expect(hnConfig({ config: { queries: ["CVE"], minPoints: 50 } })).toEqual({ queries: ["CVE"], minPoints: 50 });
    expect(hnConfig({ config: { queries: "oops" } })).toEqual({ queries: HN_DEFAULT_QUERIES, minPoints: 20 });
    expect(hackerNewsAdapter.requestsPerFetch(hnSource)).toBe(7);
  });

  it("builds the Algolia query", () => {
    const u = new URL(buildSearchUrl(hnSource.url, "zero-day", 1_700_000_000, 20));
    expect(u.searchParams.get("query")).toBe("zero-day");
    expect(u.searchParams.get("tags")).toBe("story");
    expect(u.searchParams.get("numericFilters")).toBe("created_at_i>1700000000,points>=20");
  });

  it("looks back at least 24h, further if the last success was older", () => {
    const nowS = NOW.getTime() / 1000;
    expect(hnSince(null, NOW)).toBe(nowS - 48 * 3600);
    expect(hnSince(new Date(NOW.getTime() - 15 * 60_000), NOW)).toBe(nowS - 24 * 3600);
    expect(hnSince(new Date(NOW.getTime() - 72 * 3600_000), NOW)).toBe(nowS - 73 * 3600);
  });

  it("issues one request per query and dedupes across queries", async () => {
    const f = fakeFetcher(() => ({ body: fixture("hn-search.json") }));
    const res = await hackerNewsAdapter.fetch(hnSource, ctx({ fetcher: f }));
    expect(f.calls).toHaveLength(HN_DEFAULT_QUERIES.length);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.items.length).toBe(parseHnHits(response.hits, 20).length);
    }
  });

  it("paginates during backfill and applies the range", async () => {
    const f = fakeFetcher((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 0);
      return { body: JSON.stringify({ hits: page === 0 ? response.hits : [], nbPages: 2, page }) };
    });
    await hackerNewsAdapter.fetch(
      { ...hnSource, config: { queries: ["CVE"] } },
      ctx({ fetcher: f, range: { since: new Date("2026-10-01T00:00:00Z"), until: new Date("2026-10-02T00:00:00Z") } }),
    );
    expect(f.calls).toHaveLength(2);
    expect(new URL(f.calls[0]!.url).searchParams.get("numericFilters")).toBe(
      `created_at_i>${Date.UTC(2026, 9, 1) / 1000},created_at_i<${Date.UTC(2026, 9, 2) / 1000},points>=20`,
    );
  });
});
