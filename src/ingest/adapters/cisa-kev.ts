import { z } from "zod";
import { CVE_ID_RE, extractCveIdsFrom } from "../../lib/cve";
import { toExcerpt, toTitle } from "../../lib/text";
import { assertOk, conditionalHeaders, getFrom, validatorHeaders } from "./http";
import {
  SourceParseError,
  type CveRecord,
  type FetchResult,
  type NormalizedItem,
  type SourceAdapter,
} from "./types";

const DAY_MS = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const kevEntry = z.object({
  cveID: z.string(),
  vendorProject: z.string().optional(),
  product: z.string().optional(),
  vulnerabilityName: z.string().optional(),
  dateAdded: isoDate,
  shortDescription: z.string().optional(),
  dueDate: isoDate.optional(),
  knownRansomwareCampaignUse: z.string().optional(),
});
type KevEntry = z.infer<typeof kevEntry>;

const kevCatalog = z.object({
  catalogVersion: z.string().optional(),
  vulnerabilities: z.array(z.unknown()),
});

/** KEV has no per-entry page; link to the catalog filtered to this CVE. */
export function kevEntryUrl(cveId: string): string {
  return `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cveId)}`;
}

export function parseKevCatalog(
  json: unknown,
  opts: { now: Date; lookbackDays: number },
): { items: NormalizedItem[]; cves: CveRecord[]; skipped: number } {
  const parsed = kevCatalog.safeParse(json);
  if (!parsed.success) throw new SourceParseError("KEV catalog: unexpected shape");

  const cutoff = new Date(opts.now.getTime() - opts.lookbackDays * DAY_MS).toISOString().slice(0, 10);
  const items: NormalizedItem[] = [];
  const cves = new Map<string, CveRecord>();
  let skipped = 0;

  for (const raw of parsed.data.vulnerabilities) {
    const r = kevEntry.safeParse(raw);
    const id = r.success ? r.data.cveID.trim().toUpperCase() : "";
    if (!r.success || !CVE_ID_RE.test(id)) {
      skipped++;
      continue;
    }
    const e: KevEntry = { ...r.data, cveID: id };
    const name = e.vulnerabilityName ? toTitle(e.vulnerabilityName) : null;
    const description = e.shortDescription ? toTitle(e.shortDescription) : null;

    cves.set(id, {
      id,
      inKev: true,
      kevDateAdded: e.dateAdded,
      kevDueDate: e.dueDate ?? null,
      kevRansomware: e.knownRansomwareCampaignUse ?? null,
      kevVendor: e.vendorProject ? toTitle(e.vendorProject) : null,
      kevProduct: e.product ? toTitle(e.product) : null,
      kevName: name,
      description,
    });

    // Only recent additions become feed items (SPEC §6.7), so the first sync
    // doesn't flood the feed with the whole historical catalog.
    if (e.dateAdded >= cutoff) {
      const excerpt = toExcerpt(e.shortDescription);
      items.push({
        externalId: id,
        url: kevEntryUrl(id),
        title: `Added to CISA KEV: ${name ?? id}`,
        excerpt,
        author: null,
        publishedAt: new Date(`${e.dateAdded}T00:00:00Z`),
        cveIds: [id, ...extractCveIdsFrom([name, excerpt], opts.now).filter((c) => c !== id)],
        raw: e,
      });
    }
  }
  return { items, cves: [...cves.values()], skipped };
}

export const cisaKevAdapter: SourceAdapter = {
  type: "cisa_kev",
  supportsBackfill: false,
  requestsPerFetch: () => 1,
  async fetch(source, ctx): Promise<FetchResult> {
    const res = await getFrom(source.url, ctx, {
      ...conditionalHeaders(source, ctx.force),
      accept: "application/json",
    });
    if (res.status === 304) return { status: "not_modified", httpStatus: 304 };
    assertOk(res);

    let json: unknown;
    try {
      json = JSON.parse(res.text());
    } catch {
      throw new SourceParseError("KEV catalog: invalid JSON");
    }
    const { items, cves } = parseKevCatalog(json, {
      now: ctx.now ?? new Date(),
      lookbackDays: ctx.kevItemLookbackDays ?? 14,
    });
    return { status: "ok", httpStatus: res.status, items, cves, ...validatorHeaders(res) };
  },
};
