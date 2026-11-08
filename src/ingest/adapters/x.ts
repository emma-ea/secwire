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

export function xSearchUrl(account: string, cfg: XConfig, startTime: string): string {
  const u = new URL(X_SEARCH_URL);
  u.searchParams.set("query", xQuery(account, cfg.filter));
  u.searchParams.set("max_results", String(cfg.maxResults));
  u.searchParams.set("start_time", startTime);
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
    const startTime = xStartTime(source.lastSuccessAt, now);
    const byId = new Map<string, NormalizedItem>();
    let lastStatus = 200;
    for (const account of cfg.accounts) {
      const res = await getFrom(xSearchUrl(account, cfg, startTime), ctx, {
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
      const { items, billable } = parseXSearch(json, account, cfg, now);
      ctx.trackUsage?.({ units: billable, usd: billable * ctx.x.postReadUsd });
      for (const i of items) byId.set(i.externalId, i);
    }
    return { status: "ok", httpStatus: lastStatus, items: [...byId.values()] };
  },
};
