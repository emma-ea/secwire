/**
 * X (Twitter) via the pay-per-use API v2 (Phase 3), behind X_ENABLED and a
 * monthly spend cap (src/ingest/spend.ts).
 *
 * One recent-search request per account (`from:<account> -is:retweet
 * -is:reply`). X bills per post returned, not per request, so per-account
 * requests cost nothing extra and tell us the author without a paid user
 * lookup. The worst case per fetch is accounts × maxResults posts.
 *
 * The bearer token is only ever sent to api.x.com: the source URL must be the
 * recent-search endpoint exactly, and safe-fetch drops credentials on a
 * cross-origin redirect.
 */
import { z } from "zod";
import { getEnv } from "../../env";
import { parseHttpUrl } from "../../lib/url";
import { assertOk, getFrom, parseDate } from "./http";
import { firstExternalLink, socialConfig, socialItem, type SocialConfig } from "./social";
import { SourceParseError, type FetchResult, type NormalizedItem, type Source, type SourceAdapter } from "./types";

export const X_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
export const X_DEFAULT_MAX_RESULTS = 20;
export const X_MAX_ACCOUNTS = 25;
/** First fetch (or after a long gap): look back this far. Recent search covers 7 days at most. */
const FIRST_RUN_LOOKBACK_MS = 24 * 3_600_000;
const OVERLAP_MS = 10 * 60_000;
const MAX_LOOKBACK_MS = 7 * 24 * 3_600_000 - 5 * 60_000;
const INTERNAL_HOSTS = ["x.com", "twitter.com", "t.co"];

const ACCOUNT_RE = /^[A-Za-z0-9_]{1,15}$/;

const configSchema = z
  .object({
    accounts: z.array(z.string().regex(ACCOUNT_RE)).min(1).max(X_MAX_ACCOUNTS),
    maxResults: z.number().int().min(10).max(100).optional(),
  })
  .loose();

export type XConfig = SocialConfig & { accounts: string[]; maxResults: number };

export function xConfig(source: Pick<Source, "config">): XConfig {
  const c = configSchema.safeParse(source.config ?? {});
  if (!c.success) throw new SourceParseError("X source config needs accounts: 1–25 usernames (letters, digits, _)");
  return { ...socialConfig(source), accounts: c.data.accounts, maxResults: c.data.maxResults ?? X_DEFAULT_MAX_RESULTS };
}

/** Like xConfig, but never throws (cost estimates for a misconfigured source). */
function safeXConfig(source: Pick<Source, "config">): XConfig | null {
  try {
    return xConfig(source);
  } catch {
    return null;
  }
}

export function xPostReadUsd(): number {
  try {
    return getEnv().X_POST_READ_USD;
  } catch {
    return 0.005;
  }
}

export function xQuery(account: string, filter: SocialConfig["filter"]): string {
  // Server-side pre-filter so we don't pay for posts the relevance filter would drop anyway.
  const base = `from:${account} -is:retweet -is:reply`;
  return filter === "relevant" ? `${base} (has:links OR CVE)` : base;
}

