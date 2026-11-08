/**
 * Story denormalization (SPEC §6.5): recomputes a story's counts, times,
 * story_cves, badges (max CVSS/EPSS, KEV, ransomware), vendors, sources and
 * title from its items and their CVEs. Clustering, recluster and enrichment
 * all call this, so a story's row always matches what's linked to it.
 */
import type { Queryable } from "../db/client";

/** Every writer of story rows takes this transaction-level lock, so they never interleave. */
export const STORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('secwire:stories'))";

export async function lockStories(client: Queryable): Promise<void> {
  await client.query(STORY_LOCK_SQL);
}

/**
 * Recomputes the given stories. Stories left without items are deleted.
 * Must run inside a transaction that holds lockStories().
 * Returns the ids that were deleted.
 */
export async function refreshStories(client: Queryable, storyIds: string[]): Promise<{ deleted: string[] }> {
  const ids = [...new Set(storyIds)];
  if (!ids.length) return { deleted: [] };

  const deleted = await client.query<{ id: string }>(
    `DELETE FROM stories s
      WHERE s.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.story_id = s.id)
      RETURNING s.id`,
    [ids],
  );

  // story_cves = union of the items' CVEs.
  await client.query(
    `DELETE FROM story_cves sc
      WHERE sc.story_id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM items i JOIN item_cves ic ON ic.item_id = i.id
           WHERE i.story_id = sc.story_id AND ic.cve_id = sc.cve_id)`,
    [ids],
  );
  await client.query(
    `INSERT INTO story_cves (story_id, cve_id)
     SELECT DISTINCT i.story_id, ic.cve_id
       FROM items i JOIN item_cves ic ON ic.item_id = i.id
      WHERE i.story_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [ids],
  );

  // Title (§6.5): earliest news/advisory item, else a KEV name, else the earliest item.
  await client.query(
    `UPDATE stories s SET
        item_count          = a.item_count,
        first_seen_at       = a.first_seen_at,
        last_activity_at    = a.last_activity_at,
        source_ids          = a.source_ids,
        cve_ids             = coalesce(c.cve_ids, '{}'),
        max_cvss            = c.max_cvss,
        has_kev             = coalesce(c.has_kev, false),
        max_epss            = c.max_epss,
        max_epss_percentile = c.max_epss_percentile,
        has_ransomware      = coalesce(c.has_ransomware, false),
        vendors             = coalesce(c.vendors, '{}'),
        title               = coalesce(t_news.title, c.kev_name, t_any.title, s.title)
       FROM (
         SELECT i.story_id AS id,
                count(*)::int AS item_count,
                min(i.activity_at) AS first_seen_at,
                max(i.activity_at) AS last_activity_at,
                array_agg(DISTINCT i.source_id ORDER BY i.source_id) AS source_ids
           FROM items i
          WHERE i.story_id = ANY($1::uuid[])
          GROUP BY i.story_id
       ) a
       LEFT JOIN LATERAL (
         SELECT array_agg(cv.id ORDER BY cv.id) AS cve_ids,
                max(cv.cvss_score) AS max_cvss,
                bool_or(cv.in_kev) AS has_kev,
                max(cv.epss_score) AS max_epss,
                max(cv.epss_percentile) AS max_epss_percentile,
                bool_or(cv.in_kev AND lower(coalesce(cv.kev_ransomware, '')) = 'known') AS has_ransomware,
                array_remove(array_agg(DISTINCT coalesce(cv.kev_vendor, cv.nvd_vendor)), NULL) AS vendors,
                (array_agg(cv.kev_name ORDER BY cv.kev_date_added NULLS LAST, cv.id)
                   FILTER (WHERE cv.in_kev AND cv.kev_name IS NOT NULL))[1] AS kev_name
           FROM story_cves sc JOIN cves cv ON cv.id = sc.cve_id
          WHERE sc.story_id = a.id
       ) c ON true
       LEFT JOIN LATERAL (
         SELECT i.title FROM items i JOIN sources so ON so.id = i.source_id
          WHERE i.story_id = a.id AND so.category IN ('news', 'advisory')
          ORDER BY i.activity_at, i.id LIMIT 1
       ) t_news ON true
       LEFT JOIN LATERAL (
         SELECT i.title FROM items i WHERE i.story_id = a.id ORDER BY i.activity_at, i.id LIMIT 1
       ) t_any ON true
      WHERE s.id = a.id`,
    [ids],
  );

  return { deleted: deleted.rows.map((r) => r.id) };
}

/** After enrichment: refresh every story linked to these CVEs. Takes the story lock itself. */
export async function refreshStoriesForCves(client: Queryable, cveIds: string[]): Promise<number> {
  if (!cveIds.length) return 0;
  await lockStories(client);
  const r = await client.query<{ story_id: string }>(
    "SELECT DISTINCT story_id FROM story_cves WHERE cve_id = ANY($1::text[])",
    [cveIds],
  );
  await refreshStories(
    client,
    r.rows.map((x) => x.story_id),
  );
  return r.rows.length;
}
