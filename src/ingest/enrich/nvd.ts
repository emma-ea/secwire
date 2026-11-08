/**
 * NVD CVE API 2.0 client (SPEC §6.6). Pure: fetches through an injectable
 * fetcher and returns parsed data; persistence lives in ./service.ts.
 */
import { z } from "zod";
import { normalizeCveId } from "../../lib/cve";
import { safeFetch } from "../../lib/safe-fetch";
import type { Fetcher } from "../adapters/types";

export const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";

/** HTTP statuses NVD uses for rate limiting / overload. Back off, then retry. */
export const NVD_BACKOFF_STATUSES = [403, 429, 503] as const;

export class NvdHttpError extends Error {
  constructor(public readonly httpStatus: number) {
    super(`NVD responded with HTTP ${httpStatus}`);
    this.name = "NvdHttpError";
  }
  /** True for rate-limit responses (403/429/503): the caller should back off. */
  get isRateLimit(): boolean {
    return (NVD_BACKOFF_STATUSES as readonly number[]).includes(this.httpStatus);
  }
  get isRetryable(): boolean {
    return this.isRateLimit || this.httpStatus >= 500 || this.httpStatus === 408;
  }
}

export class NvdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvdParseError";
  }
}

const cvssData = z
  .object({
    version: z.string().optional(),
    vectorString: z.string().optional(),
    baseScore: z.number(),
    baseSeverity: z.string().optional(),
  })
  .loose();

const metric = z
  .object({
    source: z.string().optional(),
    type: z.string().optional(),
    cvssData,
    // v2 keeps severity outside cvssData.
    baseSeverity: z.string().optional(),
  })
  .loose();

