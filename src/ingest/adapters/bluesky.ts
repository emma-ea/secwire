/**
 * Bluesky author feed (Phase 3). Uses the public AppView, which needs no
 * auth. The source URL is the profile page, https://bsky.app/profile/<handle>.
 */
import { z } from "zod";
import { parseHttpUrl } from "../../lib/url";
import { assertOk, getFrom, parseDate } from "./http";
import { firstExternalLink, socialConfig, socialItem, type SocialConfig } from "./social";
import { SourceParseError, type FetchResult, type NormalizedItem, type SourceAdapter } from "./types";

export const BSKY_AUTHOR_FEED_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const PAGE_LIMIT = 50;
/** Links to these hosts are the network itself or its media, not articles. */
const INTERNAL_HOSTS = ["bsky.app", "bsky.social", "go.bsky.app", "cdn.bsky.app", "video.bsky.app"];

const HANDLE_RE = /^(?:did:plc:[a-z2-7]{24}|did:web:[a-z0-9.-]+|(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*)$/i;

/** "https://bsky.app/profile/alice.bsky.social" → "alice.bsky.social"; null when it isn't a profile URL. */
export function bskyActorFromUrl(url: string): string | null {
  const u = parseHttpUrl(url);
  if (!u || u.hostname !== "bsky.app") return null;
  const m = /^\/profile\/([^/]+)\/?$/.exec(u.pathname);
  const actor = m ? decodeURIComponent(m[1]!) : null;
  return actor && HANDLE_RE.test(actor) ? actor.toLowerCase() : null;
}

export function bskyFeedUrl(actor: string): string {
  const u = new URL(BSKY_AUTHOR_FEED_URL);
  u.searchParams.set("actor", actor);
  u.searchParams.set("filter", "posts_no_replies");
  u.searchParams.set("limit", String(PAGE_LIMIT));
  return u.toString();
}

/** at://did:plc:x/app.bsky.feed.post/<rkey> → https://bsky.app/profile/<handle>/post/<rkey> */
export function bskyPostUrl(uri: string, handle: string): string | null {
  const m = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]+)$/.exec(uri);
  return m ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${m[1]}` : null;
}

const external = z.object({ uri: z.string(), title: z.string().nullish(), description: z.string().nullish() }).loose();
const facet = z
  .object({ features: z.array(z.object({ $type: z.string(), uri: z.string().optional() }).loose()) })
  .loose();
const feedEntry = z
  .object({
    post: z
      .object({
        uri: z.string(),
        author: z.object({ did: z.string(), handle: z.string(), displayName: z.string().nullish() }).loose(),
        record: z
          .object({
            text: z.string().default(""),
            createdAt: z.string().nullish(),
            reply: z.unknown().optional(),
            facets: z.array(facet).optional(),
            embed: z.object({ $type: z.string().optional(), external: external.optional() }).loose().optional(),
          })
          .loose(),
        embed: z.object({ $type: z.string().optional(), external: external.optional() }).loose().nullish(),
        indexedAt: z.string().nullish(),
        likeCount: z.number().nullish(),
        repostCount: z.number().nullish(),
      })
      .loose(),
    /** Present for reposts and pinned posts. */
    reason: z.unknown().optional(),
  })
  .loose();
const feedResponse = z.object({ feed: z.array(z.unknown()) }).loose();

export function parseBskyFeed(json: unknown, actor: string, config: SocialConfig, now = new Date()): NormalizedItem[] {
  const parsed = feedResponse.safeParse(json);
  if (!parsed.success) throw new SourceParseError("Bluesky: unexpected author feed response");
  const out = new Map<string, NormalizedItem>();
  for (const raw of parsed.data.feed) {
    const r = feedEntry.safeParse(raw);
    if (!r.success) continue;
    const { post, reason } = r.data;
    // Reposts and pins are someone else's post or a repeat; replies are conversation.
    if (reason !== undefined || post.record.reply !== undefined) continue;
    const author = post.author;
    if (author.did !== actor && author.handle.toLowerCase() !== actor) continue;
    const postUrl = bskyPostUrl(post.uri, author.handle);
    if (!postUrl) continue;

    const ext = post.embed?.external ?? post.record.embed?.external;
    const facetLinks = (post.record.facets ?? []).flatMap((f) =>
      f.features.filter((x) => x.$type === "app.bsky.richtext.facet#link").map((x) => x.uri),
    );
    const link = firstExternalLink([ext?.uri, ...facetLinks], INTERNAL_HOSTS);
    const item = socialItem(
      {
        externalId: post.uri,
        postUrl,
        text: post.record.text,
        link,
        // The preview only describes the link we chose if it came from the embed.
        linkTitle: link && ext && parseHttpUrl(ext.uri)?.href === link.href ? (ext.title ?? null) : null,
        linkDescription: link && ext && parseHttpUrl(ext.uri)?.href === link.href ? (ext.description ?? null) : null,
        author: author.displayName?.trim() || author.handle,
        publishedAt: parseDate(post.record.createdAt) ?? parseDate(post.indexedAt),
        extra: { handle: author.handle, likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0 },
      },
      config,
      "bluesky",
      now,
    );
    if (item) out.set(item.externalId, item);
  }
  return [...out.values()];
}

export const blueskyAdapter: SourceAdapter = {
  type: "bluesky",
  supportsBackfill: false,
  requestsPerFetch: () => 1,
  async fetch(source, ctx): Promise<FetchResult> {
    const actor = bskyActorFromUrl(source.url);
    if (!actor) throw new SourceParseError("Bluesky source URL must be a profile URL: https://bsky.app/profile/<handle>");
    const res = await getFrom(bskyFeedUrl(actor), ctx, { accept: "application/json" });
    assertOk(res);
    let json: unknown;
    try {
      json = JSON.parse(res.text());
    } catch {
      throw new SourceParseError("Bluesky: response is not JSON");
    }
    // The AppView has no conditional GET; items are deduped on the post URI.
    return { status: "ok", httpStatus: res.status, items: parseBskyFeed(json, actor, socialConfig(source), ctx.now) };
  },
};
