/** Display helpers for CVSS / EPSS badges. Pure. */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

/** CVSS v3/v4 qualitative rating for a base score. */
export function severityFor(score: number | null | undefined): Severity | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "NONE";
}

/** 0.9734 → "97th"; 0.5 → "50th"; 1 → "100th". */
export function percentileLabel(p: number | null | undefined): string | null {
  if (p === null || p === undefined || Number.isNaN(p)) return null;
  const n = Math.min(100, Math.max(0, Math.floor(p * 100)));
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** EPSS probability as a percentage with sensible precision: 0.00395 → "0.4%", 0.94 → "94%". */
export function epssPercent(score: number | null | undefined): string | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  const pct = score * 100;
  // EPSS tops out at 0.99999; "100%" would overstate it.
  if (pct >= 99.5) return ">99%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct < 0.1 ? "<0.1" : pct.toFixed(1)}%`;
}

export const nvdUrl = (cveId: string) => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveId)}`;
export const kevUrl = (cveId: string) =>
  `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cveId)}`;
export const cveOrgUrl = (cveId: string) => `https://www.cve.org/CVERecord?id=${encodeURIComponent(cveId)}`;
