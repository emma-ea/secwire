import { createHash } from "node:crypto";

/** Query params that only carry tracking state (SPEC §6.3). */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref"]);

/** Parses and returns the URL only if it is http(s); otherwise null. */
export function parseHttpUrl(input: string | null | undefined): URL | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export function isHttpUrl(input: string | null | undefined): boolean {
  return parseHttpUrl(input) !== null;
}

/**
 * Canonical form used for cross-source dedupe: lowercase scheme + host
 * (WHATWG URL already does both, and drops default ports), no fragment, no
 * tracking params, sorted query, no trailing slash. Throws for non-http(s).
 */
export function canonicalizeUrl(input: string): string {
  const url = parseHttpUrl(input);
  if (!url) throw new Error(`Not an http(s) URL: ${input.slice(0, 200)}`);

  const params = [...url.searchParams.entries()]
    .filter(([k]) => {
      const key = k.toLowerCase();
      return !key.startsWith("utm_") && !TRACKING_PARAMS.has(key);
    })
    .sort(([ak, av], [bk, bv]) => (ak === bk ? cmp(av, bv) : cmp(ak, bk)));

  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  // Credentials are dropped: they never identify a different article.
  return `${url.protocol}//${url.host}${path}${query}`;
}

export function hashCanonicalUrl(input: string): string {
  return createHash("sha256").update(canonicalizeUrl(input)).digest("hex");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
