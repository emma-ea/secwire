/**
 * Clustering (SPEC §6.5). Unassigned items are processed oldest first
 * (activity_at, id) and each one:
 *
 *   1. joins the story of an already-clustered item with the same canonical
 *      URL (an HN post linking to an article joins the article's story);
 *   2. else joins the most recently active story sharing one of its CVEs,
 *      provided that story is active within CLUSTER_WINDOW_DAYS of the item;
 *   3. else starts a new story.
 *
 * Stories are never merged: an item whose CVEs belong to several stories
 * joins one of them (the most recently active).
 *
 * The window is measured from the *item's* activity time, not from now, and
 * in both directions (the story must have started no later than window after
 * the item and still be active no earlier than window before it). That keeps
 * the result a function of the data, so `recluster` gives the same grouping
 * whenever it runs. See DECISIONS.md.
 */
import { getEnv } from "../env";
import { withTransaction, type Queryable } from "../db/client";
import { lockStories, refreshStories } from "./stories";

export type ClusterOptions = {
  windowDays?: number;
  /** Items per transaction for incremental clustering. */
  batchSize?: number;
};

export type ClusterStats = {
  processed: number;
  joinedByUrl: number;
  joinedByCve: number;
  created: number;
  /** Stories created or changed. */
  storiesTouched: number;
};

const DEFAULT_BATCH = 1000;

const emptyStats = (): ClusterStats => ({ processed: 0, joinedByUrl: 0, joinedByCve: 0, created: 0, storiesTouched: 0 });

function add(a: ClusterStats, b: ClusterStats): ClusterStats {
  return {
    processed: a.processed + b.processed,
    joinedByUrl: a.joinedByUrl + b.joinedByUrl,
    joinedByCve: a.joinedByCve + b.joinedByCve,
    created: a.created + b.created,
    storiesTouched: a.storiesTouched + b.storiesTouched,
  };
}

type PendingItem = {
  id: string;
  title: string;
  canonical_url_hash: string;
  activity_at: Date;
  cve_ids: string[];
};

/**
 * Clusters up to `limit` unassigned items. Must run in a transaction holding
 * lockStories(). Returns stats and whether more unassigned items remain.
 */
