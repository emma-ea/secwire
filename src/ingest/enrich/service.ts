/**
 * Enrichment (SPEC §6.6): writes NVD and EPSS data to `cves`, then refreshes
 * the stories linked to the CVEs that changed. Fetching lives in ./nvd.ts and
 * ./epss.ts; the job handlers and CLI call these functions.
 */
import { sql } from "drizzle-orm";
import { getDb, getPool, withTransaction, type Db } from "../../db/client";
import { cves } from "../../db/schema";
import { getEnv } from "../../env";
import { normalizeCveId } from "../../lib/cve";
import { SafeFetchError } from "../../lib/safe-fetch";
import type { Fetcher } from "../adapters/types";
import { refreshStoriesForCves } from "../stories";
import { EPSS_BATCH_SIZE, fetchEpss } from "./epss";
import { fetchNvdCve, NvdHttpError, type NvdCve } from "./nvd";
import { nvdSpacingMs, Throttle } from "./throttle";

export type EnrichDeps = {
  fetcher?: Fetcher;
  throttle?: Throttle;
  signal?: AbortSignal;
  db?: Db;
};

/** Transient failure (rate limit, network, 5xx): the job should be retried later. */
export class RetryableEnrichError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "RetryableEnrichError";
  }
}

export class InvalidCveIdError extends Error {
  constructor(input: string) {
    super(`Not a CVE id: ${input}`);
    this.name = "InvalidCveIdError";
  }
}

const globalForThrottle = globalThis as unknown as { __secwireNvdThrottle?: Throttle };

/** One NVD throttle per process; spacing depends on whether NVD_API_KEY is set. */
export function getNvdThrottle(): Throttle {
  globalForThrottle.__secwireNvdThrottle ??= new Throttle(nvdSpacingMs(Boolean(getEnv().NVD_API_KEY)));
  return globalForThrottle.__secwireNvdThrottle;
}

function isTransient(err: unknown): boolean {
  if (err instanceof SafeFetchError) return ["timeout", "network", "dns"].includes(err.code);
  if (err instanceof NvdHttpError) return err.isRetryable;
  return false;
}

/** Fetches one CVE from NVD through the throttle, backing off on 403/429/503. */
export async function fetchNvdThrottled(cveId: string, deps: EnrichDeps = {}): Promise<NvdCve | null> {
  const throttle = deps.throttle ?? getNvdThrottle();
  await throttle.wait(deps.signal);
  try {
    const r = await fetchNvdCve(cveId, {
      apiKey: getEnv().NVD_API_KEY,
      fetcher: deps.fetcher,
      signal: deps.signal,
    });
    throttle.succeeded();
    return r;
  } catch (err) {
    if (err instanceof NvdHttpError && err.isRateLimit) {
      const ms = throttle.penalize();
      throw new RetryableEnrichError(`NVD rate limit (HTTP ${err.httpStatus}); backing off ${Math.round(ms / 1000)}s`, err.httpStatus);
    }
    if (isTransient(err)) {
      throw new RetryableEnrichError(err instanceof Error ? err.message : String(err), err instanceof NvdHttpError ? err.httpStatus : null);
    }
    throw err;
  }
}

/** Writes NVD data. A CVE NVD doesn't know yet still gets nvd_enriched_at, so refresh can retry it later. */
export async function saveNvd(db: Db, cveId: string, nvd: NvdCve | null, now = new Date()): Promise<void> {
  await db.insert(cves).values({ id: cveId }).onConflictDoNothing();
  if (!nvd) {
    await db.update(cves).set({ nvdEnrichedAt: now }).where(sql`${cves.id} = ${cveId}`);
    return;
  }
  await db
    .update(cves)
    .set({
      // NVD's full description replaces KEV's short one.
      description: sql`coalesce(${nvd.description}, ${cves.description})`,
      cvssScore: nvd.cvss?.score ?? null,
      cvssVersion: nvd.cvss?.version ?? null,
      cvssVector: nvd.cvss?.vector ?? null,
      cvssSeverity: nvd.cvss?.severity ?? null,
      nvdPublishedAt: nvd.publishedAt,
      nvdStatus: nvd.status,
      nvdVendor: nvd.vendor,
      nvdProduct: nvd.product,
      cweIds: nvd.cweIds,
      nvdEnrichedAt: now,
    })
    .where(sql`${cves.id} = ${cveId}`);
}

/**
 * Fetches EPSS for `cveIds` (100 per request) and stores the scores. Every
 * requested id gets epss_enriched_at, even ones EPSS doesn't score yet.
 */
export async function enrichEpss(cveIds: string[], deps: EnrichDeps = {}, now = new Date()): Promise<number> {
  const ids = [...new Set(cveIds)];
  if (!ids.length) return 0;
  const scores = await fetchEpss(ids, { fetcher: deps.fetcher, signal: deps.signal });
  const scored = ids.filter((id) => scores.has(id));
  await getPool().query(
    `UPDATE cves c SET epss_score = v.score, epss_percentile = v.percentile, epss_enriched_at = $4
       FROM unnest($1::text[], $2::numeric[], $3::numeric[]) AS v(id, score, percentile)
      WHERE c.id = v.id`,
    [scored, scored.map((id) => scores.get(id)!.score), scored.map((id) => scores.get(id)!.percentile), now],
  );
  await getPool().query(
    "UPDATE cves SET epss_enriched_at = $2 WHERE id = ANY($1::text[]) AND NOT (id = ANY($3::text[]))",
    [ids, now, scored],
  );
  return scored.length;
}

