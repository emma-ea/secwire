import { z } from "zod";
import { extractCveIdsFrom } from "../../lib/cve";
import { toTitle } from "../../lib/text";
import { parseHttpUrl } from "../../lib/url";
import { assertOk, getFrom } from "./http";
import { SourceParseError, type FetchResult, type NormalizedItem, type Source, type SourceAdapter } from "./types";

export const HN_DEFAULT_QUERIES = ["CVE", "vulnerability", "zero-day", "0day", "exploit", "ransomware", "breach", "RCE"];
export const HN_DEFAULT_MIN_POINTS = 20;

const HOUR_S = 3600;
/** Minimum look-back for normal runs: stories need time to collect points. See DECISIONS.md. */
const MIN_LOOKBACK_S = 24 * HOUR_S;
const FIRST_RUN_LOOKBACK_S = 48 * HOUR_S;
const HITS_PER_PAGE = 100;
/** Pages per query during backfill (Algolia serves at most 1000 hits per query). */
const MAX_BACKFILL_PAGES = 10;

const configSchema = z
  .object({
    queries: z.array(z.string().min(1)).min(1).optional(),
    minPoints: z.number().int().min(0).optional(),
  })
  .loose();

export function hnConfig(source: Pick<Source, "config">): { queries: string[]; minPoints: number } {
  const c = configSchema.safeParse(source.config ?? {});
  const data = c.success ? c.data : {};
  return {
    queries: data.queries ?? HN_DEFAULT_QUERIES,
    minPoints: data.minPoints ?? HN_DEFAULT_MIN_POINTS,
  };
}

const hit = z.object({
  objectID: z.string(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  author: z.string().nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_at: z.string().nullish(),
  created_at_i: z.number().nullish(),
});
const searchResponse = z.object({
  hits: z.array(z.unknown()),
  nbPages: z.number().optional(),
  page: z.number().optional(),
});

export function hnDiscussionUrl(objectID: string): string {
  return `https://news.ycombinator.com/item?id=${encodeURIComponent(objectID)}`;
}

/**
 * Algolia's defaults are tuned for discovery, not precision: typo tolerance
 * turns "CVE" into "CEO", prefix matching and URL/author attributes match
 * "RCE" inside "source". These make a query match whole title words only
 * (plurals allowed). See DECISIONS.md.
 */
export const HN_STRICT_SEARCH_PARAMS: Readonly<Record<string, string>> = {
  typoTolerance: "false",
  restrictSearchableAttributes: "title",
  queryType: "prefixNone",
  ignorePlurals: "true",
  advancedSyntax: "false",
};

/** Hyphens are word separators for Algolia ("zero-day" → "zero day"). */
export function normalizeHnQuery(query: string): string {
  return query
    .replace(/[-\u2010-\u2015_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function wordMatches(word: string, term: string): boolean {
  if (word === term) return true;
  if (word === `${term}s` || word === `${term}es`) return true;
  return term.endsWith("y") && word === `${term.slice(0, -1)}ies`;
}

/**
 * Local relevance check, defence in depth over the Algolia params: the query's
 * words must appear in the title as consecutive whole words (plurals allowed).
 * "zero day" matches "Chrome zero-day exploited" but not "Zero to Calc in Six Days".
 */
export function titleMatchesQuery(title: string, query: string): boolean {
  const q = tokens(normalizeHnQuery(query));
  if (!q.length) return false;
  const t = tokens(title);
  outer: for (let i = 0; i + q.length <= t.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (!wordMatches(t[i + j]!, q[j]!)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Converts Algolia hits to items: requires an http(s) URL and enough points,
 * and — when `query` is given — a title that actually contains the query.
 */
export function parseHnHits(hits: unknown[], minPoints: number, now = new Date(), query?: string): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  for (const raw of hits) {
    const r = hit.safeParse(raw);
    if (!r.success) continue;
    const h = r.data;
    const url = parseHttpUrl(h.url);
    const points = h.points ?? 0;
    if (!url || points < minPoints) continue;
    const title = toTitle(h.title);
    if (!title) continue;
    if (query !== undefined && !titleMatchesQuery(title, query)) continue;
    out.push({
      externalId: h.objectID,
      url: url.href,
      title,
      excerpt: null,
      author: h.author ?? null,
      publishedAt: h.created_at_i ? new Date(h.created_at_i * 1000) : null,
      cveIds: extractCveIdsFrom([title], now),
      raw: {
        objectID: h.objectID,
        points,
        numComments: h.num_comments ?? 0,
        hnUrl: hnDiscussionUrl(h.objectID),
      },
    });
  }
  return out;
}

export function buildSearchUrl(
  base: string,
  query: string,
  sinceS: number,
  minPoints: number,
  opts: { untilS?: number; page?: number } = {},
): string {
  const u = new URL(base);
  const filters = [`created_at_i>${sinceS}`];
  if (opts.untilS) filters.push(`created_at_i<${opts.untilS}`);
  if (minPoints > 0) filters.push(`points>=${minPoints}`);
  u.searchParams.set("query", normalizeHnQuery(query));
  u.searchParams.set("tags", "story");
  for (const [k, v] of Object.entries(HN_STRICT_SEARCH_PARAMS)) u.searchParams.set(k, v);
  u.searchParams.set("numericFilters", filters.join(","));
  u.searchParams.set("hitsPerPage", String(HITS_PER_PAGE));
  if (opts.page) u.searchParams.set("page", String(opts.page));
  return u.toString();
}

/** Lower bound (unix seconds) for a normal run. */
export function hnSince(lastSuccessAt: Date | null, now: Date): number {
  const nowS = Math.floor(now.getTime() / 1000);
  if (!lastSuccessAt) return nowS - FIRST_RUN_LOOKBACK_S;
  const fromLast = Math.floor(lastSuccessAt.getTime() / 1000) - HOUR_S;
  return Math.min(fromLast, nowS - MIN_LOOKBACK_S);
}

export const hackerNewsAdapter: SourceAdapter = {
  type: "hackernews",
  supportsBackfill: true,
  requestsPerFetch: (source) => hnConfig(source).queries.length,
  async fetch(source, ctx): Promise<FetchResult> {
    const now = ctx.now ?? new Date();
    const { queries, minPoints } = hnConfig(source);
    const sinceS = ctx.range
      ? Math.floor(ctx.range.since.getTime() / 1000)
      : hnSince(source.lastSuccessAt, now);
    const untilS = ctx.range?.until ? Math.floor(ctx.range.until.getTime() / 1000) : undefined;
    const maxPages = ctx.range ? MAX_BACKFILL_PAGES : 1;

    const byId = new Map<string, NormalizedItem>();
    let lastStatus = 200;
    for (const q of queries) {
      for (let page = 0; page < maxPages; page++) {
        const res = await getFrom(buildSearchUrl(source.url, q, sinceS, minPoints, { untilS, page }), ctx, {
          accept: "application/json",
        });
        assertOk(res);
        lastStatus = res.status;
        let body: z.infer<typeof searchResponse>;
        try {
          body = searchResponse.parse(JSON.parse(res.text()));
        } catch {
          throw new SourceParseError("HN search: unexpected response");
        }
        for (const item of parseHnHits(body.hits, minPoints, now, q)) byId.set(item.externalId, item);
        if (body.nbPages === undefined || page + 1 >= body.nbPages) break;
      }
    }
    // Algolia doesn't support conditional GET; HN never reports not_modified.
    return { status: "ok", httpStatus: lastStatus, items: [...byId.values()] };
  },
};
