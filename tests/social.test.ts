import { describe, expect, it } from "vitest";
import { blueskyAdapter, bskyActorFromUrl, bskyFeedUrl, bskyPostUrl, parseBskyFeed } from "@/ingest/adapters/bluesky";
import { mastodonAdapter, mastodonFeedUrl, parseMastodonFeed, postLinks, postText } from "@/ingest/adapters/mastodon";
import { firstExternalLink, matchesKeywords, postTitle, socialConfig, SECURITY_KEYWORDS } from "@/ingest/adapters/social";
import { SourceParseError } from "@/ingest/adapters/types";
import { fakeFetcher, fixture, makeSource } from "./helpers/fake-fetch";

const NOW = new Date("2026-11-08T12:00:00Z");
const ctx = (extra: Record<string, unknown> = {}) => ({ force: false, signal: new AbortController().signal, now: NOW, ...extra });
const relevant = socialConfig({ config: {} });

describe("social relevance rules", () => {
  it("matches security keywords as whole words", () => {
    expect(matchesKeywords("Vendor hacked to push malicious update", SECURITY_KEYWORDS)).toBe(true);
    expect(matchesKeywords("Ransomware gang hits hospitals", SECURITY_KEYWORDS)).toBe(true);
    expect(matchesKeywords("Chrome zero-day exploited", SECURITY_KEYWORDS)).toBe(true);
    expect(matchesKeywords("Great long read about warehouse robots", SECURITY_KEYWORDS)).toBe(false);
    expect(matchesKeywords("Shacking up in Hackney", SECURITY_KEYWORDS)).toBe(false);
  });

  it("titles are the first non-empty line, truncated", () => {
    expect(postTitle("\n  First line here \nsecond")).toBe("First line here");
    expect([...postTitle("word ".repeat(100))].length).toBeLessThanOrEqual(140);
    expect(postTitle("   ")).toBe("");
    expect(postTitle("Vendor confirms breach www.example.com/sec... https://t.co/x")).toBe("Vendor confirms breach");
    expect(postTitle("https://example.com/only\nSecond line")).toBe("Second line");
  });

  it("skips links to the network itself", () => {
    expect(firstExternalLink(["https://bsky.app/profile/x", "javascript:alert(1)", "https://example.com/a"], ["bsky.app"])?.href).toBe(
      "https://example.com/a",
    );
    expect(firstExternalLink(["https://media.infosec.exchange/x.png"], ["infosec.exchange"])).toBeNull();
  });

  it("config: filter defaults to relevant; custom keywords", () => {
    expect(socialConfig({ config: {} }).filter).toBe("relevant");
    expect(socialConfig({ config: { filter: "all", keywords: ["kubernetes"] } })).toEqual({ filter: "all", keywords: ["kubernetes"] });
    expect(socialConfig({ config: { filter: "bogus" } }).filter).toBe("relevant");
  });
});

describe("Bluesky adapter", () => {
  it("parses profile URLs", () => {
    expect(bskyActorFromUrl("https://bsky.app/profile/Researcher.Example.com")).toBe("researcher.example.com");
    expect(bskyActorFromUrl("https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/")).toBe("did:plc:abcdefghijklmnopqrstuvwx");
    expect(bskyActorFromUrl("https://bsky.app/profile/x/post/1")).toBeNull();
    expect(bskyActorFromUrl("https://evil.example/profile/a.b")).toBeNull();
    expect(bskyActorFromUrl("https://bsky.app/profile/..%2F..")).toBeNull();
    expect(bskyFeedUrl("a.bsky.social")).toBe(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=a.bsky.social&filter=posts_no_replies&limit=50",
    );
    expect(bskyPostUrl("at://did:plc:abc/app.bsky.feed.post/3kaaa", "a.bsky.social")).toBe("https://bsky.app/profile/a.bsky.social/post/3kaaa");
    expect(bskyPostUrl("at://did:plc:abc/app.bsky.feed.like/3kaaa", "a")).toBeNull();
  });

  it("keeps CVE posts and on-topic links; drops reposts, replies, off-topic and self links", () => {
    const items = parseBskyFeed(JSON.parse(fixture("bsky-author-feed.json")), "researcher.example.com", relevant, NOW);
    expect(items.map((i) => i.externalId.split("/").pop())).toEqual([
      "3kaaa0000001",
      "3kaaa0000003",
      "3kaaa0000006",
      "3kaaa0000007",
      "3kaaa0000009",
    ]);
    const [ransom, cve, newByMe, facet, nvd] = items;
    // Linked article becomes the item URL (joins the article's story via rule 1); permalink in raw.
    expect(ransom).toMatchObject({
      url: "https://news.example.com/2026/11/hospital-ransomware?utm_source=bsky",
      title: "Ransomware gang hits a hospital chain across three states",
      author: "Ada Researcher",
      publishedAt: new Date("2026-11-08T09:00:00.000Z"),
      raw: { network: "bluesky", postUrl: "https://bsky.app/profile/researcher.example.com/post/3kaaa0000001", handle: "researcher.example.com" },
    });
    expect(ransom!.excerpt).toBe("Ransomware gang hits a hospital chain across three states More details in the story.");
    expect(cve).toMatchObject({ url: "https://bsky.app/profile/researcher.example.com/post/3kaaa0000003", cveIds: ["CVE-2026-12345"] });
    expect(newByMe).toMatchObject({ title: "New by me:", url: "https://blog.example.net/vendor-hacked" });
    expect(facet).toMatchObject({ url: "https://www.example.com/security/incident-2026", title: "Vendor confirms breach of customer support portal" });
    expect(nvd!.cveIds).toEqual(["CVE-2026-99999"]);
  });

  it("filter: all keeps every original post", () => {
    const items = parseBskyFeed(JSON.parse(fixture("bsky-author-feed.json")), "researcher.example.com", { ...relevant, filter: "all" }, NOW);
    expect(items).toHaveLength(7); // 9 minus the repost and the reply
  });

  it("fetches through the public AppView without conditional headers", async () => {
    const f = fakeFetcher(() => ({ body: fixture("bsky-author-feed.json") }));
    const r = await blueskyAdapter.fetch(makeSource({ type: "bluesky", url: "https://bsky.app/profile/researcher.example.com", etag: "x" }), ctx({ fetcher: f }));
    expect(r.status === "ok" && r.items.length).toBe(5);
    expect(f.calls[0]!.url).toContain("actor=researcher.example.com");
    expect(f.calls[0]!.opts.headers).not.toHaveProperty("if-none-match");
  });

  it("rejects non-profile URLs and junk responses", async () => {
    await expect(blueskyAdapter.fetch(makeSource({ type: "bluesky", url: "https://example.com/feed" }), ctx())).rejects.toBeInstanceOf(SourceParseError);
    const f = fakeFetcher(() => ({ body: '{"error":"x"}' }));
    await expect(
      blueskyAdapter.fetch(makeSource({ type: "bluesky", url: "https://bsky.app/profile/a.bsky.social" }), ctx({ fetcher: f })),
    ).rejects.toBeInstanceOf(SourceParseError);
  });
});