const cveSchema = z
  .object({
    id: z.string(),
    published: z.string().optional(),
    vulnStatus: z.string().optional(),
    descriptions: z.array(z.object({ lang: z.string(), value: z.string() }).loose()).optional(),
    metrics: z.record(z.string(), z.array(z.unknown())).optional(),
    weaknesses: z
      .array(
        z
          .object({
            type: z.string().optional(),
            description: z.array(z.object({ lang: z.string(), value: z.string() }).loose()).optional(),
          })
          .loose(),
      )
      .optional(),
    affected: z
      .array(
        z
          .object({
            affectedData: z
              .array(z.object({ vendor: z.string().optional(), product: z.string().optional() }).loose())
              .optional(),
          })
          .loose(),
      )
      .optional(),
    configurations: z
      .array(
        z
          .object({
            nodes: z
              .array(
                z
                  .object({
                    cpeMatch: z
                      .array(z.object({ vulnerable: z.boolean().optional(), criteria: z.string() }).loose())
                      .optional(),
                  })
                  .loose(),
              )
              .optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

const responseSchema = z
  .object({
    totalResults: z.number(),
    vulnerabilities: z.array(z.object({ cve: z.unknown() }).loose()),
  })
  .loose();

export type Cvss = { score: number; version: string; vector: string | null; severity: string | null };

export type NvdCve = {
  id: string;
  status: string | null;
  description: string | null;
  publishedAt: Date | null;
  cvss: Cvss | null;
  vendor: string | null;
  product: string | null;
  cweIds: string[];
};

/** SPEC §5: prefer CVSS v4, then v3.1, then v3.0. Within a version, NVD's own ("Primary") score wins. */
const CVSS_PREFERENCE = [
  ["cvssMetricV40", "4.0"],
  ["cvssMetricV31", "3.1"],
  ["cvssMetricV30", "3.0"],
] as const;

export function pickCvss(metrics: Record<string, unknown[]> | undefined): Cvss | null {
  if (!metrics) return null;
  for (const [key, version] of CVSS_PREFERENCE) {
    const parsed = (metrics[key] ?? [])
      .map((m) => metric.safeParse(m))
      .filter((r) => r.success)
      .map((r) => r.data);
    if (!parsed.length) continue;
    const chosen = parsed.find((m) => m.type === "Primary") ?? parsed[0]!;
    const score = Math.round(chosen.cvssData.baseScore * 10) / 10;
    if (!(score >= 0 && score <= 10)) continue;
    return {
      score,
      version: chosen.cvssData.version ?? version,
      vector: chosen.cvssData.vectorString ?? null,
      severity: (chosen.cvssData.baseSeverity ?? chosen.baseSeverity)?.toUpperCase() ?? null,
    };
  }
  return null;
}

/** Placeholder vendor names CNAs use when they don't know. */
const UNKNOWN_NAMES = new Set(["", "unknown", "n/a", "na", "none", "-", "*"]);
const known = (s: string | undefined | null): string | null => {
  const v = s?.trim();
  return v && !UNKNOWN_NAMES.has(v.toLowerCase()) ? v.slice(0, 200) : null;
};

/** "cpe:2.3:o:paloaltonetworks:pan-os:10.2.0:..." → vendor/product with underscores as spaces. */
export function vendorFromCpe(criteria: string): { vendor: string | null; product: string | null } {
  const parts = criteria.split(":");
  if (parts.length < 5 || parts[0] !== "cpe") return { vendor: null, product: null };
  const clean = (s: string | undefined) => known(s?.replace(/\\(.)/g, "$1").replace(/_/g, " "));
  return { vendor: clean(parts[3]), product: clean(parts[4]) };
}

type ParsedCve = z.infer<typeof cveSchema>;

function vendorProduct(cve: ParsedCve): { vendor: string | null; product: string | null } {
  // The CNA's "affected" block has human-readable names ("Palo Alto Networks").
  for (const a of cve.affected ?? []) {
    for (const d of a.affectedData ?? []) {
      const vendor = known(d.vendor);
      if (vendor) return { vendor, product: known(d.product) };
    }
  }
  for (const c of cve.configurations ?? []) {
    for (const n of c.nodes ?? []) {
      for (const m of n.cpeMatch ?? []) {
        if (m.vulnerable === false) continue;
        const vp = vendorFromCpe(m.criteria);
        if (vp.vendor) return vp;
      }
    }
  }
  return { vendor: null, product: null };
}

function cweIds(cve: ParsedCve): string[] {
  const ids = new Set<string>();
  for (const w of cve.weaknesses ?? []) {
    for (const d of w.description ?? []) {
      if (/^CWE-\d+$/.test(d.value)) ids.add(d.value);
    }
  }
  return [...ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/** NVD publishes timestamps without a zone; they are UTC. */
function parseNvdDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses a `?cveId=` response. Returns null when NVD has no record (yet) for the id. */
export function parseNvdResponse(json: unknown, cveId: string): NvdCve | null {
  const r = responseSchema.safeParse(json);
  if (!r.success) throw new NvdParseError("NVD: unexpected response shape");
  const wanted = normalizeCveId(cveId);
  for (const v of r.data.vulnerabilities) {
    const c = cveSchema.safeParse(v.cve);
    if (!c.success) continue;
    if (normalizeCveId(c.data.id) !== wanted) continue;
    const cve = c.data;
    const en = cve.descriptions?.find((d) => d.lang === "en") ?? cve.descriptions?.[0];
    // NVD descriptions are plain text (and may contain "<" legitimately); the UI renders them as text.
    const description = en?.value.trim().slice(0, 4000) || null;
    return {
      id: wanted!,
      status: cve.vulnStatus ?? null,
      description,
      publishedAt: parseNvdDate(cve.published),
      cvss: pickCvss(cve.metrics),
      ...vendorProduct(cve),
      cweIds: cweIds(cve),
    };
  }
  return null;
}

export type NvdFetchOptions = {
  apiKey?: string;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
  baseUrl?: string;
};

export function nvdUrl(cveId: string, baseUrl = NVD_API_URL): string {
  const u = new URL(baseUrl);
  u.searchParams.set("cveId", cveId);
  return u.toString();
}

/** One NVD request. Throws NvdHttpError for non-2xx and SafeFetchError for network trouble. */
export async function fetchNvdCve(cveId: string, opts: NvdFetchOptions = {}): Promise<NvdCve | null> {
  const fetcher = opts.fetcher ?? safeFetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers.apiKey = opts.apiKey;
  const res = await fetcher(nvdUrl(cveId, opts.baseUrl), {
    headers,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (res.status < 200 || res.status > 299) throw new NvdHttpError(res.status);
  let json: unknown;
  try {
    json = JSON.parse(res.text());
  } catch {
    throw new NvdParseError("NVD: response is not JSON");
  }
  return parseNvdResponse(json, cveId);
}