/** Other item-linked CVEs still missing EPSS, to fill the rest of a 100-id request. */
async function epssBacklog(db: Db, exclude: string, limit: number): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM cves c
     WHERE c.epss_enriched_at IS NULL AND c.id <> ${exclude}
       AND EXISTS (SELECT 1 FROM item_cves ic WHERE ic.cve_id = c.id)
     ORDER BY c.id DESC
     LIMIT ${limit}`);
  return r.rows.map((x) => x.id);
}

export type EnrichCveResult = {
  cveId: string;
  nvd: "updated" | "not_found";
  cvssScore: number | null;
  epssUpdated: number;
  epssError: string | null;
  storiesRefreshed: number;
};

/**
 * enrich.cve: NVD (throttled) + EPSS for one CVE, then refresh its stories.
 * With `epss`, the EPSS request also carries up to 99 other item-linked CVEs
 * still missing scores, so most CVEs never need an EPSS request of their own.
 * An EPSS failure doesn't fail the job (the daily refresh catches up).
 */
export async function enrichCve(
  input: string,
  opts: { epss?: boolean } = {},
  deps: EnrichDeps = {},
): Promise<EnrichCveResult> {
  const cveId = normalizeCveId(input);
  if (!cveId) throw new InvalidCveIdError(input);
  const db = deps.db ?? getDb();

  const nvd = await fetchNvdThrottled(cveId, deps);
  await saveNvd(db, cveId, nvd);

  let epssUpdated = 0;
  let epssError: string | null = null;
  const changed = [cveId];
  if (opts.epss !== false) {
    const ids = [cveId, ...(await epssBacklog(db, cveId, EPSS_BATCH_SIZE - 1))];
    try {
      epssUpdated = await enrichEpss(ids, deps);
      changed.push(...ids.slice(1));
    } catch (err) {
      epssError = err instanceof Error ? err.message : String(err);
    }
  }

  const storiesRefreshed = await withTransaction((c) => refreshStoriesForCves(c, changed));
  return {
    cveId,
    nvd: nvd ? "updated" : "not_found",
    cvssScore: nvd?.cvss?.score ?? null,
    epssUpdated,
    epssError,
    storiesRefreshed,
  };
}

// ---------------------------------------------------------------------------
// Daily refresh (SPEC §6.6)
// ---------------------------------------------------------------------------

export const REFRESH = {
  /** CVEs "seen" = linked to an item fetched in this many days. */
  seenDays: 30,
  /** Re-enrich NVD data older than this for CVEs seen recently. */
  staleNvdDays: 7,
  /** "No CVSS yet" CVEs younger than this are retried daily. */
  noCvssMaxAgeDays: 30,
  /** …but not if they were checked within these hours (e.g. by ingestion this morning). */
  noCvssRecheckHours: 12,
} as const;

/**
 * NVD targets: CVEs seen in items in the last 30 days that were never
 * enriched, or have no CVSS yet and are < 30 days old, or whose NVD data is
 * > 7 days old. EPSS targets: every CVE seen in the last 30 days.
 * Only item-linked CVEs are considered: the ~1,800 KEV catalog entries that
 * no item mentions would take hours of NVD quota (see DECISIONS.md).
 */
export async function selectRefreshTargets(db: Db, now = new Date()): Promise<{ nvd: string[]; epss: string[] }> {
  const seen = sql`SELECT DISTINCT ic.cve_id FROM item_cves ic JOIN items i ON i.id = ic.item_id
                    WHERE i.fetched_at >= ${now}::timestamptz - make_interval(days => ${REFRESH.seenDays})`;
  const nvd = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM cves c
     WHERE c.id IN (${seen})
       AND (
         c.nvd_enriched_at IS NULL
         OR (c.cvss_score IS NULL
             AND coalesce(c.nvd_published_at, ${now}::timestamptz) >= ${now}::timestamptz - make_interval(days => ${REFRESH.noCvssMaxAgeDays})
             AND c.nvd_enriched_at < ${now}::timestamptz - make_interval(hours => ${REFRESH.noCvssRecheckHours}))
         OR c.nvd_enriched_at < ${now}::timestamptz - make_interval(days => ${REFRESH.staleNvdDays})
       )
     ORDER BY c.nvd_enriched_at NULLS FIRST, c.id`);
  const epss = await db.execute<{ id: string }>(sql`SELECT c.id FROM cves c WHERE c.id IN (${seen}) ORDER BY c.id`);
  return { nvd: nvd.rows.map((r) => r.id), epss: epss.rows.map((r) => r.id) };
}

/** CVEs linked to the given items that NVD hasn't been asked about yet (ingestion hook). */
export async function unenrichedCvesForItems(itemIds: string[]): Promise<string[]> {
  if (!itemIds.length) return [];
  const r = await getPool().query<{ cve_id: string }>(
    `SELECT DISTINCT ic.cve_id FROM item_cves ic JOIN cves c ON c.id = ic.cve_id
      WHERE ic.item_id = ANY($1::uuid[]) AND c.nvd_enriched_at IS NULL
      ORDER BY ic.cve_id`,
    [itemIds],
  );
  return r.rows.map((x) => x.cve_id);
}

/** Refreshes EPSS for `ids` and the stories that contain them. Returns how many got a score. */
export async function refreshEpss(ids: string[], deps: EnrichDeps = {}): Promise<number> {
  if (!ids.length) return 0;
  const n = await enrichEpss(ids, deps);
  await withTransaction((c) => refreshStoriesForCves(c, ids));
  return n;
}
