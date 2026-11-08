/**
 * Shared rules for social sources (Bluesky, Mastodon, X), Phase 3.
 *
 * A researcher's timeline is mostly conversation, so by default a post is
 * kept only when it is about security news: it mentions a CVE, or it links to
 * an outside page AND its text (or the link preview) matches a security
 * keyword. Like HN, an item's URL is the linked article when there is one, so
 * the post joins that article's story through clustering rule 1; the post's
 * own permalink goes in raw.postUrl. See DECISIONS.md.
 */
import { z } from "zod";
import { extractCveIdsFrom } from "../../lib/cve";
import { truncate } from "../../lib/text";
import { parseHttpUrl } from "../../lib/url";
import { titleMatchesQuery } from "./hackernews";
import type { NormalizedItem, Source } from "./types";

export const SOCIAL_TITLE_MAX = 140;
/** Older posts are ignored, so a new account's first sync doesn't backfill months of timeline. */
export const SOCIAL_LOOKBACK_DAYS = 14;

/** Whole-word matches (plurals allowed, see titleMatchesQuery); inflections are listed explicitly. */
export const SECURITY_KEYWORDS = [
  "CVE",
  "vulnerability",
  "vulnerabilities",
  "vuln",
  "zero-day",
  "0day",
  "exploit",
  "exploited",
  "exploitation",
  "RCE",
  "ransomware",
  "breach",
  "breached",
  "hack",
  "hacked",
  "hacker",
  "hacking",
  "malware",
  "infostealer",
  "stealer",
  "trojan",
  "backdoor",
  "backdoored",
  "spyware",
  "botnet",
  "phishing",
  "cyberattack",
  "DDoS",
  "APT",
  "threat actor",
  "supply chain attack",
  "compromised",
  "data leak",
  "leaked",
  "security flaw",
  "security update",
  "patch",
  "patched",
  "advisory",
  "CISA",
  "KEV",
];

const configSchema = z
  .object({
    filter: z.enum(["relevant", "all"]).optional(),
    keywords: z.array(z.string().min(1)).min(1).optional(),
  })
  .loose();

export type SocialConfig = { filter: "relevant" | "all"; keywords: string[] };

export function socialConfig(source: Pick<Source, "config">): SocialConfig {
  const c = configSchema.safeParse(source.config ?? {});
  const data = c.success ? c.data : {};
  return { filter: data.filter ?? "relevant", keywords: data.keywords ?? SECURITY_KEYWORDS };
}

export function matchesKeywords(text: string, keywords: string[]): boolean {
  return keywords.some((k) => titleMatchesQuery(text, k));
}

/** A bare URL as written in a post ("https://x.com/a", "example.com/path…"). */
const URL_WORD_RE = /^(?:https?:\/\/\S+|(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*)$/i;

/** First paragraph/line of a post, without bare URLs, as a one-line title. */
export function postTitle(text: string): string {
  const first = text
    .split(/\n+/)
    .map((l) =>
      l
        .split(/\s+/)
        .filter((w) => !URL_WORD_RE.test(w))
        .join(" ")
        .trim(),
    )
    .find(Boolean);
  return first ? truncate(first, SOCIAL_TITLE_MAX) : "";
}

/**
 * The first link in a post that points away from the network itself
 * (profiles, hashtags, quoted posts and media hosts on the same platform
 * aren't articles).
 */
export function firstExternalLink(candidates: Array<string | null | undefined>, internalHosts: string[]): URL | null {
  const internal = internalHosts.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const u = parseHttpUrl(c);
    if (!u) continue;
    const host = u.hostname.toLowerCase();
    if (internal.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    return u;
  }
  return null;
}

export type SocialPost = {
  externalId: string;
  /** The post's own permalink. */
  postUrl: string;
  /** Plain text of the post (newlines kept between paragraphs). */
  text: string;
  /** First external link, if any. */
  link: URL | null;
  /** Link preview title/description when the platform provides one (matched, not displayed). */
  linkTitle?: string | null;
  linkDescription?: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** Extra platform fields for raw. */
  extra?: Record<string, unknown>;
};

/** Applies the relevance filter and maps a post to an item; null when the post is dropped. */
export function socialItem(post: SocialPost, config: SocialConfig, network: string, now = new Date()): NormalizedItem | null {
  if (post.publishedAt && now.getTime() - post.publishedAt.getTime() > SOCIAL_LOOKBACK_DAYS * 86_400_000) return null;
  const flat = post.text.replace(/\s+/g, " ").trim();
  const preview = [post.linkTitle, post.linkDescription].filter(Boolean).join(" ");
  // Links count: a CVE id in a linked advisory URL is still about that CVE.
  const cveIds = extractCveIdsFrom([flat, post.link?.href ?? null, preview || null], now);
  if (config.filter === "relevant") {
    const relevant = cveIds.length > 0 || (post.link !== null && matchesKeywords(`${flat} ${preview}`, config.keywords));
    if (!relevant) return null;
  }
  const title = postTitle(post.text) || postTitle(post.linkTitle ?? "");
  if (!title) return null;
  return {
    externalId: post.externalId,
    url: post.link?.href ?? post.postUrl,
    title,
    excerpt: flat ? truncate(flat) : null,
    author: post.author,
    publishedAt: post.publishedAt,
    cveIds,
    raw: {
      network,
      postUrl: post.postUrl,
      ...(post.link ? { linkUrl: post.link.href } : {}),
      ...(post.linkTitle ? { linkTitle: truncate(post.linkTitle, 300) } : {}),
      ...post.extra,
    },
  };
}