describe("Mastodon adapter", () => {
  it("derives the RSS URL from the account URL", () => {
    expect(mastodonFeedUrl("https://infosec.exchange/@wdormann")).toBe("https://infosec.exchange/@wdormann.rss");
    expect(mastodonFeedUrl("https://infosec.exchange/@wdormann.rss")).toBe("https://infosec.exchange/@wdormann.rss");
    expect(mastodonFeedUrl("https://infosec.exchange/@wdormann/")).toBe("https://infosec.exchange/@wdormann.rss");
    expect(mastodonFeedUrl("https://infosec.exchange/users/wdormann")).toBeNull();
    expect(mastodonFeedUrl("https://infosec.exchange/@a?x=1")).toBeNull();
  });

  it("extracts links but not mentions or hashtags; keeps paragraph breaks", () => {
    const html =
      '<p>Hi <a href="https://i.example/@bob" class="u-url mention">@bob</a> <a href="https://i.example/tags/x" class="mention hashtag" rel="tag">#x</a></p><p><a href="https://news.example.com/a?x=1&amp;y=2">link</a></p>';
    expect(postLinks(html)).toEqual(["https://news.example.com/a?x=1&y=2"]);
    expect(postText(html)).toBe("Hi @bob #x\nlink");
  });

  it("keeps CVE posts and on-topic links; drops chatter and mention-only posts", async () => {
    const items = await parseMastodonFeed(fixture("mastodon-account.rss"), "https://infosec.example/@grace.rss", relevant, NOW);
    // 1002 chatter, 1004 mention-only, 1005 quote of a post (not an article), 0900 too old.
    expect(items.map((i) => i.externalId)).toEqual([
      "https://infosec.example/@grace/1001",
      "https://infosec.example/@grace/1003",
      "https://infosec.example/@grace/1006",
    ]);
    expect(items[2]).toMatchObject({ title: "This one is real: CVE-2026-55555 exploited", url: "https://infosec.example/@grace/1006" });
    expect(items[0]).toMatchObject({
      url: "https://diary.example.org/33498",
      title: "Scans for OpenSSH flaw (CVE-2026-12345)",
      cveIds: ["CVE-2026-12345"],
      author: "Grace Analyst",
      raw: { network: "mastodon", postUrl: "https://infosec.example/@grace/1001" },
    });
    expect(items[1]).toMatchObject({ url: "https://news.example.com/2026/11/botnet-takedown/", title: "New, from me: botnet of 1.3M TV boxes dismantled" });
  });

  it("uses conditional GET and handles 304", async () => {
    const f = fakeFetcher(() => ({ status: 304 }));
    const r = await mastodonAdapter.fetch(makeSource({ type: "mastodon", url: "https://infosec.example/@grace", etag: 'W/"abc"' }), ctx({ fetcher: f }));
    expect(r.status).toBe("not_modified");
    expect(f.calls[0]!.url).toBe("https://infosec.example/@grace.rss");
    expect(f.calls[0]!.opts.headers).toMatchObject({ "if-none-match": 'W/"abc"' });
  });
});
