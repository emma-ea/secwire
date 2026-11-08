import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  feedHref,
  hasActiveFilters,
  parseFeedParams,
  searchAsCveId,
} from "@/feed/params";
import { describeRunResult, describeRunScope } from "@/lib/run-summary";
import { epssPercent, percentileLabel, severityFor } from "@/lib/severity";
import { parseSince } from "@/ingest/trigger-jobs";

describe("feed params (SPEC §8)", () => {
  it("defaults to the last 7 days, latest activity first", () => {
    expect(parseFeedParams({})).toEqual({
      range: "7d",
      kev: false,
      minCvss: null,
      category: null,
      source: null,
      vendor: null,
      q: null,
      sort: "recent",
      cursor: null,
    });
  });

  it("reads every filter and ignores junk", () => {
    expect(
      parseFeedParams({
        range: "24h",
        kev: "1",
        minCvss: "7",
        category: "news",
        source: "bleepingcomputer",
        vendor: " Microsoft ",
        q: "exchange",
        sort: "risk",
      }),
    ).toMatchObject({ range: "24h", kev: true, minCvss: 7, category: "news", source: "bleepingcomputer", vendor: "Microsoft", q: "exchange", sort: "risk" });
    expect(
      parseFeedParams({ range: "1y", kev: "maybe", minCvss: "11", category: "blogs", source: "../etc", sort: "random", q: "" }),
    ).toMatchObject({ range: "7d", kev: false, minCvss: null, category: null, source: null, sort: "recent", q: null });
    // Repeated params: first wins. Empty values from the GET form are ignored.
    expect(parseFeedParams({ range: ["30d", "24h"], minCvss: "", vendor: "" })).toMatchObject({ range: "30d", minCvss: null, vendor: null });
  });

  it("builds short, shareable URLs and resets the cursor when filters change", () => {
    const f = parseFeedParams({ q: "zero day", kev: "1", sort: "covered", cursor: "abc" });
    expect(feedHref(f)).toBe("/?q=zero+day&kev=1&sort=covered");
    expect(feedHref(f, { cursor: "next" })).toBe("/?q=zero+day&kev=1&sort=covered&cursor=next");
    expect(feedHref(parseFeedParams({}))).toBe("/");
    expect(hasActiveFilters(parseFeedParams({}))).toBe(false);
    expect(hasActiveFilters(parseFeedParams({ sort: "risk" }))).toBe(false);
    expect(hasActiveFilters(f)).toBe(true);
  });

  it("treats a search that is exactly a CVE id as a CVE lookup", () => {
    expect(searchAsCveId("cve-2024-3400")).toBe("CVE-2024-3400");
    expect(searchAsCveId(" CVE–2024–3400 ")).toBe("CVE-2024-3400");
    expect(searchAsCveId("CVE-2024-3400 exploited")).toBeNull();
    expect(searchAsCveId(null)).toBeNull();
  });

  it("round-trips cursors and rejects tampered or mismatched ones", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const ts = "2026-11-08 10:15:00.123456+00";
    const c = encodeCursor("risk", ["t", "0.97", "9.8", ts, id]);
    expect(decodeCursor("risk", c)).toEqual(["t", "0.97", "9.8", ts, id]);
    expect(decodeCursor("recent", c)).toBeNull();
    expect(decodeCursor("recent", encodeCursor("recent", [ts, id]))).toEqual([ts, id]);
    expect(decodeCursor("covered", encodeCursor("covered", ["12", ts, id]))).toEqual(["12", ts, id]);
    expect(decodeCursor("recent", "not-base64!")).toBeNull();
    expect(decodeCursor("recent", encodeCursor("recent", ["2026-13-45 10:15:00+00", id]))).toBeNull();
    expect(decodeCursor("recent", encodeCursor("recent", ["2026-11-08T10:15:00.123Z", id]))).not.toBeNull();
    expect(decodeCursor("recent", Buffer.from(JSON.stringify(["recent", "x'; DROP TABLE", id])).toString("base64url"))).toBeNull();
    expect(decodeCursor("risk", encodeCursor("risk", ["t", "1 OR 1=1" as string, "9.8", ts, id]))).toBeNull();
  });
});

describe("display helpers", () => {
  it.each([
    [9.8, "CRITICAL"],
    [9, "CRITICAL"],
    [8.9, "HIGH"],
    [7, "HIGH"],
    [5.5, "MEDIUM"],
    [0.1, "LOW"],
    [0, "NONE"],
    [null, null],
  ])("severityFor(%s) = %s", (score, sev) => {
    expect(severityFor(score)).toBe(sev);
  });

  it("formats EPSS percentiles and probabilities", () => {
    expect(percentileLabel(0.9734)).toBe("97th");
    expect(percentileLabel(0.01)).toBe("1st");
    expect(percentileLabel(0.12)).toBe("12th");
    expect(percentileLabel(0.22)).toBe("22nd");
    expect(percentileLabel(0.33998)).toBe("33rd");
    expect(percentileLabel(1)).toBe("100th");
    expect(percentileLabel(null)).toBeNull();
    expect(epssPercent(0.99999)).toBe(">99%");
    expect(epssPercent(0.94)).toBe("94%");
    expect(epssPercent(0.015)).toBe("1.5%");
    expect(epssPercent(0.00395)).toBe("0.4%");
    expect(epssPercent(0.0004)).toBe("<0.1%");
  });

  it("summarizes runs of every kind", () => {
    const run = (kind: string, scope: Record<string, unknown>, stats: Record<string, unknown>, status = "succeeded") => ({ kind, scope, stats, status });
    expect(describeRunScope(run("ingest", { sourceIds: "all" }, {}))).toBe("all enabled sources");
    expect(describeRunResult(run("ingest", {}, { sources: 3, itemsNew: 5 }))).toBe("3 sources · 5 new");
    expect(describeRunScope(run("enrich", { mode: "cve", cveId: "CVE-2024-3400" }, {}))).toBe("CVE-2024-3400");
    expect(describeRunResult(run("enrich", { mode: "cve" }, { nvd: "updated", cvssScore: 10, epssUpdated: 1 }))).toBe("CVSS 10 · EPSS 1");
    expect(describeRunResult(run("enrich", { mode: "refresh" }, { nvdQueued: 3, nvdTargets: 4, epssScored: 9, epssTargets: 10 }))).toBe(
      "NVD 3/4 · EPSS 9/10",
    );
    expect(describeRunScope(run("recluster", { since: "2026-10-01T00:00:00.000Z" }, {}))).toBe("since 2026-10-01");
    expect(describeRunResult(run("recluster", {}, { processed: 1, created: 1 }))).toBe("1 item → 1 new story");
    expect(describeRunResult(run("recluster", {}, {}, "queued"))).toBe("…");
  });
});

describe("parseSince", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  it("accepts dates and ISO timestamps in the past", () => {
    expect(parseSince("2026-10-01", now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseSince("2026-11-01T06:30:00Z", now).toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
  it.each(["yesterday", "2026-13-01", "", "2027-01-01", "1700000000"])("rejects %j", (s) => {
    expect(() => parseSince(s, now)).toThrow(/Invalid date/);
  });
});