export async function clusterBatch(
  client: Queryable,
  opts: { windowDays: number; limit: number },
): Promise<ClusterStats & { more: boolean }> {
  const pending = await client.query<PendingItem>(
    `SELECT i.id, i.title, i.canonical_url_hash, i.activity_at,
            coalesce(array_agg(ic.cve_id ORDER BY ic.cve_id) FILTER (WHERE ic.cve_id IS NOT NULL), '{}') AS cve_ids
       FROM items i LEFT JOIN item_cves ic ON ic.item_id = i.id
      WHERE i.story_id IS NULL
      GROUP BY i.id
      ORDER BY i.activity_at, i.id
      LIMIT $1`,
    [opts.limit + 1],
  );
  const more = pending.rows.length > opts.limit;
  const rows = pending.rows.slice(0, opts.limit);
  const stats = emptyStats();
  if (!rows.length) return { ...stats, more: false };

  // Assignments are written to items in one statement at the end (fewer row
  // locks held against concurrent ingestion), so rule 1 also has to see the
  // assignments made earlier in this batch.
  const assigned = new Map<string, string>(); // item id → story id
  const batchStoriesByUrl = new Map<string, Set<string>>();
  const touched = new Set<string>();

  for (const item of rows) {
    let storyId: string | null = null;

    // Rule 1: same canonical URL as an item already in a story.
    const sameUrl = [...(batchStoriesByUrl.get(item.canonical_url_hash) ?? [])];
    const r1 = await client.query<{ id: string }>(
      `SELECT s.id FROM stories s
        WHERE s.id = ANY($2::uuid[])
           OR s.id IN (SELECT story_id FROM items WHERE canonical_url_hash = $1 AND story_id IS NOT NULL)
        ORDER BY s.last_activity_at DESC, s.first_seen_at DESC, s.id
        LIMIT 1`,
      [item.canonical_url_hash, sameUrl],
    );
    if (r1.rows[0]) {
      storyId = r1.rows[0].id;
      stats.joinedByUrl++;
    }

    // Rule 2: shares a CVE with a story active within the window of this item.
    if (!storyId && item.cve_ids.length) {
      const r2 = await client.query<{ id: string }>(
        `SELECT s.id FROM stories s
          WHERE s.id IN (SELECT story_id FROM story_cves WHERE cve_id = ANY($1::text[]))
            AND s.last_activity_at >= $2::timestamptz - make_interval(days => $3)
            AND s.first_seen_at    <= $2::timestamptz + make_interval(days => $3)
          ORDER BY s.last_activity_at DESC, s.first_seen_at DESC, s.id
          LIMIT 1`,
        [item.cve_ids, item.activity_at, opts.windowDays],
      );
      if (r2.rows[0]) {
        storyId = r2.rows[0].id;
        stats.joinedByCve++;
      }
    }

    if (storyId) {
      await client.query(
        `UPDATE stories SET first_seen_at = least(first_seen_at, $2),
                            last_activity_at = greatest(last_activity_at, $2),
                            item_count = item_count + 1
          WHERE id = $1`,
        [storyId, item.activity_at],
      );
    } else {
      // Rule 3: new story. refreshStories() sets the final title below.
      const created = await client.query<{ id: string }>(
        `INSERT INTO stories (title, first_seen_at, last_activity_at, item_count)
         VALUES ($1, $2, $2, 1) RETURNING id`,
        [item.title, item.activity_at],
      );
      storyId = created.rows[0]!.id;
      stats.created++;
    }

    // Later items in this batch must see this story's CVEs and URL.
    if (item.cve_ids.length) {
      await client.query(
        `INSERT INTO story_cves (story_id, cve_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [storyId, item.cve_ids],
      );
    }
    const urlSet = batchStoriesByUrl.get(item.canonical_url_hash) ?? new Set<string>();
    urlSet.add(storyId);
    batchStoriesByUrl.set(item.canonical_url_hash, urlSet);

    assigned.set(item.id, storyId);
    touched.add(storyId);
    stats.processed++;
  }

  const itemIds = [...assigned.keys()];
  await client.query(
    `UPDATE items i SET story_id = v.story_id
       FROM unnest($1::uuid[], $2::uuid[]) AS v(id, story_id)
      WHERE i.id = v.id AND i.story_id IS NULL`,
    [itemIds, itemIds.map((id) => assigned.get(id)!)],
  );
  await refreshStories(client, [...touched]);
  stats.storiesTouched = touched.size;
  return { ...stats, more };
}

function resolveOptions(opts: ClusterOptions) {
  return {
    windowDays: opts.windowDays ?? getEnv().CLUSTER_WINDOW_DAYS,
    limit: opts.batchSize ?? DEFAULT_BATCH,
  };
}

/** Clusters every unassigned item, one transaction per batch. Safe to call concurrently (it serializes). */
export async function clusterItems(opts: ClusterOptions = {}): Promise<ClusterStats> {
  const o = resolveOptions(opts);
  let total = emptyStats();
  for (;;) {
    const r = await withTransaction(async (client) => {
      await lockStories(client);
      return clusterBatch(client, o);
    });
    total = add(total, r);
    if (!r.more) return total;
  }
}

export type ReclusterStats = ClusterStats & { released: number; deletedStories: number };

/**
 * SPEC §6.5: unassigns every item whose activity time is on or after `since`,
 * deletes stories left empty (and recomputes partly emptied ones), then
 * clusters again — all in one transaction, so readers never see the gap.
 */
export async function recluster(since: Date, opts: ClusterOptions = {}): Promise<ReclusterStats> {
  const o = resolveOptions(opts);
  return withTransaction(async (client) => {
    await lockStories(client);
    const released = await client.query<{ story_id: string }>(
      `WITH r AS (
         UPDATE items i SET story_id = NULL
           FROM items old
          WHERE old.id = i.id AND i.activity_at >= $1 AND i.story_id IS NOT NULL
          RETURNING old.story_id
       ) SELECT story_id FROM r`,
      [since],
    );
    const oldStoryIds = [...new Set(released.rows.map((r) => r.story_id))];
    const { deleted } = await refreshStories(client, oldStoryIds);

    let total = emptyStats();
    for (;;) {
      const r = await clusterBatch(client, o);
      total = add(total, r);
      if (!r.more) break;
    }
    return { ...total, released: released.rows.length, deletedStories: deleted.length };
  });
}
