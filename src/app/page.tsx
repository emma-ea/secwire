import { desc, eq, sql } from "drizzle-orm";
import { LocalTime } from "@/components/LocalTime";
import { Badge, ExternalLink } from "@/components/ui";
import { getDb } from "@/db/client";
import { cves, itemCves, items, sources } from "@/db/schema";

/**
 * Phase 1: a temporary list of recent *items* (not yet clustered into stories).
 * Phase 2 replaces this with the story feed. All feed text renders as plain
 * text — never dangerouslySetInnerHTML.
 */
const LIMIT = 150;

export default async function Home() {
  const db = getDb();
  const rows = await db
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      excerpt: items.excerpt,
      publishedAt: items.publishedAt,
      fetchedAt: items.fetchedAt,
      sourceName: sources.name,
      category: sources.category,
      cveIds: sql<string[]>`coalesce(array_agg(${itemCves.cveId} ORDER BY ${itemCves.cveId}) FILTER (WHERE ${itemCves.cveId} IS NOT NULL), '{}')`,
      inKev: sql<boolean>`coalesce(bool_or(${cves.inKev}), false)`,
    })
    .from(items)
    .innerJoin(sources, eq(sources.id, items.sourceId))
    .leftJoin(itemCves, eq(itemCves.itemId, items.id))
    .leftJoin(cves, eq(cves.id, itemCves.cveId))
    .groupBy(items.id, sources.name, sources.category)
    .orderBy(desc(sql`coalesce(${items.publishedAt}, ${items.fetchedAt})`), desc(items.id))
    .limit(LIMIT);

  return (
    <main>
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-base font-semibold">Latest items</h1>
        <span className="text-xs text-muted">
          {rows.length} most recent · unclustered preview (stories arrive in Phase 2)
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing ingested yet. Run <code className="font-mono">pnpm db:seed</code> then{" "}
          <code className="font-mono">pnpm ingest --all --wait</code>.
        </p>
      ) : (
        <ol className="divide-y divide-foreground/5">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <ExternalLink href={r.url} className="font-medium hover:underline">
                  {r.title}
                </ExternalLink>
                {r.inKev && <Badge tone="bad">KEV</Badge>}
                {r.cveIds.map((c) => (
                  <span key={c} className="font-mono text-[11px] text-accent">
                    {c}
                  </span>
                ))}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                <span>{r.sourceName}</span>
                <span>·</span>
                <span>{r.category}</span>
                <span>·</span>
                <LocalTime iso={(r.publishedAt ?? r.fetchedAt).toISOString()} />
              </div>
              {r.excerpt && <p className="mt-1 line-clamp-2 max-w-4xl text-xs text-foreground/75">{r.excerpt}</p>}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
