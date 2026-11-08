/**
 * Mastodon account feed (Phase 3) via the account's public RSS
 * (https://instance/@user.rss), which needs no auth and already leaves out
 * replies and boosts. Posts have no title, so it comes from the first
 * paragraph. The source URL may be the profile (https://instance/@user) or
 * the .rss URL.
 */
import Parser from "rss-parser";
import { decodeEntities, htmlToText } from "../../lib/text";
import { parseHttpUrl } from "../../lib/url";
import { assertOk, conditionalHeaders, getFrom, parseDate, validatorHeaders } from "./http";
import { firstExternalLink, socialConfig, socialItem, type SocialConfig } from "./social";
import { SourceParseError, type FetchResult, type NormalizedItem, type SourceAdapter } from "./types";

const MAX_ITEMS = 100;

/** "https://infosec.exchange/@alice" → "https://infosec.exchange/@alice.rss"; null if not an account URL. */
export function mastodonFeedUrl(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u || u.search || u.hash) return null;
  const m = /^\/@([A-Za-z0-9_]+)(\.rss)?\/?$/.exec(u.pathname);
  return m ? `${u.protocol}//${u.host}/@${m[1]}.rss` : null;
}

type MastoItem = { link?: string; guid?: string; isoDate?: string; pubDate?: string; description?: string; content?: string };
const parser = new Parser<{ title?: string }, MastoItem>({ customFields: { item: ["description"] } });

const ANCHOR_RE = /<a\b([^>]*)>/gi;
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
};

/** hrefs of links in a post, skipping @mentions and #hashtags. */
export function postLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const attrs = m[1] ?? "";
    const cls = attr(attrs, "class") ?? "";
    const rel = attr(attrs, "rel") ?? "";
    if (/\b(mention|hashtag)\b/.test(cls) || /\btag\b/.test(rel)) continue;
    const href = attr(attrs, "href");
    if (href) out.push(href);
  }
  return out;
}

/** Quote posts start with `<p class="quote-inline">RE: <link to the quoted post></p>`; that's not the author's text or an article. */
export function stripQuoteInline(html: string): string {
  return html.replace(/<p\b[^>]*\bclass\s*=\s*["'][^"']*\bquote-inline\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi, "");
}

/** Post HTML → text with paragraph breaks kept (the title is the first paragraph). */
export function postText(html: string): string {
  return html
    .split(/<\/p>|<br\s*\/?>/i)
    .map((part) => htmlToText(part))
    .filter(Boolean)
    .join("\n");
}

export async function parseMastodonFeed(xml: string, feedUrl: string, config: SocialConfig, now = new Date()): Promise<NormalizedItem[]> {
  if (/^\s*(?:﻿)?\s*(?:<!doctype html|<html[\s>])/i.test(xml)) {
    throw new SourceParseError("URL returned an HTML page, not the account's RSS feed");
  }
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    throw new SourceParseError(`Feed parse failed: ${(err as Error).message}`);
  }
  const instanceHost = new URL(feedUrl).hostname;
  const author = htmlToText(feed.title) || null;
  const out = new Map<string, NormalizedItem>();
  for (const it of (feed.items ?? []).slice(0, MAX_ITEMS)) {
    const postUrl = parseHttpUrl(it.link) ?? parseHttpUrl(it.guid);
    if (!postUrl) continue;
    const html = stripQuoteInline(it.description ?? it.content ?? "");
    const item = socialItem(
      {
        externalId: (it.guid || postUrl.href).trim().slice(0, 2048),
        postUrl: postUrl.href,
        text: postText(html),
        // Links on the account's own instance are profiles, tags or other posts.
        link: firstExternalLink(postLinks(html), [instanceHost]),
        author,
        publishedAt: parseDate(it.isoDate ?? it.pubDate),
      },
      config,
      "mastodon",
      now,
    );
    if (item) out.set(item.externalId, item);
  }
  return [...out.values()];
}

export const mastodonAdapter: SourceAdapter = {
  type: "mastodon",
  supportsBackfill: false,
  requestsPerFetch: () => 1,
  async fetch(source, ctx): Promise<FetchResult> {
    const feedUrl = mastodonFeedUrl(source.url);
    if (!feedUrl) throw new SourceParseError("Mastodon source URL must be an account URL: https://instance/@user");
    const res = await getFrom(feedUrl, ctx, {
      ...conditionalHeaders(source, ctx.force),
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5",
    });
    if (res.status === 304) return { status: "not_modified", httpStatus: 304 };
    assertOk(res);
    const items = await parseMastodonFeed(res.text(), feedUrl, socialConfig(source), ctx.now);
    return { status: "ok", httpStatus: res.status, items, ...validatorHeaders(res) };
  },
};
