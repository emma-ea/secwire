import { cisaKevAdapter } from "./cisa-kev";
import { hackerNewsAdapter } from "./hackernews";
import { rssAdapter } from "./rss";
import type { SourceAdapter, SourceType } from "./types";

const adapters: Record<SourceType, SourceAdapter> = {
  rss: rssAdapter,
  cisa_kev: cisaKevAdapter,
  hackernews: hackerNewsAdapter,
};

export function getAdapter(type: SourceType): SourceAdapter {
  return adapters[type];
}

export * from "./types";
