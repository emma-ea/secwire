/**
 * FIRST EPSS API client (SPEC §6.6): up to 100 CVEs per request.
 */
import { z } from "zod";
import { normalizeCveId } from "../../lib/cve";
import { safeFetch } from "../../lib/safe-fetch";
import type { Fetcher } from "../adapters/types";

export const EPSS_API_URL = "https://api.first.org/data/v1/epss";
export const EPSS_BATCH_SIZE = 100;

export class EpssHttpError extends Error {
  constructor(public readonly httpStatus: number) {
    super(`EPSS responded with HTTP ${httpStatus}`);
    this.name = "EpssHttpError";
  }
}

// The API returns numbers as strings ("0.003950000").
const num = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    ctx.addIssue({ code: "custom", message: "out of range" });
    return z.NEVER;
  }
  return n;
});

const row = z.object({ cve: z.string(), epss: num, percentile: num, date: z.string().optional() }).loose();
const responseSchema = z.object({ data: z.array(z.unknown()) }).loose();

export type EpssScore = { score: number; percentile: number; date: string | null };

export function parseEpssResponse(json: unknown): Map<string, EpssScore> {
  const out = new Map<string, EpssScore>();
  const r = responseSchema.safeParse(json);
  if (!r.success) throw new Error("EPSS: unexpected response shape");
  for (const raw of r.data.data) {
    const p = row.safeParse(raw);
    if (!p.success) continue;
    const id = normalizeCveId(p.data.cve);
    if (id) out.set(id, { score: p.data.epss, percentile: p.data.percentile, date: p.data.date ?? null });
  }
  return out;
}

export function epssUrl(cveIds: string[], baseUrl = EPSS_API_URL): string {
  const u = new URL(baseUrl);
  u.searchParams.set("cve", cveIds.join(","));
  return u.toString();
}

export type EpssFetchOptions = { fetcher?: Fetcher; signal?: AbortSignal; timeoutMs?: number; baseUrl?: string };

/**
 * Scores for the given CVEs, one request per 100. CVEs EPSS doesn't know
 * (too new, rejected) are simply absent from the map.
 */
export async function fetchEpss(cveIds: string[], opts: EpssFetchOptions = {}): Promise<Map<string, EpssScore>> {
  const fetcher = opts.fetcher ?? safeFetch;
  const ids = [...new Set(cveIds)];
  const out = new Map<string, EpssScore>();
  for (let i = 0; i < ids.length; i += EPSS_BATCH_SIZE) {
    const res = await fetcher(epssUrl(ids.slice(i, i + EPSS_BATCH_SIZE), opts.baseUrl), {
      headers: { accept: "application/json" },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    if (res.status < 200 || res.status > 299) throw new EpssHttpError(res.status);
    let json: unknown;
    try {
      json = JSON.parse(res.text());
    } catch {
      throw new Error("EPSS: response is not JSON");
    }
    for (const [k, v] of parseEpssResponse(json)) out.set(k, v);
  }
  return out;
}
