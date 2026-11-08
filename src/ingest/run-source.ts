/**
 * runSource (SPEC §6.2): fetch → normalize → persist for one source, guarded by
 * a session-level advisory lock so no two runs of the same source overlap,
 * whichever process (worker, CLI --inline) started them.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { getDb, getPool, schema, type Db } from "../db/client";
import { cves, itemCves, items, sources } from "../db/schema";
import { getEnv } from "../env";
import { SafeFetchError } from "../lib/safe-fetch";
import { hashCanonicalUrl } from "../lib/url";
import {
  getAdapter,
  SourceHttpError,
  type AdapterContext,
  type CveRecord,
  type FetchResult,
  type NormalizedItem,
  type Source,
} from "./adapters";
import { afterIngest } from "./hooks";
import { BudgetError, fetchWithBudget, SpendLockTimeoutError } from "./spend";
import { markRunSourceRunning, recordRetryableFailure, recordRunSourceResult, type RunSourceResult } from "./runs";

export type RunSourceOptions = {
  runId?: string;
  force: boolean;
  /** 1-based attempt number (pg-boss retryCount + 1). */
  attempt?: number;
  /** When false, a retryable failure leaves the row "running" and the caller rethrows for pg-boss. */
  isFinalAttempt?: boolean;
  signal?: AbortSignal;
  /** Test seams. */
  fetcher?: AdapterContext["fetcher"];
  now?: Date;
  range?: AdapterContext["range"];
  /** pg-boss instance for the post-ingest enrich/cluster jobs (default: the process sender). */
  boss?: PgBoss;
};

export type RunSourceOutcome = RunSourceResult & {
  /** True when the failure is transient and another attempt may succeed. */
  retryable: boolean;
  newCveIds: string[];
};

const CHUNK = 500;

export async function runSource(sourceId: string, opts: RunSourceOptions): Promise<RunSourceOutcome> {
  const started = Date.now();
  const db = getDb();
  const client = await getPool().connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('ingest:' || $1)) AS locked",
      [sourceId],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      const outcome = result("skipped_locked", started, { error: "another run of this source is in progress" });
      if (opts.runId) await recordRunSourceResult(db, opts.runId, sourceId, outcome);
      return outcome;
    }

    if (opts.runId) {
      const proceed = await markRunSourceRunning(db, opts.runId, sourceId, opts.attempt ?? 1);
      if (!proceed) {
        // Row was cancelled (or already finished) — do nothing.
        return result("skipped_locked", started, { error: "run-source row no longer queued (cancelled?)" });
      }
    }

    const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
    if (!source) {
      const outcome = result("failed", started, { error: `unknown source ${sourceId}` });
      if (opts.runId) await recordRunSourceResult(db, opts.runId, sourceId, outcome);
      return outcome;
    }

    let fetched: FetchResult;
    try {
      fetched = await fetchWithBudget(getAdapter(source.type), source, {
        force: opts.force,
        signal: opts.signal ?? new AbortController().signal,
        fetcher: opts.fetcher,
        now: opts.now,
        range: opts.range,
        kevItemLookbackDays: getEnv().KEV_ITEM_LOOKBACK_DAYS,
      }, { client });
    } catch (err) {
      if (err instanceof BudgetError) {
        // Paid source switched off or over its monthly cap: a skip, not a source failure.
        const outcome = result(err.reason === "cap" ? "skipped_budget" : "skipped_disabled", started, { error: err.message });
        if (opts.runId) await recordRunSourceResult(db, opts.runId, sourceId, outcome);
        return outcome;
      }
      return await handleFailure(db, source, err, started, opts);
    }

    const persisted = await persist(client, source, fetched, opts.now ?? new Date());
    const outcome: RunSourceOutcome =
      fetched.status === "not_modified"
        ? result("not_modified", started, { httpStatus: fetched.httpStatus })
        : {
            ...result("succeeded", started, {
              httpStatus: fetched.httpStatus,
              error: fetched.partialError ? `partial: ${fetched.partialError}` : null,
            }),
            itemsSeen: fetched.items.length,
            itemsNew: persisted.itemsNew,
            itemsUpdated: persisted.itemsUpdated,
            newCveIds: persisted.newCveIds,
          };

    if (opts.runId) await recordRunSourceResult(db, opts.runId, sourceId, outcome);
    // After commit (SPEC §6.2 step 5): enrich.cve for new CVEs, cluster.items for new items.
    await afterIngest({ sourceId, newCveIds: persisted.newCveIds, itemIds: persisted.touchedItemIds }, { boss: opts.boss });
    return outcome;
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('ingest:' || $1))", [sourceId])
        .catch((err: unknown) => console.error(`[runSource] unlock failed for ${sourceId}:`, err));
    }
    client.release();
  }
}

