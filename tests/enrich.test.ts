import { describe, expect, it } from "vitest";
import { EPSS_BATCH_SIZE, epssUrl, fetchEpss, parseEpssResponse } from "@/ingest/enrich/epss";
import { fetchNvdCve, NvdHttpError, nvdUrl, parseNvdResponse, pickCvss, vendorFromCpe } from "@/ingest/enrich/nvd";
import { NVD_BACKOFF_MS, nvdSpacingMs, Throttle, type Clock } from "@/ingest/enrich/throttle";
import { fakeFetcher, fixture } from "./helpers/fake-fetch";

const json = (name: string) => JSON.parse(fixture(name)) as unknown;

describe("NVD parsing (SPEC §6.6)", () => {
  it("reads CVE-2024-3400: NVD's Primary v3.1 score, CNA vendor names, CWEs", () => {
    const r = parseNvdResponse(json("nvd-cve-2024-3400.json"), "CVE-2024-3400")!;
    expect(r).toMatchObject({
      id: "CVE-2024-3400",
      status: "Analyzed",
      cvss: {
        score: 10,
        version: "3.1",
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
        severity: "CRITICAL",
      },
      vendor: "Palo Alto Networks",
      product: "PAN-OS",
      cweIds: ["CWE-20", "CWE-77"],
    });
    expect(r.publishedAt?.toISOString()).toBe("2024-04-12T08:15:06.230Z");
    expect(r.description).toMatch(/command injection/i);
  });

  it("prefers CVSS v4 over v3.1, even when v3.1 is NVD's Primary", () => {
    const r = parseNvdResponse(json("nvd-v4-and-v31.json"), "CVE-2025-71458")!;
    expect(r.cvss).toMatchObject({ score: 8.7, version: "4.0", severity: "HIGH" });
    expect(r.cvss?.vector).toMatch(/^CVSS:4\.0\//);
  });

  it("records a CVE NVD hasn't scored yet (no CVSS, still a result)", () => {
    const r = parseNvdResponse(json("nvd-no-metrics.json"), "CVE-2026-99271")!;
    expect(r).toMatchObject({ id: "CVE-2026-99271", status: "Received", cvss: null, vendor: "Linux", product: "Linux" });
  });

  it("treats placeholder vendor names as unknown", () => {
    const r = parseNvdResponse(json("nvd-unknown-vendor.json"), "CVE-2026-110955")!;
    expect(r.vendor).toBeNull();
    expect(r.cvss?.score).toBe(9.8);
  });

  it("returns null when NVD has no record", () => {
    expect(parseNvdResponse(json("nvd-not-found.json"), "CVE-2026-9999999")).toBeNull();
    // A record for a different id doesn't count.
    expect(parseNvdResponse(json("nvd-cve-2024-3400.json"), "CVE-2024-3401")).toBeNull();
  });

  it("rejects responses that aren't NVD's shape", () => {
    expect(() => parseNvdResponse({ hello: 1 }, "CVE-2024-3400")).toThrow(/unexpected/);
  });

  it("orders versions v4 → v3.1 → v3.0 and prefers Primary within a version", () => {
    const m = (score: number, type: string, version: string) => ({
      source: "x",
      type,
      cvssData: { version, baseScore: score, baseSeverity: "HIGH", vectorString: `CVSS:${version}/…` },
    });
    expect(pickCvss({ cvssMetricV30: [m(5, "Primary", "3.0")], cvssMetricV31: [m(7, "Secondary", "3.1")] })?.score).toBe(7);
    expect(pickCvss({ cvssMetricV31: [m(7, "Secondary", "3.1"), m(8, "Primary", "3.1")] })?.score).toBe(8);
    expect(pickCvss({ cvssMetricV2: [m(9, "Primary", "2.0")] })).toBeNull();
    expect(pickCvss(undefined)).toBeNull();
  });

  it("derives vendor/product from a CPE", () => {
    expect(vendorFromCpe("cpe:2.3:o:paloaltonetworks:pan-os:10.2.0:-:*:*:*:*:*:*")).toEqual({
      vendor: "paloaltonetworks",
      product: "pan-os",
    });
    expect(vendorFromCpe("cpe:2.3:a:apache_software:http_server:*:*")).toEqual({
      vendor: "apache software",
      product: "http server",
    });
    expect(vendorFromCpe("nope")).toEqual({ vendor: null, product: null });
  });

  it("sends the API key header only when set, and maps errors", async () => {
    const f = fakeFetcher(() => ({ body: fixture("nvd-cve-2024-3400.json") }));
    await fetchNvdCve("CVE-2024-3400", { fetcher: f });
    await fetchNvdCve("CVE-2024-3400", { fetcher: f, apiKey: "k" });
    expect(f.calls[0]!.url).toBe(nvdUrl("CVE-2024-3400"));
    expect(f.calls[0]!.opts.headers).not.toHaveProperty("apiKey");
    expect(f.calls[1]!.opts.headers).toHaveProperty("apiKey", "k");

    for (const status of [403, 429, 503]) {
      const err = await fetchNvdCve("CVE-2024-3400", { fetcher: fakeFetcher(() => ({ status })) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NvdHttpError);
      expect((err as NvdHttpError).isRateLimit).toBe(true);
    }
    const nf = await fetchNvdCve("CVE-2024-3400", { fetcher: fakeFetcher(() => ({ status: 404 })) }).catch((e: unknown) => e);
    expect((nf as NvdHttpError).isRetryable).toBe(false);
  });
});

describe("EPSS (SPEC §6.6)", () => {
  it("parses string-encoded scores and skips unknown CVEs", () => {
    const m = parseEpssResponse(json("epss-batch.json"));
    expect(m.size).toBe(3);
    expect(m.get("CVE-2025-71458")).toEqual({ score: 0.00395, percentile: 0.33998, date: "2026-11-08" });
    expect(m.get("CVE-2024-3400")?.percentile).toBe(1);
    expect(m.has("CVE-2026-9999999")).toBe(false);
  });

  it("drops rows with out-of-range values", () => {
    const m = parseEpssResponse({ data: [{ cve: "CVE-2026-0001", epss: "1.5", percentile: "0.2" }, { cve: "CVE-2026-0002", epss: 0.1, percentile: 0.2 }] });
    expect([...m.keys()]).toEqual(["CVE-2026-0002"]);
  });

  it("batches at most 100 CVEs per request", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `CVE-2026-${String(10000 + i)}`);
    const f = fakeFetcher(() => ({ body: JSON.stringify({ data: [] }) }));
    await fetchEpss([...ids, ids[0]!], { fetcher: f });
    expect(f.calls).toHaveLength(3);
    const sizes = f.calls.map((c) => new URL(c.url).searchParams.get("cve")!.split(",").length);
    expect(sizes).toEqual([EPSS_BATCH_SIZE, EPSS_BATCH_SIZE, 50]);
    expect(epssUrl(["CVE-2026-0001", "CVE-2026-0002"])).toBe(
      "https://api.first.org/data/v1/epss?cve=CVE-2026-0001%2CCVE-2026-0002",
    );
  });
});

