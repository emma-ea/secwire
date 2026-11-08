/**
 * CVE extraction (SPEC §6.4).
 *
 * - Dash look-alikes (‐ ‑ ‒ – — −) are normalized to "-" first, because
 *   publishers often typeset "CVE–2026–1234" with en-dashes.
 * - IDs inside URLs are captured (…/detail/CVE-2026-1234): they still refer
 *   to the vulnerability being discussed.
 * - Ranges like "CVE-2026-1234 through -1236" only yield the first ID; we
 *   don't expand ranges.
 * - Years outside [1999, currentYear + 1] are discarded.
 */

const DASHES = /[‐‑‒–—−]/g;
const CVE_RE = /\bCVE-(\d{4})-(\d{4,7})\b/gi;

export const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/;

export function extractCveIds(text: string | null | undefined, now: Date = new Date()): string[] {
  if (!text) return [];
  const maxYear = now.getUTCFullYear() + 1;
  const found = new Set<string>();
  for (const m of text.replace(DASHES, "-").matchAll(CVE_RE)) {
    const year = Number(m[1]);
    if (year < 1999 || year > maxYear) continue;
    found.add(`CVE-${m[1]}-${m[2]}`);
  }
  return [...found];
}

/** Extract from several fields at once, deduped across all of them, in first-seen order. */
export function extractCveIdsFrom(
  fields: Array<string | null | undefined>,
  now: Date = new Date(),
): string[] {
  const all = new Set<string>();
  for (const f of fields) for (const id of extractCveIds(f, now)) all.add(id);
  return [...all];
}

/** Normalizes user input like "cve-2026-1234" → "CVE-2026-1234", or null if invalid. */
export function normalizeCveId(input: string): string | null {
  const id = input.trim().replace(DASHES, "-").toUpperCase();
  return CVE_ID_RE.test(id) ? id : null;
}
