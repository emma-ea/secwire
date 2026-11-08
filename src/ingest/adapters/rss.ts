import Parser from "rss-parser";
import { extractCveIdsFrom } from "../../lib/cve";
import { toExcerpt, toTitle } from "../../lib/text";
import { parseHttpUrl } from "../../lib/url";
import { assertOk, conditionalHeaders, getFrom, parseDate, validatorHeaders } from "./http";
import { SourceParseError, type FetchResult, type NormalizedItem, type SourceAdapter } from "./types";

/** Hard cap so a pathological feed can't flood a run. */
const MAX_ITEMS = 200;

type FeedItem = {
  title?: string;
  link?: string;
  guid?: string;
  id?: string;
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  author?: string;
  summary?: string;
  description?: string;
  contentSnippet?: string;
  content?: string;
};

// Never use parser.parseURL(): it does its own HTTP and would bypass safe-fetch.
const parser = new Parser<Record<string, unknown>, FeedItem>({
  customFields: { item: ["description", "summary", "author"] },
});

export async function parseFeed(xml: string, now = new Date()): Promise<NormalizedItem[]> {
  if (/^\s*(?:\ufeff)?\s*(?:<!doctype html|<html[\s>])/i.test(xml)) {
    throw new SourceParseError("URL returned an HTML page, not an RSS/Atom feed (the feed may have moved)");
  }
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    throw new SourceParseError(`Feed parse failed: ${(err as Error).message}`);
  }

  const out = new Map<string, NormalizedItem>();
  for (const it of feed.items ?? []) {
    if (out.size >= MAX_ITEMS) break;
    const link = parseHttpUrl(it.link) ?? parseHttpUrl(it.guid) ?? parseHttpUrl(it.id);
    if (!link) continue; // http(s) only (SPEC §10)
    const title = toTitle(it.title);
    if (!title) continue;

    // Prefer the short description over full content (we never store article bodies).
    const excerpt = toExcerpt(
      firstString(it.description, it.summary, it.contentSnippet, it.content),
    );
    const externalId = (it.guid || it.id || link.href).trim().slice(0, 2048);
    if (out.has(externalId)) continue;

    out.set(externalId, {
      externalId,
      url: link.href,
      title,
      excerpt,
      author: toTitle(it.creator ?? it.author) || null,
      publishedAt: parseDate(it.isoDate ?? it.pubDate),
      cveIds: extractCveIdsFrom([title, excerpt], now),
    });
  }
  return [...out.values()];
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

export const rssAdapter: SourceAdapter = {
  type: "rss",
  supportsBackfill: false,
  requestsPerFetch: () => 1,
  async fetch(source, ctx): Promise<FetchResult> {
    const res = await getFrom(source.url, ctx, {
      ...conditionalHeaders(source, ctx.force),
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
    });
    if (res.status === 304) return { status: "not_modified", httpStatus: 304 };
    assertOk(res);
    const items = await parseFeed(res.text(), ctx.now);
    return { status: "ok", httpStatus: res.status, items, ...validatorHeaders(res) };
  },
};
