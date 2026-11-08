import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { CvssBadge, EpssBadge, KevBadge, RansomwareBadge } from "@/components/feed/badges";
import { CvePanel } from "@/components/feed/CvePanel";
import { Badge, ExternalLink } from "@/components/ui";
import { getStory } from "@/feed/queries";

export async function generateMetadata({ params }: PageProps<"/story/[id]">): Promise<Metadata> {
  const data = await getStory((await params).id);
  return { title: data?.story.title ?? "Story not found" };
}

/** SPEC §8: CVE panels with full enrichment, then every item in time order. */
const NETWORK_NAMES: Record<string, string> = { bluesky: "Bluesky", mastodon: "Mastodon", x: "X" };

export default async function StoryPage({ params }: PageProps<"/story/[id]">) {
  const data = await getStory((await params).id);
  if (!data) notFound();
  const { story, cves, items } = data;

  return (
    <main className="max-w-5xl">
      <p className="mb-2 text-xs">
        <Link href="/" className="text-muted hover:text-foreground">
          ← Stories
        </Link>
      </p>
      <h1 className="text-lg leading-snug font-semibold">{story.title}</h1>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted">
        {story.has_kev && <KevBadge />}
        {story.has_ransomware && <RansomwareBadge />}
        <CvssBadge score={story.max_cvss} />
        <EpssBadge percentile={story.max_epss_percentile} score={story.max_epss} />
        <span>
          {items.length} item{items.length === 1 ? "" : "s"} from {story.source_ids.length} source
          {story.source_ids.length === 1 ? "" : "s"}
        </span>
        <span>
          first seen <LocalTime iso={story.first_seen_at.toISOString()} mode="datetime" />
        </span>
        <span>
          updated <LocalTime iso={story.last_activity_at.toISOString()} />
        </span>
      </div>

      {cves.length > 0 && (
        <section className="mt-4 space-y-2" aria-label="Vulnerabilities">
          <h2 className="text-xs font-semibold tracking-wide text-foreground/70 uppercase">
            {cves.length === 1 ? "Vulnerability" : `${cves.length} vulnerabilities`}
          </h2>
          {cves.map((c) => (
            <CvePanel key={c.id} cve={c} />
          ))}
        </section>
      )}

      <section className="mt-5" aria-label="Coverage">
        <h2 className="mb-1 text-xs font-semibold tracking-wide text-foreground/70 uppercase">Coverage</h2>
        <ol className="divide-y divide-foreground/5">
          {items.map((i) => (
            <li key={i.id} className="py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                <span className="font-medium text-foreground/80">{i.source_name}</span>
                <Badge>{i.category}</Badge>
                <LocalTime iso={(i.published_at ?? i.activity_at).toISOString()} mode="datetime" />
                {i.author && <span>· {i.author}</span>}
              </div>
              <ExternalLink href={i.url} className="mt-0.5 inline-block font-medium hover:underline">
                {i.title}
              </ExternalLink>
              {i.excerpt && <p className="mt-0.5 max-w-4xl text-xs text-foreground/75">{i.excerpt}</p>}
              {i.hn_url && (
                <p className="mt-0.5 text-xs text-muted">
                  <ExternalLink href={i.hn_url} className="text-accent hover:underline">
                    HN discussion
                  </ExternalLink>
                  {i.points !== null && ` · ${i.points} points`}
                  {i.comments !== null && ` · ${i.comments} comments`}
                </p>
              )}
              {i.post_url && i.post_url !== i.url && (
                <p className="mt-0.5 text-xs text-muted">
                  <ExternalLink href={i.post_url} className="text-accent hover:underline">
                    Post on {NETWORK_NAMES[i.network ?? ""] ?? "social media"}
                  </ExternalLink>
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
