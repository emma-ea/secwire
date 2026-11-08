/**
 * Read-side queries for the public pages (SPEC §8). Pages call these and
 * render; nothing here fetches external data.
 */
import { getPool, type Queryable } from "../db/client";
import { normalizeCveId } from "../lib/cve";
import {
  decodeCursor,
  encodeCursor,
  RANGES,
  searchAsCveId,
  type CursorValues,
  type FeedFilters,
} from "./params";

export const PAGE_SIZE = 40;

export type StoryListRow = {
  id: string;
  title: string;
  first_seen_at: Date;
  last_activity_at: Date;
  item_count: number;
  max_cvss: number | null;
  has_kev: boolean;
  max_epss: number | null;
  max_epss_percentile: number | null;
  has_ransomware: boolean;
  cve_ids: string[];
  vendors: string[];
  source_ids: string[];
  /** "Vendor Product" pairs from KEV, else NVD. */
  vendor_products: string[];
  /** Phase 3 AI summary (plain text) and how many items it was written from. */
  summary: string | null;
  summary_item_count: number | null;
  summary_model: string | null;
};

type KeyColumns = { k_ts: string; k_count: string; k_kev: "t" | "f"; k_epss: string; k_cvss: string };

/** Columns every story list selects (feed, CVE page). */
const STORY_COLUMNS = `
  s.id, s.title, s.first_seen_at, s.last_activity_at, s.item_count,
  s.max_cvss::float8 AS max_cvss, s.has_kev, s.max_epss::float8 AS max_epss,
  s.max_epss_percentile::float8 AS max_epss_percentile, s.has_ransomware,
  s.cve_ids, s.vendors, s.source_ids, s.summary, s.summary_item_count, s.summary_model,
  coalesce(vp.vendor_products, '{}') AS vendor_products`;