export function xStartTime(lastSuccessAt: Date | null, now: Date): string {
  const from = lastSuccessAt ? lastSuccessAt.getTime() - OVERLAP_MS : now.getTime() - FIRST_RUN_LOOKBACK_MS;
  return new Date(Math.max(from, now.getTime() - MAX_LOOKBACK_MS)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Per-account cursors (newest post id fetched + when), kept in sources.etag:
 * the adapter contract's opaque per-source validator, persisted by runSource
 * only after a successful fetch. With since_id, a run never re-reads (and
 * re-pays for) posts an earlier run already fetched.
 */
export type XCursors = Record<string, { sinceId: string; at: string }>;
const CURSOR_PREFIX = "x1:";
/** since_id must be inside the 7-day recent-search window; older cursors fall back to start_time. */
const CURSOR_MAX_AGE_MS = 6.5 * 24 * 3_600_000;

export function parseXCursors(etag: string | null): XCursors {
  if (!etag?.startsWith(CURSOR_PREFIX)) return {};
  try {
    const raw = JSON.parse(etag.slice(CURSOR_PREFIX.length)) as unknown;
    const out: XCursors = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const c = v as { sinceId?: unknown; at?: unknown };
        if (ACCOUNT_RE.test(k) && typeof c?.sinceId === "string" && /^\d{0,19}$/.test(c.sinceId) && typeof c.at === "string") {
          out[k] = { sinceId: c.sinceId, at: c.at };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const serializeXCursors = (c: XCursors) => `${CURSOR_PREFIX}${JSON.stringify(c)}`;

export type XWindow = { sinceId: string } | { startTime: string };

/** since_id when the account has a fresh cursor; otherwise a 24h start_time (new account, or idle > 6.5 days). */
export function xWindow(cursor: XCursors[string] | undefined, now: Date): XWindow {
  if (cursor?.sinceId && now.getTime() - new Date(cursor.at).getTime() < CURSOR_MAX_AGE_MS) return { sinceId: cursor.sinceId };
  return { startTime: xStartTime(null, now) };
}

/** Posts X returned (and billed), whether or not they pass our schema. */
export function billableCount(json: unknown): number {
  const data = (json as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.length : 0;
}

/** meta.newest_id, else the largest post id in data. */
export function newestId(json: unknown): string | null {
  const j = json as { meta?: { newest_id?: unknown }; data?: Array<{ id?: unknown }> } | null;
  if (typeof j?.meta?.newest_id === "string" && /^\d{1,19}$/.test(j.meta.newest_id)) return j.meta.newest_id;
  const ids = (Array.isArray(j?.data) ? j.data : []).map((p) => p?.id).filter((id): id is string => typeof id === "string" && /^\d{1,19}$/.test(id));
  return ids.length ? ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)) : null;
}

export function xSearchUrl(account: string, cfg: XConfig, window: XWindow): string {
  const u = new URL(X_SEARCH_URL);
  u.searchParams.set("query", xQuery(account, cfg.filter));
  u.searchParams.set("max_results", String(cfg.maxResults));
  if ("sinceId" in window) u.searchParams.set("since_id", window.sinceId);
  else u.searchParams.set("start_time", window.startTime);
  u.searchParams.set("sort_order", "recency");
  // `tweet.fields`: the 2026 docs page lists `post.fields`, but every working
  // example still uses tweet.fields. See DECISIONS.md.
  u.searchParams.set("tweet.fields", "created_at,entities,note_tweet");
  return u.toString();
}

const urlEntity = z
  .object({
    url: z.string(),
    expanded_url: z.string().nullish(),
    unwound_url: z.string().nullish(),
    display_url: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
  })
  .loose();
const post = z
  .object({
    id: z.string().regex(/^\d{1,19}$/),
    text: z.string(),
    created_at: z.string().nullish(),
    entities: z.object({ urls: z.array(urlEntity).optional() }).loose().nullish(),
    note_tweet: z.object({ text: z.string() }).loose().nullish(),
  })
  .loose();
const searchResponse = z
  .object({ data: z.array(z.unknown()).optional(), meta: z.object({ result_count: z.number().optional() }).loose().optional() })
  .loose();

/** Parses one account's search response; `billable` is every post returned (X bills those). */
export function parseXSearch(json: unknown, account: string, cfg: SocialConfig, now = new Date()): { items: NormalizedItem[]; billable: number } {
  const parsed = searchResponse.safeParse(json);
  if (!parsed.success) throw new SourceParseError("X: unexpected search response");
  const data = parsed.data.data ?? [];
  const items: NormalizedItem[] = [];
  for (const raw of data) {
    const r = post.safeParse(raw);
    if (!r.success) continue;
    const p = r.data;
    const urls = p.entities?.urls ?? [];
    // Show the link as written, not as a t.co redirect.
    let text = p.note_tweet?.text ?? p.text;
    for (const u of urls) text = text.split(u.url).join(u.display_url ?? "");
    const link = firstExternalLink(urls.map((u) => u.unwound_url ?? u.expanded_url), INTERNAL_HOSTS);
    const ent = link ? urls.find((u) => parseHttpUrl(u.unwound_url ?? u.expanded_url)?.href === link.href) : undefined;
    const item = socialItem(
      {
        externalId: p.id,
        postUrl: `https://x.com/${account}/status/${p.id}`,
        text,
        link,
        linkTitle: ent?.title ?? null,
        linkDescription: ent?.description ?? null,
        author: `@${account}`,
        publishedAt: parseDate(p.created_at),
        extra: { handle: account },
      },
      cfg,
      "x",
      now,
    );
    if (item) items.push(item);
  }
  return { items, billable: data.length };
}

export const xAdapter: SourceAdapter = {
  type: "x",
  supportsBackfill: false,
  requestsPerFetch: (source) => safeXConfig(source)?.accounts.length ?? 0,
  costPerRequestUsd: (source) => (safeXConfig(source)?.maxResults ?? 0) * xPostReadUsd(),
  paid: {
    provider: "x",
    maxCostPerFetchUsd: (source) => {
      const c = safeXConfig(source);
      return c ? c.accounts.length * c.maxResults * xPostReadUsd() : 0;
    },
  },
  async fetch(source, ctx): Promise<FetchResult> {
    if (source.url !== X_SEARCH_URL) throw new SourceParseError(`X source URL must be ${X_SEARCH_URL}`);
    if (!ctx.x) throw new SourceParseError("X credentials are not configured");
    const cfg = xConfig(source);
    const now = ctx.now ?? new Date();
    const cursors = parseXCursors(source.etag);
    const next: XCursors = {};
    const byId = new Map<string, NormalizedItem>();
    let lastStatus = 200;
    let succeeded = 0;
    let failure: { account: string; err: unknown } | null = null;
    for (const account of cfg.accounts) {
      try {
        const res = await getFrom(xSearchUrl(account, cfg, xWindow(cursors[account], now)), ctx, {
          authorization: `Bearer ${ctx.x.bearerToken}`,
          accept: "application/json",
        });
        ctx.trackUsage?.({ requests: 1 });
        assertOk(res);
        lastStatus = res.status;
        let json: unknown;
        try {
          json = JSON.parse(res.text());
        } catch {
          throw new SourceParseError("X: response is not JSON");
        }
        // Count what X bills before strict parsing, so a schema surprise still counts toward the cap.
        const billable = billableCount(json);
        ctx.trackUsage?.({ units: billable, usd: billable * ctx.x.postReadUsd });
        const { items } = parseXSearch(json, account, cfg, now);
        for (const i of items) byId.set(i.externalId, i);
        const newest = newestId(json);
        // No new posts: keep the old cursor (it ages out after 6.5 days and falls back to start_time).
        const cursor = newest ? { sinceId: newest, at: now.toISOString() } : cursors[account];
        if (cursor) next[account] = cursor;
        succeeded++;
      } catch (err) {
        // Stop at the first failure (a 429 would repeat for the rest). Accounts not reached keep their cursor.
        failure = { account, err };
        break;
      }
    }
    if (failure && succeeded === 0) throw failure.err;
    // Accounts that weren't fetched keep their old cursor, so the next run picks up exactly where they left off.
    for (const a of cfg.accounts) if (!next[a] && cursors[a]) next[a] = cursors[a]!;
    return {
      status: "ok",
      httpStatus: lastStatus,
      items: [...byId.values()],
      etag: serializeXCursors(next),
      ...(failure
        ? { partialError: `@${failure.account}: ${failure.err instanceof Error ? failure.err.message : String(failure.err)}`.slice(0, 500) }
        : {}),
    };
  },
};