// ---------------------------------------------------------------------------

function result(
  status: RunSourceResult["status"],
  started: number,
  extra: Partial<RunSourceResult> = {},
): RunSourceOutcome {
  return {
    status,
    httpStatus: null,
    itemsSeen: 0,
    itemsNew: 0,
    itemsUpdated: 0,
    durationMs: Date.now() - started,
    error: null,
    retryable: false,
    newCveIds: [],
    ...extra,
  };
}

/** Network errors, timeouts, 408/429/5xx are worth retrying; 4xx and parse errors are not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SafeFetchError) {
    return ["timeout", "network", "dns"].includes(err.code);
  }
  // Another paid fetch of the same provider held the spend lock too long: try again later.
  if (err instanceof SpendLockTimeoutError) return true;
  if (err instanceof SourceHttpError) {
    return err.httpStatus === 408 || err.httpStatus === 429 || err.httpStatus >= 500;
  }
  return false;
}

async function handleFailure(
  db: Db,
  source: Source,
  err: unknown,
  started: number,
  opts: RunSourceOptions,
): Promise<RunSourceOutcome> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const httpStatus = err instanceof SourceHttpError ? err.httpStatus : null;
  const retryable = isRetryable(err);
  const final = opts.isFinalAttempt !== false || !retryable;

  // last_fetched_at moves on every attempt so the due check doesn't hammer a
  // broken source every tick; consecutive_failures counts failed *jobs*.
  await db
    .update(sources)
    .set({
      lastFetchedAt: sql`now()`,
      lastError: message,
      ...(final ? { consecutiveFailures: sql`${sources.consecutiveFailures} + 1` } : {}),
    })
    .where(eq(sources.id, source.id));

  const outcome = { ...result("failed", started, { error: message, httpStatus }), retryable };
  if (opts.runId) {
    if (final) await recordRunSourceResult(db, opts.runId, source.id, outcome);
    else await recordRetryableFailure(db, opts.runId, source.id, message, httpStatus);
  }
  return { ...outcome, retryable: !final };
}

type Persisted = { itemsNew: number; itemsUpdated: number; newCveIds: string[]; touchedItemIds: string[] };

/** SPEC §6.2 step 4: one transaction for items, item_cves, cves and source bookkeeping. */
async function persist(client: PoolClient, source: Source, fetched: FetchResult, now: Date): Promise<Persisted> {
  const tx0 = drizzle({ client, schema, casing: "snake_case" });
  return tx0.transaction(async (tx) => {
    const out: Persisted = { itemsNew: 0, itemsUpdated: 0, newCveIds: [], touchedItemIds: [] };

    if (fetched.status === "ok") {
      // Dedupe on externalId within one fetch (the unique key).
      const unique = [...new Map(fetched.items.map((i) => [i.externalId, i])).values()];
      const allCveIds = [...new Set([...unique.flatMap((i) => i.cveIds), ...(fetched.cves ?? []).map((c) => c.id)])];

      // CVE rows first (FK target). Placeholders for unseen IDs; full rows for KEV.
      out.newCveIds = await insertPlaceholderCves(tx, allCveIds);
      if (fetched.cves?.length) await upsertKevRecords(tx, fetched.cves);

      for (let i = 0; i < unique.length; i += CHUNK) {
        const r = await upsertItems(tx, source.id, unique.slice(i, i + CHUNK), now);
        out.itemsNew += r.inserted;
        out.itemsUpdated += r.updated;
      }

      // item_cves for every item in this fetch (cheap; ON CONFLICT DO NOTHING).
      const ids = await itemIdsByExternalId(tx, source.id, unique.map((i) => i.externalId));
      out.touchedItemIds = [...ids.values()];
      const links = unique.flatMap((i) => {
        const itemId = ids.get(i.externalId);
        return itemId ? i.cveIds.map((cveId) => ({ itemId, cveId })) : [];
      });
      for (let i = 0; i < links.length; i += CHUNK) {
        await tx.insert(itemCves).values(links.slice(i, i + CHUNK)).onConflictDoNothing();
      }
    }

    await tx
      .update(sources)
      .set({
        ...(fetched.status === "ok" && fetched.etag !== undefined ? { etag: fetched.etag } : {}),
        ...(fetched.status === "ok" && fetched.lastModified !== undefined ? { lastModified: fetched.lastModified } : {}),
        // A forced fetch without validators must not erase old ones' meaning; only overwrite when present.
        lastFetchedAt: sql`now()`,
        lastSuccessAt: sql`now()`,
        lastError: null,
        consecutiveFailures: 0,
      })
      .where(eq(sources.id, source.id));

    return out;
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function insertPlaceholderCves(tx: Tx, ids: string[]): Promise<string[]> {
  const inserted: string[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await tx
      .insert(cves)
      .values(ids.slice(i, i + CHUNK).map((id) => ({ id })))
      .onConflictDoNothing()
      .returning({ id: cves.id });
    inserted.push(...rows.map((r) => r.id));
  }
  return inserted;
}

async function upsertKevRecords(tx: Tx, records: CveRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += CHUNK) {
    await tx
      .insert(cves)
      .values(records.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: cves.id,
        set: {
          inKev: true,
          kevDateAdded: sql`excluded.kev_date_added`,
          kevDueDate: sql`excluded.kev_due_date`,
          kevRansomware: sql`excluded.kev_ransomware`,
          kevVendor: sql`excluded.kev_vendor`,
          kevProduct: sql`excluded.kev_product`,
          kevName: sql`excluded.kev_name`,
          // NVD's description (Phase 2) wins over KEV's short one.
          description: sql`coalesce(${cves.description}, excluded.description)`,
        },
      });
  }
  // The catalog is complete, so anything no longer listed has left KEV.
  const ids = records.map((r) => r.id);
  await tx
    .update(cves)
    .set({ inKev: false })
    .where(and(eq(cves.inKev, true), notInArray(cves.id, ids)));
}

async function upsertItems(
  tx: Tx,
  sourceId: string,
  batch: NormalizedItem[],
  now: Date,
): Promise<{ inserted: number; updated: number }> {
  if (!batch.length) return { inserted: 0, updated: 0 };
  const rows = await tx
    .insert(items)
    .values(
      batch.map((i) => ({
        sourceId,
        externalId: i.externalId,
        url: i.url,
        canonicalUrlHash: hashCanonicalUrl(i.url),
        title: i.title,
        excerpt: i.excerpt,
        author: i.author,
        publishedAt: i.publishedAt,
        fetchedAt: now,
        raw: i.raw ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [items.sourceId, items.externalId],
      set: {
        title: sql`excluded.title`,
        excerpt: sql`excluded.excerpt`,
        url: sql`excluded.url`,
        canonicalUrlHash: sql`excluded.canonical_url_hash`,
        author: sql`excluded.author`,
        publishedAt: sql`coalesce(excluded.published_at, ${items.publishedAt})`,
        raw: sql`excluded.raw`,
      },
      // Only touch rows whose content changed; unchanged rows aren't returned.
      setWhere: sql`(${items.title}, ${items.excerpt}, ${items.url}, ${items.author}, ${items.raw})
        IS DISTINCT FROM (excluded.title, excluded.excerpt, excluded.url, excluded.author, excluded.raw)`,
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, updated: rows.length - inserted };
}

async function itemIdsByExternalId(tx: Tx, sourceId: string, externalIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const rows = await tx
      .select({ id: items.id, externalId: items.externalId })
      .from(items)
      .where(and(eq(items.sourceId, sourceId), inArray(items.externalId, externalIds.slice(i, i + CHUNK))));
    for (const r of rows) map.set(r.externalId, r.id);
  }
  return map;
}
