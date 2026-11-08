import { readFileSync } from "node:fs";
import path from "node:path";
import type { Fetcher, Source } from "@/ingest/adapters/types";
import type { SafeFetchOptions, SafeResponse } from "@/lib/safe-fetch";

export const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "../fixtures", name), "utf8");

export type FakeCall = { url: string; opts: SafeFetchOptions };

/** A Fetcher that serves canned responses and records every call. */
export function fakeFetcher(
  respond: (url: string, opts: SafeFetchOptions) => { status?: number; body?: string; headers?: Record<string, string> },
): Fetcher & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = (async (url: string, opts: SafeFetchOptions): Promise<SafeResponse> => {
    calls.push({ url, opts });
    const r = respond(url, opts);
    const body = Buffer.from(r.body ?? "");
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
      url,
      redirects: 0,
      body,
      text: () => body.toString("utf8"),
    };
  }) as Fetcher & { calls: FakeCall[] };
  fn.calls = calls;
  return fn;
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  const now = new Date("2026-11-08T12:00:00Z");
  return {
    id: "test",
    name: "Test",
    type: "rss",
    url: "https://feeds.example.com/rss",
    category: "news",
    enabled: true,
    minIntervalMinutes: null,
    config: {},
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
