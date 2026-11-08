/**
 * Story feed URL parameters (SPEC §8): filters and sort live in the query
 * string so filtered views can be shared. Pure and unit-tested; the query
 * itself lives in ./queries.ts.
 */
import { z } from "zod";
import { normalizeCveId } from "../lib/cve";

export const RANGES = { "24h": 1, "7d": 7, "30d": 30 } as const;
export type Range = keyof typeof RANGES;
export const DEFAULT_RANGE: Range = "7d";

export const SORTS = {
  recent: "Latest activity",
  covered: "Most covered",
  risk: "Highest risk",
} as const;
export type Sort = keyof typeof SORTS;
export const DEFAULT_SORT: Sort = "recent";

export const MIN_CVSS_OPTIONS = [4, 7, 9] as const;
export const CATEGORIES = ["news", "research", "advisory", "community", "social"] as const;
export type Category = (typeof CATEGORIES)[number];

export type FeedFilters = {
  range: Range;
  kev: boolean;
  minCvss: number | null;
  category: Category | null;
  source: string | null;
  vendor: string | null;
  q: string | null;
  sort: Sort;
  cursor: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Lenient: unknown or malformed values fall back to defaults instead of erroring. */
export function parseFeedParams(params: RawParams): FeedFilters {
  const range = first(params.range);
  const sort = first(params.sort);
  const minCvss = Number(first(params.minCvss));
  const category = first(params.category);
  const source = first(params.source);
  return {
    range: range && range in RANGES ? (range as Range) : DEFAULT_RANGE,
    kev: ["1", "true", "on"].includes(first(params.kev) ?? ""),
    minCvss: Number.isFinite(minCvss) && minCvss > 0 && minCvss <= 10 ? minCvss : null,
    category: category && (CATEGORIES as readonly string[]).includes(category) ? (category as Category) : null,
    source: source && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source) ? source : null,
    vendor: first(params.vendor)?.slice(0, 100) ?? null,
    q: first(params.q)?.slice(0, 200) ?? null,
    sort: sort && sort in SORTS ? (sort as Sort) : DEFAULT_SORT,
    cursor: first(params.cursor)?.slice(0, 500) ?? null,
  };
}

/** Builds a feed URL; defaults are omitted so URLs stay short. The cursor resets unless given. */
export function feedHref(f: FeedFilters, overrides: Partial<FeedFilters> = {}): string {
  const v: FeedFilters = { ...f, cursor: null, ...overrides };
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.range !== DEFAULT_RANGE) p.set("range", v.range);
  if (v.kev) p.set("kev", "1");
  if (v.minCvss) p.set("minCvss", String(v.minCvss));
  if (v.category) p.set("category", v.category);
  if (v.source) p.set("source", v.source);
  if (v.vendor) p.set("vendor", v.vendor);
  if (v.sort !== DEFAULT_SORT) p.set("sort", v.sort);
  if (v.cursor) p.set("cursor", v.cursor);
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

export function hasActiveFilters(f: FeedFilters): boolean {
  return Boolean(f.q || f.kev || f.minCvss || f.category || f.source || f.vendor || f.range !== DEFAULT_RANGE);
}

/** A search that is exactly one CVE id matches that CVE directly rather than through full-text search. */
export function searchAsCveId(q: string | null): string | null {
  if (!q) return null;
  return /^\s*CVE[-‐‑‒–—]\d{4}[-‐‑‒–—]\d{4,7}\s*$/i.test(q) ? normalizeCveId(q.trim()) : null;
}

// ---------------------------------------------------------------------------
// Keyset cursors. Values are the sort key of the last row on the page, as
// Postgres text (timestamps keep microseconds, numerics stay exact).
// ---------------------------------------------------------------------------

/** Postgres timestamptz text, e.g. "2026-11-08 10:15:00.123456+00". Anything else would fail the ::timestamptz cast. */
const ts = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/)
  .refine((v) => {
    // To JS ISO form ("+00" → "+00:00", microseconds trimmed) and check it's a real instant.
    const iso = v.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00");
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso.slice(0, 10);
  });
const num = z.string().regex(/^-?\d+(\.\d+)?$/).max(40);
const uuid = z.uuid();

const CURSOR_SCHEMAS = {
  recent: z.tuple([ts, uuid]),
  covered: z.tuple([z.string().regex(/^\d+$/).max(10), ts, uuid]),
  risk: z.tuple([z.enum(["t", "f"]), num, num, ts, uuid]),
} as const;

export type CursorValues = {
  recent: z.infer<(typeof CURSOR_SCHEMAS)["recent"]>;
  covered: z.infer<(typeof CURSOR_SCHEMAS)["covered"]>;
  risk: z.infer<(typeof CURSOR_SCHEMAS)["risk"]>;
};

export function encodeCursor<S extends Sort>(sort: S, values: CursorValues[S]): string {
  return Buffer.from(JSON.stringify([sort, ...values]), "utf8").toString("base64url");
}

/** Returns null for anything malformed or for a cursor from a different sort. */
export function decodeCursor<S extends Sort>(sort: S, cursor: string | null): CursorValues[S] | null {
  if (!cursor) return null;
  try {
    const arr: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(arr) || arr[0] !== sort) return null;
    const r = CURSOR_SCHEMAS[sort].safeParse(arr.slice(1));
    return r.success ? (r.data as CursorValues[S]) : null;
  } catch {
    return null;
  }
}