const VENDOR_PRODUCTS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT concat_ws(' ', coalesce(c.kev_vendor, c.nvd_vendor), coalesce(c.kev_product, c.nvd_product))) AS vendor_products
      FROM story_cves sc JOIN cves c ON c.id = sc.cve_id
     WHERE sc.story_id = s.id AND coalesce(c.kev_vendor, c.nvd_vendor) IS NOT NULL
  ) vp ON true`;

const ORDER_BY = {
  recent: "s.last_activity_at DESC, s.id DESC",
  covered: "s.item_count DESC, s.last_activity_at DESC, s.id DESC",
  risk: "s.has_kev DESC, coalesce(s.max_epss, -1) DESC, coalesce(s.max_cvss, -1) DESC, s.last_activity_at DESC, s.id DESC",
} as const;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** SQL WHERE clause + params for the feed filters. Exported for tests. */
export function buildFeedWhere(f: FeedFilters, now: Date): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [`s.last_activity_at >= ${p(now)}::timestamptz - make_interval(days => ${p(RANGES[f.range])})`];

  if (f.kev) conds.push("s.has_kev");
  if (f.minCvss !== null) conds.push(`s.max_cvss >= ${p(f.minCvss)}`);
  if (f.category) conds.push(`s.source_ids && ARRAY(SELECT id FROM sources WHERE category = ${p(f.category)}::source_category)`);
  if (f.source) conds.push(`s.source_ids @> ARRAY[${p(f.source)}]::text[]`);
  if (f.vendor) {
    conds.push(`EXISTS (SELECT 1 FROM unnest(s.vendors) v WHERE v ILIKE ${p(`%${escapeLike(f.vendor)}%`)})`);
  }
  const cveId = searchAsCveId(f.q);
  if (cveId) {
    conds.push(`s.id IN (SELECT story_id FROM story_cves WHERE cve_id = ${p(cveId)})`);
  } else if (f.q) {
    conds.push(
      `EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id AND i.search_vector @@ websearch_to_tsquery('english', ${p(f.q)}))`,
    );
  }

  switch (f.sort) {
    case "recent": {
      const c = decodeCursor("recent", f.cursor);
      if (c) conds.push(`(s.last_activity_at, s.id) < (${p(c[0])}::timestamptz, ${p(c[1])}::uuid)`);
      break;
    }
    case "covered": {
      const c = decodeCursor("covered", f.cursor);
      if (c) {
        conds.push(
          `(s.item_count, s.last_activity_at, s.id) < (${p(c[0])}::int, ${p(c[1])}::timestamptz, ${p(c[2])}::uuid)`,
        );
      }
      break;
    }
    case "risk": {
      const c = decodeCursor("risk", f.cursor);
      if (c) {
        conds.push(
          `(s.has_kev, coalesce(s.max_epss, -1), coalesce(s.max_cvss, -1), s.last_activity_at, s.id) < (${p(c[0] === "t")}::boolean, ${p(c[1])}::numeric, ${p(c[2])}::numeric, ${p(c[3])}::timestamptz, ${p(c[4])}::uuid)`,
        );
      }
      break;
    }
  }
  return { where: conds.join("\n   AND "), params };
}

function cursorFor(f: FeedFilters, row: KeyColumns & { id: string }): string {
  switch (f.sort) {
    case "recent":
      return encodeCursor("recent", [row.k_ts, row.id] satisfies CursorValues["recent"]);
    case "covered":
      return encodeCursor("covered", [row.k_count, row.k_ts, row.id] satisfies CursorValues["covered"]);
    case "risk":
      return encodeCursor("risk", [row.k_kev, row.k_epss, row.k_cvss, row.k_ts, row.id] satisfies CursorValues["risk"]);
  }
}

export async function listStories(
  f: FeedFilters,
  opts: { limit?: number; now?: Date; client?: Queryable } = {},
): Promise<{ stories: StoryListRow[]; nextCursor: string | null }> {
  const limit = opts.limit ?? PAGE_SIZE;
  const { where, params } = buildFeedWhere(f, opts.now ?? new Date());
  params.push(limit + 1);
  const r = await (opts.client ?? getPool()).query<StoryListRow & KeyColumns>(
    `SELECT ${STORY_COLUMNS},
            s.last_activity_at::text AS k_ts, s.item_count::text AS k_count,
            CASE WHEN s.has_kev THEN 't' ELSE 'f' END AS k_kev,
            coalesce(s.max_epss, -1)::text AS k_epss, coalesce(s.max_cvss, -1)::text AS k_cvss
       FROM stories s ${VENDOR_PRODUCTS_JOIN}
      WHERE ${where}
      ORDER BY ${ORDER_BY[f.sort]}
      LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    stories: rows.map(({ k_ts: _a, k_count: _b, k_kev: _c, k_epss: _d, k_cvss: _e, ...s }) => s),
    nextCursor: r.rows.length > limit && last ? cursorFor(f, last) : null,
  };
}

export type FilterOptions = {
  sources: Array<{ id: string; name: string; category: string }>;
  vendors: string[];
};

export async function getFilterOptions(client: Queryable = getPool()): Promise<FilterOptions> {
  const [sources, vendors] = await Promise.all([
    client.query<{ id: string; name: string; category: string }>(
      "SELECT id, name, category::text FROM sources ORDER BY lower(name)",
    ),
    client.query<{ v: string }>(
      `SELECT v FROM (SELECT DISTINCT unnest(vendors) AS v FROM stories
                       WHERE last_activity_at >= now() - interval '30 days') x
        ORDER BY lower(v) LIMIT 300`,
    ),
  ]);
  return { sources: sources.rows, vendors: vendors.rows.map((r) => r.v) };
}

// ---------------------------------------------------------------------------
// Story and CVE pages
// ---------------------------------------------------------------------------

export type CveDetail = {
  id: string;
  description: string | null;
  cvss_score: number | null;
  cvss_version: string | null;
  cvss_vector: string | null;
  cvss_severity: string | null;
  epss_score: number | null;
  epss_percentile: number | null;
  in_kev: boolean;
  kev_date_added: string | null;
  kev_due_date: string | null;
  kev_ransomware: string | null;
  kev_vendor: string | null;
  kev_product: string | null;
  kev_name: string | null;
  nvd_published_at: Date | null;
  nvd_enriched_at: Date | null;
  epss_enriched_at: Date | null;
  nvd_status: string | null;
  nvd_vendor: string | null;
  nvd_product: string | null;
  cwe_ids: string[];
};

