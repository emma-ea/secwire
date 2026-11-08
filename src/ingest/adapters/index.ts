import { blueskyAdapter } from "./bluesky";
import { cisaKevAdapter } from "./cisa-kev";
import { hackerNewsAdapter } from "./hackernews";
import { mastodonAdapter } from "./mastodon";
import { rssAdapter } from "./rss";
import { xAdapter } from "./x";
import type { SourceAdapter, SourceType } from "./types";

const adapters: Record<SourceType, SourceAdapter> = {
  rss: rssAdapter,
  cisa_kev: cisaKevAdapter,
  hackernews: hackerNewsAdapter,
  bluesky: blueskyAdapter,
  mastodon: mastodonAdapter,
  x: xAdapter,
};

export function getAdapter(type: SourceType): SourceAdapter {
  return adapters[type];
}

export * from "./types";
