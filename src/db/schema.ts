import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DEFAULT_SCHEDULER_INTERVAL_MINUTES,
  SCHEDULER_INTERVAL_PRESETS,
} from "../lib/scheduler";

/*
 * SPEC §5. Column names are camelCase in TS and snake_case in SQL via the
 * `casing: "snake_case"` option (set in both drizzle.config.ts and db/client.ts).
 */

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const timestamptz = () => timestamp({ withTimezone: true, mode: "date" });

const createdAt = () => timestamptz().notNull().defaultNow();
const updatedAt = () =>
  timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceType = pgEnum("source_type", [
  "rss",
  "cisa_kev",
  "hackernews",
]);

export const sourceCategory = pgEnum("source_category", [
  "news",
  "research",
  "advisory",
  "community",
  "social",
]);

export const runTrigger = pgEnum("run_trigger", [
  "schedule",
  "admin",
  "api",
  "cli",
]);

export const runKind = pgEnum("run_kind", [
  "ingest",
  "enrich",
  "recluster",
  "backfill",
]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export const runSourceStatus = pgEnum("run_source_status", [
  "queued",
  "coalesced",
  "running",
  "succeeded",
  "not_modified",
  "skipped_locked",
  "failed",
  // Not in the §5 enum but required by §7.3/§7.4 (see DECISIONS.md):
  "skipped_disabled",
  "skipped_cooldown",
  "cancelled",
]);

/** Statuses after which a run-source row never changes again. */
export const TERMINAL_RUN_SOURCE_STATUSES = [
  "coalesced",
  "succeeded",
  "not_modified",
  "skipped_locked",
  "failed",
  "skipped_disabled",
  "skipped_cooldown",
  "cancelled",
] as const;

// ---------------------------------------------------------------------------
// Sources & items
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    type: sourceType().notNull(),
    url: text().notNull(),
    category: sourceCategory().notNull(),
    enabled: boolean().notNull().default(true),
    minIntervalMinutes: integer(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    etag: text(),
    lastModified: text(),
    lastFetchedAt: timestamptz(),
    lastSuccessAt: timestamptz(),
    lastError: text(),
    consecutiveFailures: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "sources_min_interval_positive",
      sql`${t.minIntervalMinutes} IS NULL OR ${t.minIntervalMinutes} > 0`,
    ),
    index("sources_enabled_idx").on(t.enabled),
  ],
);

export const stories = pgTable(
  "stories",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    /** min(items.activity_at) */
    firstSeenAt: timestamptz().notNull(),
    /** max(items.activity_at) */
    lastActivityAt: timestamptz().notNull(),
    itemCount: integer().notNull().default(0),
    maxCvss: numeric({ precision: 3, scale: 1, mode: "number" }),
    hasKev: boolean().notNull().default(false),
    maxEpss: numeric({ mode: "number" }),
    summary: text(),
    // Denormalized for the feed (Phase 2, migration 0003). Recomputed by
    // refreshStories() whenever items join or linked CVEs are enriched.
    maxEpssPercentile: numeric({ mode: "number" }),
    hasRansomware: boolean().notNull().default(false),
    /** Sorted CVE ids (mirrors story_cves) for display without a join. */
    cveIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Distinct vendor names from KEV, else NVD. */
    vendors: text().array().notNull().default(sql`'{}'::text[]`),
    sourceIds: text().array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    // Default sort + cursor pagination on (last_activity_at, id).
    index("stories_last_activity_idx").on(t.lastActivityAt.desc(), t.id.desc()),
    index("stories_first_seen_idx").on(t.firstSeenAt),
    // "Most covered" sort (keyset: item_count, last_activity_at, id).
    index("stories_item_count_idx").on(t.itemCount.desc(), t.lastActivityAt.desc(), t.id.desc()),
    // "Highest risk" sort (keyset over the same expressions the feed orders by).
    index("stories_risk_idx").on(
      t.hasKev.desc(),
      sql`coalesce(${t.maxEpss}, -1) DESC`,
      sql`coalesce(${t.maxCvss}, -1) DESC`,
      t.lastActivityAt.desc(),
      t.id.desc(),
    ),
    // "Specific source" filter.
    index("stories_source_ids_idx").using("gin", t.sourceIds),
  ],
);

