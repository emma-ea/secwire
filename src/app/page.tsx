import Link from "next/link";
import { FilterBar } from "@/components/feed/FilterBar";
import { StoryRow } from "@/components/feed/StoryRow";
import { feedHref, hasActiveFilters, parseFeedParams, searchAsCveId, SORTS } from "@/feed/params";
import { getFilterOptions, listStories } from "@/feed/queries";

/**
 * Story feed (SPEC §8). Server component reading Postgres directly; filters,
 * sort and the keyset cursor all come from the URL.
 */
export default async function Home({ searchParams }: PageProps<"/">) {
  const filters = parseFeedParams(await searchParams);
  const [{ stories, nextCursor }, options] = await Promise.all([listStories(filters), getFilterOptions()]);
  const active = hasActiveFilters(filters);
  const cveSearch = searchAsCveId(filters.q);

  return (
    <main>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="text-base font-semibold">Stories</h1>
        <span className="text-xs text-muted">
          {SORTS[filters.sort].toLowerCase()} · last {filters.range}
          {filters.cursor ? " · continued" : ""}
        </span>
      </div>
      <div className="mb-3">
        <FilterBar filters={filters} options={options} active={active} />
      </div>

      {cveSearch && (
        <p className="mb-2 text-xs text-muted">
          Showing stories that mention {cveSearch}.{" "}
          <Link href={`/cve/${cveSearch}`} className="text-accent hover:underline">
            CVE details →
          </Link>
        </p>
      )}

      {stories.length === 0 ? (
        <p className="py-8 text-sm text-muted">
          {active || filters.cursor ? (
            <>
              No stories match.{" "}
              <Link href="/" className="text-accent hover:underline">
                Clear filters
              </Link>
            </>
          ) : (
            <>
              Nothing yet. Run <code className="font-mono">pnpm db:seed</code> and{" "}
              <code className="font-mono">pnpm ingest --all --wait</code> with the worker running.
            </>
          )}
        </p>
      ) : (
        <ol className="divide-y divide-foreground/5">
          {stories.map((s) => (
            <StoryRow key={s.id} s={s} />
          ))}
        </ol>
      )}

      {(nextCursor || filters.cursor) && (
        <nav className="mt-4 flex gap-4 text-xs" aria-label="Pagination">
          {filters.cursor && (
            <Link href={feedHref(filters)} className="text-accent hover:underline">
              ← First page
            </Link>
          )}
          {nextCursor && (
            <Link href={feedHref(filters, { cursor: nextCursor })} className="text-accent hover:underline">
              Next page →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
