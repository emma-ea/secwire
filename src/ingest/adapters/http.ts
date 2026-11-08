import { safeFetch, type SafeResponse } from "../../lib/safe-fetch";
import { SourceHttpError, type AdapterContext, type Source } from "./types";

/** Conditional GET headers unless forced (SPEC §6.1). */
export function conditionalHeaders(
  source: Pick<Source, "etag" | "lastModified">,
  force: boolean,
): Record<string, string> {
  if (force) return {};
  const h: Record<string, string> = {};
  if (source.etag) h["if-none-match"] = source.etag;
  if (source.lastModified) h["if-modified-since"] = source.lastModified;
  return h;
}

export async function getFrom(
  url: string,
  ctx: AdapterContext,
  headers: Record<string, string> = {},
): Promise<SafeResponse> {
  const fetcher = ctx.fetcher ?? safeFetch;
  return fetcher(url, { headers, signal: ctx.signal, timeoutMs: ctx.timeoutMs });
}

/** Throws SourceHttpError for anything other than 2xx (304 is handled by callers first). */
export function assertOk(res: SafeResponse): void {
  if (res.status < 200 || res.status > 299) throw new SourceHttpError(res.status, res.url);
}

export function validatorHeaders(res: SafeResponse): { etag?: string; lastModified?: string } {
  return {
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

export function parseDate(input: string | number | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