export const items = pgTable(
  "items",
  {
    id: uuid().primaryKey().defaultRandom(),
    sourceId: text()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    url: text().notNull(),
    canonicalUrlHash: text().notNull(),
    title: text().notNull(),
    excerpt: text(),
    author: text(),
    publishedAt: timestamptz(),
    fetchedAt: timestamptz().notNull().defaultNow(),
    storyId: uuid().references(() => stories.id, { onDelete: "set null" }),
    raw: jsonb(),
    /**
     * When the item "happened": published_at, clamped to fetched_at so a
     * future-dated entry can't pin a story to the top. LEAST ignores NULLs, so
     * an undated item uses fetched_at. Clustering and story times use this.
     */
    activityAt: timestamptz()
      .notNull()
      .generatedAlwaysAs((): SQL => sql`LEAST(${items.publishedAt}, ${items.fetchedAt})`),
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${items.title}, '') || ' ' || coalesce(${items.excerpt}, ''))`,
    ),
  },
  (t) => [
    unique("items_source_external_uq").on(t.sourceId, t.externalId),
    check("items_url_http", sql`${t.url} ~* '^https?://'`),
    check(
      "items_excerpt_len",
      sql`${t.excerpt} IS NULL OR char_length(${t.excerpt}) <= 400`,
    ),
    index("items_canonical_url_hash_idx").on(t.canonicalUrlHash),
    // Clustering scans unassigned items oldest-first.
    index("items_unclustered_idx")
      .on(t.activityAt, t.id)
      .where(sql`${t.storyId} IS NULL`),
    // recluster --since and story pages.
    index("items_activity_idx").on(t.activityAt),
    index("items_story_activity_idx").on(t.storyId, t.activityAt),
    index("items_source_fetched_idx").on(t.sourceId, t.fetchedAt.desc()),
    index("items_published_idx").on(t.publishedAt.desc()),
    index("items_search_vector_idx").using("gin", t.searchVector),
  ],
);

// ---------------------------------------------------------------------------
// CVEs
// ---------------------------------------------------------------------------

export const cves = pgTable(
  "cves",
  {
    id: text().primaryKey(),
    description: text(),
    cvssScore: numeric({ precision: 3, scale: 1, mode: "number" }),
    cvssVersion: text(),
    cvssVector: text(),
    cvssSeverity: text(),
    epssScore: numeric({ mode: "number" }),
    epssPercentile: numeric({ mode: "number" }),
    inKev: boolean().notNull().default(false),
    kevDateAdded: date({ mode: "string" }),
    kevDueDate: date({ mode: "string" }),
    kevRansomware: text(),
    kevVendor: text(),
    kevProduct: text(),
    kevName: text(),
    nvdPublishedAt: timestamptz(),
    nvdEnrichedAt: timestamptz(),
    epssEnrichedAt: timestamptz(),
    // From NVD (Phase 2, migration 0003). Vendor/product come from the CNA's
    // "affected" data, else the first vulnerable CPE; KEV's values win for display.
    nvdStatus: text(),
    nvdVendor: text(),
    nvdProduct: text(),
    cweIds: text().array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    check("cves_id_format", sql`${t.id} ~ '^CVE-[0-9]{4}-[0-9]{4,7}$'`),
    index("cves_in_kev_idx").on(t.inKev).where(sql`${t.inKev}`),
    index("cves_kev_vendor_idx").on(sql`lower(${t.kevVendor})`),
    index("cves_nvd_enriched_idx").on(t.nvdEnrichedAt),
    index("cves_epss_enriched_idx").on(t.epssEnrichedAt),
  ],
);

export const itemCves = pgTable(
  "item_cves",
  {
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    cveId: text()
      .notNull()
      .references(() => cves.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.cveId] }),
    index("item_cves_cve_idx").on(t.cveId),
  ],
);

export const storyCves = pgTable(
  "story_cves",
  {
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    cveId: text()
      .notNull()
      .references(() => cves.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.storyId, t.cveId] }),
    index("story_cves_cve_idx").on(t.cveId),
  ],
);

// ---------------------------------------------------------------------------
// Ingestion runs
// ---------------------------------------------------------------------------

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    trigger: runTrigger().notNull(),
    triggeredBy: text(),
    kind: runKind().notNull(),
    scope: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: runStatus().notNull().default("queued"),
    createdAt: createdAt(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
  },
  (t) => [
    index("ingestion_runs_created_idx").on(t.createdAt.desc()),
    // §7.2 D: "reject if an api-triggered run was created in the last 60s".
    index("ingestion_runs_trigger_created_idx").on(t.trigger, t.createdAt.desc()),
    index("ingestion_runs_active_idx")
      .on(t.status)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const ingestionRunSources = pgTable(
  "ingestion_run_sources",
  {
    runId: uuid()
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    sourceId: text()
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    jobId: text(),
    status: runSourceStatus().notNull().default("queued"),
    coalescedIntoJobId: text(),
    httpStatus: integer(),
    itemsSeen: integer().notNull().default(0),
    itemsNew: integer().notNull().default(0),
    itemsUpdated: integer().notNull().default(0),
    durationMs: integer(),
    error: text(),
    /** pg-boss attempts made so far (1 = first try). */
    attempts: integer().notNull().default(0),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.sourceId] }),
    // "Is a job for this source queued/running?" — disables Run now buttons.
    index("ingestion_run_sources_active_idx")
      .on(t.sourceId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("ingestion_run_sources_source_idx").on(t.sourceId),
    index("ingestion_run_sources_job_idx").on(t.jobId),
  ],
);

// ---------------------------------------------------------------------------
// Settings & worker liveness
// ---------------------------------------------------------------------------

export const appSettings = pgTable(
  "app_settings",
  {
    id: boolean().primaryKey().default(true),
    schedulerEnabled: boolean().notNull().default(true),
    schedulerIntervalMinutes: integer()
      .notNull()
      .default(DEFAULT_SCHEDULER_INTERVAL_MINUTES),
    enrichRefreshEnabled: boolean().notNull().default(true),
    lastTickAt: timestamptz(),
    updatedAt: updatedAt(),
    updatedBy: text(),
  },
  (t) => [
    check("app_settings_singleton", sql`${t.id}`),
    check(
      "app_settings_interval_preset",
      sql`${t.schedulerIntervalMinutes} IN (${sql.raw(SCHEDULER_INTERVAL_PRESETS.join(", "))})`,
    ),
  ],
);

export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    workerId: text().primaryKey(),
    hostname: text().notNull(),
    startedAt: timestamptz().notNull(),
    lastBeatAt: timestamptz().notNull(),
    version: text().notNull(),
  },
  (t) => [index("worker_heartbeats_last_beat_idx").on(t.lastBeatAt.desc())],
);

/** Admin login attempts, for rate limiting (SPEC §10). Pruned daily. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    ip: text().notNull(),
    attemptedAt: timestamptz().notNull().defaultNow(),
    succeeded: boolean().notNull().default(false),
  },
  (t) => [
    index("login_attempts_ip_time_idx").on(t.ip, t.attemptedAt.desc()),
    index("login_attempts_time_idx").on(t.attemptedAt.desc()),
  ],
);