/** A clock whose sleep() advances time instantly and records each wait. */
function fakeClock(start = 0): Clock & { waits: number[]; t: number } {
  const c = {
    t: start,
    waits: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.waits.push(ms);
      c.t += ms;
    },
  };
  return c;
}

describe("NVD throttle", () => {
  it("spaces requests: 5 per 30s without a key, 50 with one", () => {
    expect(30_000 / nvdSpacingMs(false)).toBeLessThanOrEqual(5);
    expect(30_000 / nvdSpacingMs(true)).toBeLessThanOrEqual(50);
  });

  it("lets the first request through and spaces the rest", async () => {
    const clock = fakeClock(1_000_000);
    const t = new Throttle(6_500, clock);
    await t.wait();
    await t.wait();
    await t.wait();
    expect(clock.waits).toEqual([6_500, 6_500]);
  });

  it("serializes concurrent waiters into consecutive slots", async () => {
    const clock = fakeClock(0);
    const t = new Throttle(1_000, clock);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map(() => t.wait().then(() => order.push(clock.now()))));
    expect(order).toEqual([0, 1_000, 2_000]);
  });

  it("backs off on rate limits, doubling up to the max, and resets on success", async () => {
    const clock = fakeClock(0);
    const t = new Throttle(6_500, clock);
    await t.wait();
    expect(t.penalize()).toBe(NVD_BACKOFF_MS.initial);
    await t.wait();
    expect(clock.waits.at(-1)).toBe(NVD_BACKOFF_MS.initial);
    expect(t.penalize()).toBe(NVD_BACKOFF_MS.initial * 2);
    for (let i = 0; i < 10; i++) t.penalize();
    expect(t.currentBackoffMs).toBe(NVD_BACKOFF_MS.max);
    t.succeeded();
    expect(t.penalize()).toBe(NVD_BACKOFF_MS.initial);
  });

  it("an aborted waiter doesn't block the queue", async () => {
    const t = new Throttle(10_000); // real clock
    await t.wait();
    const ac = new AbortController();
    const p = t.wait(ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
