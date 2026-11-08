import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({ getEnv: () => ({ FETCH_USER_AGENT: "SecWire/test", X_POST_READ_USD: 0.005 }) }));

const { X_SEARCH_URL, parseXSearch, xAdapter, xConfig, xQuery, xSearchUrl, xStartTime } = await import("@/ingest/adapters/x");
const { capBlockReason, monthKey } = await import("@/ingest/spend");
const { socialConfig } = await import("@/ingest/adapters/social");
const { SourceHttpError, SourceParseError } = await import("@/ingest/adapters/types");
const { fakeFetcher, fixture, makeSource } = await import("./helpers/fake-fetch");

const NOW = new Date("2026-11-08T12:00:00Z");
const source = (config: Record<string, unknown> = { accounts: ["alice", "bob"] }, extra = {}) =>
  makeSource({ type: "x", url: X_SEARCH_URL, config, ...extra });

describe("X config and request", () => {
  it("validates accounts and maxResults", () => {
    expect(xConfig({ config: { accounts: ["alice"] } })).toMatchObject({ accounts: ["alice"], maxResults: 20, filter: "relevant" });
    expect(xConfig({ config: { accounts: ["a_b"], maxResults: 100, filter: "all" } })).toMatchObject({ maxResults: 100, filter: "all" });
    for (const bad of [{}, { accounts: [] }, { accounts: ["bad name"] }, { accounts: ["a"], maxResults: 5 }, { accounts: Array(26).fill("a") }]) {
      expect(() => xConfig({ config: bad })).toThrow(SourceParseError);
    }
  });

  it("builds one query per account, pre-filtered server-side", () => {
    expect(xQuery("alice", "relevant")).toBe("from:alice -is:retweet -is:reply (has:links OR CVE)");
    expect(xQuery("alice", "all")).toBe("from:alice -is:retweet -is:reply");
    const u = new URL(xSearchUrl("alice", xConfig({ config: { accounts: ["alice"] } }), "2026-11-08T11:00:00Z"));
    expect(u.origin + u.pathname).toBe(X_SEARCH_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ max_results: "20", start_time: "2026-11-08T11:00:00Z", "tweet.fields": "created_at,entities,note_tweet" });
  });

  it("start_time: 24h on first run, last success minus 10 min, never beyond the 7-day window", () => {
    expect(xStartTime(null, NOW)).toBe("2026-11-07T12:00:00Z");
    expect(xStartTime(new Date("2026-11-08T11:00:00Z"), NOW)).toBe("2026-11-08T10:50:00Z");
    expect(xStartTime(new Date("2026-10-01T00:00:00Z"), NOW)).toBe("2026-11-01T12:05:00Z");
  });

  it("worst-case cost = accounts × maxResults × price; misconfigured sources cost 0", () => {
    expect(xAdapter.paid!.maxCostPerFetchUsd({ config: { accounts: ["a", "b"], maxResults: 20 } })).toBeCloseTo(0.2);
    expect(xAdapter.costPerRequestUsd!({ config: { accounts: ["a"], maxResults: 10 } })).toBeCloseTo(0.05);
    expect(xAdapter.requestsPerFetch({ config: { accounts: ["a", "b", "c"] } })).toBe(3);
    expect(xAdapter.paid!.maxCostPerFetchUsd({ config: {} })).toBe(0);
  });
});

describe("X parsing", () => {
  it("keeps on-topic posts, bills every post returned", () => {
    const { items, billable } = parseXSearch(JSON.parse(fixture("x-search.json")), "alice", socialConfig({ config: {} }), NOW);
    expect(billable).toBe(4);
    expect(items.map((i) => i.externalId)).toEqual(["1855000000000000001", "1855000000000000003"]);
    expect(items[0]).toMatchObject({
      url: "https://news.example.com/2026/11/ivanti-zero-day",
      title: "Ivanti zero-day exploited against VPN appliances",
      author: "@alice",
      excerpt: "Ivanti zero-day exploited against VPN appliances news.example.com/2026/11/ivan…",
      raw: { network: "x", postUrl: "https://x.com/alice/status/1855000000000000001", linkTitle: "Ivanti zero-day exploited" },
    });
    expect(items[1]).toMatchObject({ url: "https://x.com/alice/status/1855000000000000003", cveIds: ["CVE-2026-12345"] });
  });

  it("an empty result costs nothing", () => {
    expect(parseXSearch({ meta: { result_count: 0 } }, "alice", socialConfig({ config: {} }), NOW)).toEqual({ items: [], billable: 0 });
    expect(() => parseXSearch([], "alice", socialConfig({ config: {} }), NOW)).toThrow(SourceParseError);
  });
});

describe("X adapter fetch", () => {
  const ctx = (extra: Record<string, unknown> = {}) => ({
    force: false,
    signal: new AbortController().signal,
    now: NOW,
    x: { bearerToken: "test-token", postReadUsd: 0.005 },
    ...extra,
  });

  it("sends the bearer token to api.x.com only and reports usage per request", async () => {
    const f = fakeFetcher(() => ({ body: fixture("x-search.json") }));
    const usage: unknown[] = [];
    const r = await xAdapter.fetch(source(), ctx({ fetcher: f, trackUsage: (u: unknown) => usage.push(u) }));
    expect(f.calls.map((c) => new URL(c.url).searchParams.get("query"))).toEqual([
      "from:alice -is:retweet -is:reply (has:links OR CVE)",
      "from:bob -is:retweet -is:reply (has:links OR CVE)",
    ]);
    expect(f.calls.every((c) => c.url.startsWith(`${X_SEARCH_URL}?`) && c.opts.headers?.authorization === "Bearer test-token")).toBe(true);
    expect(usage).toEqual([{ requests: 1 }, { units: 4, usd: 0.02 }, { requests: 1 }, { units: 4, usd: 0.02 }]);
    // Same post ids for both accounts in the fixture → deduped.
    expect(r.status === "ok" && r.items.length).toBe(2);
  });

  it("refuses other URLs (the token must never go elsewhere) and missing credentials", async () => {
    const f = fakeFetcher(() => ({ body: "{}" }));
    await expect(xAdapter.fetch(source(undefined, { url: "https://evil.example/2/tweets/search/recent" }), ctx({ fetcher: f }))).rejects.toThrow(
      SourceParseError,
    );
    await expect(xAdapter.fetch(source(), ctx({ fetcher: f, x: undefined }))).rejects.toThrow(/credentials/);
    expect(f.calls).toHaveLength(0);
  });

  it("a 429 surfaces as a retryable HTTP error after counting the request", async () => {
    const usage: unknown[] = [];
    const f = fakeFetcher(() => ({ status: 429, body: "{}" }));
    await expect(xAdapter.fetch(source(), ctx({ fetcher: f, trackUsage: (u: unknown) => usage.push(u) }))).rejects.toBeInstanceOf(SourceHttpError);
    expect(usage).toEqual([{ requests: 1 }]);
  });
});

describe("spend helpers", () => {
  it("month key is UTC", () => {
    expect(monthKey(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(monthKey(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
  it("refuses a call whose worst case would cross the cap", () => {
    expect(capBlockReason("X API", 9.5, 0.5, 10)).toBeNull();
    expect(capBlockReason("X API", 9.6, 0.5, 10)).toBe("X API monthly spend cap reached: $9.60 spent of $10.00, this call could cost up to $0.50");
    expect(capBlockReason("X API", 0, 0.01, 0)).not.toBeNull();
  });
});
