import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import type { StoryListRow } from "@/feed/queries";
import { CvssBadge, EpssBadge, KevBadge, RansomwareBadge } from "./badges";

const MAX_CVES = 4;
const MAX_VENDORS = 2;

/** One dense feed row. All text renders as plain text (SPEC §8). */
export function StoryRow({ s }: { s: StoryListRow }) {
  const extraCves = s.cve_ids.length - MAX_CVES;
  const vendors = s.vendor_products.length ? s.vendor_products : s.vendors;
  const sources = s.source_ids.length;
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link href={`/story/${s.id}`} className="font-medium hover:underline">
          {s.title}
        </Link>
        {s.has_kev && <KevBadge />}
        {s.has_ransomware && <RansomwareBadge />}
        <CvssBadge score={s.max_cvss} />
        <EpssBadge percentile={s.max_epss_percentile} score={s.max_epss} />
      </div>
      {s.summary && (
        <p className="mt-0.5 line-clamp-1 max-w-4xl text-xs text-foreground/75" title={s.summary}>
          {s.summary}
        </p>
      )}
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted">
        {s.cve_ids.length > 0 && (
          <span className="flex flex-wrap gap-x-1.5">
            {s.cve_ids.slice(0, MAX_CVES).map((c) => (
              <Link key={c} href={`/cve/${c}`} className="font-mono text-[11px] text-accent hover:underline">
                {c}
              </Link>
            ))}
            {extraCves > 0 && <span>+{extraCves}</span>}
          </span>
        )}
        {vendors.length > 0 && (
          <span className="text-foreground/70">
            {vendors.slice(0, MAX_VENDORS).join(", ")}
            {vendors.length > MAX_VENDORS ? ` +${vendors.length - MAX_VENDORS}` : ""}
          </span>
        )}
        <span title={s.source_ids.join(", ")}>
          {sources} source{sources === 1 ? "" : "s"}
          {s.item_count > sources ? ` · ${s.item_count} items` : ""}
        </span>
        <span>
          first seen <LocalTime iso={s.first_seen_at.toISOString()} />
        </span>
        {s.last_activity_at.getTime() !== s.first_seen_at.getTime() && (
          <span>
            updated <LocalTime iso={s.last_activity_at.toISOString()} />
          </span>
        )}
      </div>
    </li>
  );
}
