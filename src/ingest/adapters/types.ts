import type { sources } from "../../db/schema";
import type { SafeFetchOptions, SafeResponse } from "../../lib/safe-fetch";
import type { Provider, Usage } from "../spend";

export type Source = typeof sources.$inferSelect;
export type SourceType = Source["type"];

/** SPEC §6.1 */
export type NormalizedItem = {
  externalId: string;
  url: string;
  title: string;
  /** Plain text, ≤ 400 chars. */
  excerpt: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** Extracted, uppercased, deduped. */
  cveIds: string[];
  /** Structured sources only (KEV, HN). */
  raw?: unknown;
};

/**
 * Catalog data a structured source knows about a CVE independently of any
 * item (KEV). runSource upserts these into `cves` in the same transaction as
 * the items. This is an addition to the §6.1 contract so adapters stay free of
 * DB access — see DECISIONS.md.
 */
export type CveRecord = {
  id: string;
  inKev: true;
  kevDateAdded: string | null;
  kevDueDate: string | null;
  kevRansomware: string | null;
  kevVendor: string | null;
  kevProduct: string | null;
  kevName: string | null;
  description: string | null;
};

export type FetchResult =
  | { status: "not_modified"; httpStatus: number }
  | {
      status: "ok";
      httpStatus: number;
      items: NormalizedItem[];
      etag?: string;
      lastModified?: string;
      cves?: CveRecord[];
      /**
       * Some requests of a multi-request fetch failed after others succeeded (X):
       * the items and validators are still saved, and the run row shows this.
       */
      partialError?: string;
    };

export type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;

export type AdapterContext = {
  /** Skip conditional request headers. */
  force: boolean;
  signal: AbortSignal;
  /** Injected for tests; defaults to safeFetch. */
  fetcher?: Fetcher;
  /** Per-request timeout override (dry runs use 20s). */
  timeoutMs?: number;
  now?: Date;
  /** Backfill window (HN only). */
  range?: { since: Date; until?: Date };
  kevItemLookbackDays?: number;
  /** X credentials and price (Phase 3), filled in from env by runSource/testSource for `x` sources. */
  x?: { bearerToken: string; postReadUsd: number };
  /** Paid adapters report usage per HTTP request, so partial failures are still billed (see spend.ts). */
  trackUsage?: (u: Partial<Usage>) => void;
};

export interface SourceAdapter {
  type: SourceType;
  /** Outbound requests per normal fetch, for the cost estimate (§7.5). */
  requestsPerFetch(source: Pick<Source, "config">): number;
  /** Worst-case USD per outbound request, for the cost estimate (§7.5). Paid sources only. */
  costPerRequestUsd?(source: Pick<Source, "config">): number;
  /** Paid sources (X): fetches run under the provider's monthly cap (src/ingest/spend.ts). */
  paid?: { provider: Provider; maxCostPerFetchUsd(source: Pick<Source, "config">): number };
  supportsBackfill: boolean;
  fetch(source: Source, ctx: AdapterContext): Promise<FetchResult>;
}

/** Non-2xx/304 response from a source. Carries the status for ingestion_run_sources.http_status. */
export class SourceHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    url: string,
  ) {
    super(`HTTP ${httpStatus} from ${url}`);
    this.name = "SourceHttpError";
  }
}

/** The response parsed but didn't have the expected shape. */
export class SourceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceParseError";
  }
}
