import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { ExternalLink } from "@/components/ui";
import type { CveDetail } from "@/feed/queries";
import { cveOrgUrl, epssPercent, kevUrl, nvdUrl, percentileLabel } from "@/lib/severity";
import { CvssBadge, EpssBadge, KevBadge, RansomwareBadge } from "./badges";

const link = "text-accent hover:underline";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Full enrichment for one CVE (SPEC §8): CVSS, EPSS, KEV due date, NVD/KEV links. Plain text only. */
export function CvePanel({ cve, heading = "link" }: { cve: CveDetail; heading?: "link" | "plain" }) {
  const vendor = cve.kev_vendor ?? cve.nvd_vendor;
  const product = cve.kev_product ?? cve.nvd_product;
  const ransomware = cve.in_kev && cve.kev_ransomware?.toLowerCase() === "known";
  const pending = !cve.nvd_enriched_at;
  return (
    <section className="rounded-md border border-foreground/10 p-3">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        {heading === "link" ? (
          <Link href={`/cve/${cve.id}`} className="font-mono text-sm font-semibold hover:underline">
            {cve.id}
          </Link>
        ) : (
          <span className="font-mono text-sm font-semibold">{cve.id}</span>
        )}
        {cve.in_kev && <KevBadge />}
        {ransomware && <RansomwareBadge />}
        <CvssBadge score={cve.cvss_score} severity={cve.cvss_severity} version={cve.cvss_version} />
        <EpssBadge percentile={cve.epss_percentile} score={cve.epss_score} />
        {cve.in_kev && cve.kev_name && <span className="text-xs text-foreground/80">{cve.kev_name}</span>}
      </header>

      {cve.description ? (
        <p className="mb-2 max-w-4xl text-xs leading-relaxed whitespace-pre-line text-foreground/85">{cve.description}</p>
      ) : (
        <p className="mb-2 text-xs text-muted">{pending ? "Waiting for NVD enrichment." : "NVD has no description yet."}</p>
      )}

      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-xs">
        {(vendor || product) && <Row label="Product">{[vendor, product].filter(Boolean).join(" · ")}</Row>}
        <Row label="CVSS">
          {cve.cvss_score !== null ? (
            <>
              {cve.cvss_score.toFixed(1)} {cve.cvss_severity?.toLowerCase()} (v{cve.cvss_version}){" "}
              {cve.cvss_vector && <span className="font-mono text-[11px] text-muted">{cve.cvss_vector}</span>}
            </>
          ) : (
            <span className="text-muted">{pending ? "pending" : "not scored yet"}</span>
          )}
        </Row>
        <Row label="EPSS">
          {cve.epss_score !== null ? (
            <>
              {epssPercent(cve.epss_score)} chance of exploitation in 30 days · {percentileLabel(cve.epss_percentile)} percentile
            </>
          ) : (
            <span className="text-muted">{cve.epss_enriched_at ? "not scored" : "pending"}</span>
          )}
        </Row>
        {cve.in_kev && (
          <Row label="CISA KEV">
            added {cve.kev_date_added ?? "?"} · remediation due{" "}
            <span className="font-medium">{cve.kev_due_date ?? "?"}</span>
            {cve.kev_ransomware ? ` · ransomware use: ${cve.kev_ransomware.toLowerCase()}` : ""}
          </Row>
        )}
        {cve.cwe_ids.length > 0 && <Row label="Weakness">{cve.cwe_ids.join(", ")}</Row>}
        {cve.nvd_published_at && (
          <Row label="Published">
            <LocalTime iso={cve.nvd_published_at.toISOString()} mode="datetime" />
            {cve.nvd_status ? <span className="text-muted"> · NVD status: {cve.nvd_status}</span> : null}
          </Row>
        )}
        <Row label="Links">
          <span className="flex flex-wrap gap-x-3">
            <ExternalLink href={nvdUrl(cve.id)} className={link}>
              NVD
            </ExternalLink>
            {cve.in_kev && (
              <ExternalLink href={kevUrl(cve.id)} className={link}>
                CISA KEV
              </ExternalLink>
            )}
            <ExternalLink href={cveOrgUrl(cve.id)} className={link}>
              CVE.org
            </ExternalLink>
          </span>
        </Row>
      </dl>
    </section>
  );
}
