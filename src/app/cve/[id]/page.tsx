import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CvePanel } from "@/components/feed/CvePanel";
import { ReEnrichButton } from "@/components/feed/ReEnrichButton";
import { StoryRow } from "@/components/feed/StoryRow";
import { LocalTime } from "@/components/LocalTime";
import { getCve } from "@/feed/queries";
import { isAdmin } from "@/lib/auth";
import { normalizeCveId } from "@/lib/cve";

export async function generateMetadata({ params }: PageProps<"/cve/[id]">): Promise<Metadata> {
  return { title: normalizeCveId(decodeURIComponent((await params).id)) ?? "CVE not found" };
}

/** SPEC §8: CVE details plus every story mentioning it. Admin-only Re-enrich. */
export default async function CvePage({ params }: PageProps<"/cve/[id]">) {
  const raw = decodeURIComponent((await params).id);
  const id = normalizeCveId(raw);
  if (!id) notFound();
  if (id !== raw) redirect(`/cve/${id}`);
  const [data, admin] = await Promise.all([getCve(id), isAdmin()]);
  if (!data) notFound();
  const { cve, stories, itemCount } = data;

  return (
    <main className="max-w-5xl">
      <p className="mb-2 text-xs">
        <Link href="/" className="text-muted hover:text-foreground">
          ← Stories
        </Link>
      </p>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-mono text-lg font-semibold">{cve.id}</h1>
        {admin && (
          <div className="flex items-baseline gap-3 text-xs text-muted">
            <span>
              NVD checked <LocalTime iso={cve.nvd_enriched_at?.toISOString()} /> · EPSS{" "}
              <LocalTime iso={cve.epss_enriched_at?.toISOString()} />
            </span>
            <ReEnrichButton cveId={cve.id} />
          </div>
        )}
      </div>
      <CvePanel cve={cve} heading="plain" />

      <section className="mt-5" aria-label="Stories">
        <h2 className="mb-1 text-xs font-semibold tracking-wide text-foreground/70 uppercase">
          {stories.length} stor{stories.length === 1 ? "y" : "ies"} · {itemCount} item{itemCount === 1 ? "" : "s"}
        </h2>
        {stories.length ? (
          <ol className="divide-y divide-foreground/5">
            {stories.map((s) => (
              <StoryRow key={s.id} s={s} />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">No ingested item mentions this CVE yet.</p>
        )}
      </section>
    </main>
  );
}