const CVE_COLUMNS = `
  c.id, c.description, c.cvss_score::float8 AS cvss_score, c.cvss_version, c.cvss_vector, c.cvss_severity,
  c.epss_score::float8 AS epss_score, c.epss_percentile::float8 AS epss_percentile,
  c.in_kev, c.kev_date_added::text AS kev_date_added, c.kev_due_date::text AS kev_due_date,
  c.kev_ransomware, c.kev_vendor, c.kev_product, c.kev_name,
  c.nvd_published_at, c.nvd_enriched_at, c.epss_enriched_at, c.nvd_status, c.nvd_vendor, c.nvd_product, c.cwe_ids`;

export type StoryItem = {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  author: string | null;
  published_at: Date | null;
  activity_at: Date;
  source_id: string;
  source_name: string;
  category: string;
  hn_url: string | null;
  /** Social sources: the post's own permalink (the item URL is the linked article when there is one). */
  post_url: string | null;
  network: string | null;
  points: number | null;
  comments: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getStory(
  id: string,
  client: Queryable = getPool(),
): Promise<{ story: StoryListRow; cves: CveDetail[]; items: StoryItem[] } | null> {
  if (!UUID.test(id)) return null;
  const s = await client.query<StoryListRow>(`SELECT ${STORY_COLUMNS} FROM stories s ${VENDOR_PRODUCTS_JOIN} WHERE s.id = $1`, [id]);
  const story = s.rows[0];
  if (!story) return null;
  const [cves, items] = await Promise.all([
    client.query<CveDetail>(
      `SELECT ${CVE_COLUMNS} FROM story_cves sc JOIN cves c ON c.id = sc.cve_id
        WHERE sc.story_id = $1
        ORDER BY c.in_kev DESC, c.cvss_score DESC NULLS LAST, c.id`,
      [id],
    ),
    client.query<StoryItem>(
      `SELECT i.id, i.title, i.url, i.excerpt, i.author, i.published_at, i.activity_at,
              i.source_id, so.name AS source_name, so.category::text AS category,
              CASE WHEN so.type = 'hackernews' THEN i.raw->>'hnUrl' END AS hn_url,
              CASE WHEN so.type = 'hackernews' THEN (i.raw->>'points')::int END AS points,
              CASE WHEN so.type = 'hackernews' THEN (i.raw->>'numComments')::int END AS comments,
              CASE WHEN so.type::text IN ('bluesky', 'mastodon', 'x') THEN i.raw->>'postUrl' END AS post_url,
              CASE WHEN so.type::text IN ('bluesky', 'mastodon', 'x') THEN so.type::text END AS network
         FROM items i JOIN sources so ON so.id = i.source_id
        WHERE i.story_id = $1
        ORDER BY i.activity_at, i.id`,
      [id],
    ),
  ]);
  return { story, cves: cves.rows, items: items.rows };
}

export async function getCve(
  input: string,
  client: Queryable = getPool(),
): Promise<{ cve: CveDetail; stories: StoryListRow[]; itemCount: number } | null> {
  const id = normalizeCveId(input);
  if (!id) return null;
  const c = await client.query<CveDetail>(`SELECT ${CVE_COLUMNS} FROM cves c WHERE c.id = $1`, [id]);
  const cve = c.rows[0];
  if (!cve) return null;
  const [stories, items] = await Promise.all([
    client.query<StoryListRow>(
      `SELECT ${STORY_COLUMNS} FROM stories s ${VENDOR_PRODUCTS_JOIN}
        WHERE s.id IN (SELECT story_id FROM story_cves WHERE cve_id = $1)
        ORDER BY s.last_activity_at DESC, s.id DESC
        LIMIT 200`,
      [id],
    ),
    client.query<{ n: number }>("SELECT count(*)::int AS n FROM item_cves WHERE cve_id = $1", [id]),
  ]);
  return { cve, stories: stories.rows, itemCount: items.rows[0]?.n ?? 0 };
}
