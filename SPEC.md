# SecWire — Security News Aggregator: Build Spec

> **Instructions for Claude Code**
>
> 1. Read this entire document before writing any code.
> 2. Work **one phase at a time** (see §12). At the start of each phase, propose a short plan (files, migrations, dependencies) and wait for approval. At the end of each phase, run `pnpm typecheck && pnpm lint && pnpm test`, summarize what changed, and stop.
> 3. Library APIs change. Check the docs for the version you install for Next.js 16, pg-boss, and Drizzle instead of working from memory. Where this spec names an API that turns out to differ, follow the installed version's docs and note the difference.
> 4. Don't add dependencies beyond those listed in §3 without asking first.
> 5. When a requirement is ambiguous, choose the simpler option, write it down in `DECISIONS.md`, and keep going.

---

## 1. Product summary

SecWire collects security news and vulnerability data from many sources, normalizes it, enriches it with CVE data, and groups it into **stories**, so that one vulnerability covered by fifteen outlets appears once. Each story shows severity (CVSS), exploitation status (CISA KEV), exploit likelihood (EPSS), and links to every source covering it.

Users browse a fast, filterable feed. A single admin manages sources and can trigger ingestion manually at any time.

**Non-goals for v1:** multi-user accounts, storing full article text, scraping sites that lack feeds/APIs, X/Twitter integration, email/Slack alerts, AI summaries. Phase 3 covers the later items. Keep the design open to them, but do not build them.

---

## 2. Architecture

```
Sources (RSS, CISA KEV, HN, later: Bluesky/Mastodon/X)
        │
        ▼
Worker process (pg-boss) ── scheduled tick at admin-configured interval (default 15 min), plus manual triggers
        │   fetch → normalize → persist → extract CVEs → enrich → cluster
        ▼
PostgreSQL (app tables + pg-boss schema)
        │
        ▼
Next.js 16 app (App Router) ── reads from DB only; enqueues jobs for manual triggers
```

Key principles:

- **Pages never fetch external sources in the request path.** They only read from Postgres. The one exception is the admin "Test source" dry run (§7), which has a hard timeout.
- **One core ingestion function, many entry points.** The scheduler, admin UI, CLI, and external HTTP trigger all call the same service layer (`src/ingest/trigger.ts` → `src/ingest/run-source.ts`). Entry points do no fetching logic of their own.
- **Postgres is the only infrastructure dependency.** pg-boss stores the job queue in Postgres. Do not add Redis.
- **Idempotent everything.** Running any source twice in a row must not create duplicates.

---

## 3. Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript strict, Turbopack) |
| Package manager | pnpm |
| Database | PostgreSQL 17 (Docker locally, self-hosted in production) |
| ORM / migrations | Drizzle ORM + drizzle-kit, `pg` (node-postgres) driver |
| Job queue / scheduler | pg-boss (runs in a separate worker process) |
| Feed parsing | `rss-parser` |
| Validation | `zod` (env, API payloads, external API responses) |
| Styling | Tailwind CSS |
| Admin session | `iron-session` (or `jose`) signed httpOnly cookie |
| Scripts / worker runtime | `tsx` |
| Tests | Vitest |
| Dev convenience | `concurrently` (run web + worker together) |

Next.js 16 notes: `middleware.ts` has been renamed to `proxy.ts`, and the exported function is `proxy`. Request APIs (`params`, `searchParams`, `cookies()`) are async.

---

## 4. Repository layout

```
.
├── docker-compose.yml          # db (postgres:17), web, worker
├── .env.example
├── drizzle.config.ts
├── DECISIONS.md
├── src/
│   ├── app/
│   │   ├── page.tsx                    # story feed
│   │   ├── story/[id]/page.tsx
│   │   ├── cve/[id]/page.tsx
│   │   ├── admin/
│   │   │   ├── layout.tsx              # verifies admin session
│   │   │   ├── login/page.tsx
│   │   │   ├── page.tsx                # sources + runs dashboard
│   │   │   ├── runs/[id]/page.tsx
│   │   │   └── sources/new/page.tsx
│   │   └── api/
│   │       ├── health/route.ts
│   │       ├── ingest/route.ts         # external trigger (bearer token)
│   │       └── admin/...               # admin JSON endpoints (§7.3)
│   ├── proxy.ts                        # redirects only — NOT the auth boundary
│   ├── env.ts                          # zod-validated env
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   └── migrations/
│   ├── lib/
│   │   ├── auth.ts                     # session helpers, requireAdmin()
│   │   ├── safe-fetch.ts               # timeouts, size cap, SSRF guard
│   │   ├── url.ts                      # canonicalization + hashing
│   │   ├── cve.ts                      # CVE extraction
│   │   └── text.ts                     # HTML → plain text, truncation
│   ├── ingest/
│   │   ├── trigger.ts                  # triggerIngestion(): used by ALL entry points
│   │   ├── run-source.ts               # core: fetch → normalize → persist (advisory lock)
│   │   ├── boss.ts                     # pg-boss client setup, queue names
│   │   ├── adapters/
│   │   │   ├── types.ts
│   │   │   ├── rss.ts
│   │   │   ├── cisa-kev.ts
│   │   │   └── hackernews.ts
│   │   ├── enrich/
│   │   │   ├── nvd.ts
│   │   │   └── epss.ts
│   │   └── cluster.ts
│   └── components/
├── worker/
│   └── index.ts                        # starts pg-boss, registers workers + schedules, heartbeat
├── scripts/
│   ├── ingest.ts                       # CLI (§7.2)
│   ├── enrich.ts
│   ├── recluster.ts
│   └── seed.ts                         # seeds sources (§9)
└── tests/
    ├── fixtures/                       # saved RSS/KEV/HN/NVD/EPSS responses
    └── *.test.ts
```

---

## 5. Data model (PostgreSQL via Drizzle)

Use `timestamptz` for every timestamp and `text` for slugs/IDs unless noted. Add indexes for every filter used in §8.

### `sources`
| column | type | notes |
|---|---|---|
| id | text PK | slug, e.g. `bleepingcomputer` |
| name | text | display name |
| type | enum | `rss`, `cisa_kev`, `hackernews` (later: `bluesky`, `mastodon`, `x`) |
| url | text | feed/API URL |
| category | enum | `news`, `research`, `advisory`, `community`, `social` |
| enabled | boolean | default true |
| min_interval_minutes | int null | optional override; null = run on every scheduler tick. Can only make a source run **less** often than the global interval (§7.5) |
| config | jsonb | adapter-specific (e.g. HN query terms) |
| etag, last_modified | text null | for conditional GET |
| last_fetched_at, last_success_at | timestamptz null | |
| last_error | text null | |
| consecutive_failures | int | default 0 |
| created_at, updated_at | timestamptz | |

### `items`: one row per fetched entry
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| source_id | FK → sources | |
| external_id | text | RSS guid/link, KEV `cveID`, HN `objectID` |
| url | text | original URL (http/https only) |
| canonical_url_hash | text | sha256 of canonical URL (§6.3), indexed (not unique) |
| title | text | plain text |
| excerpt | text null | plain text, ≤ 400 chars, **never full article content** |
| author | text null | |
| published_at | timestamptz null | |
| fetched_at | timestamptz | |
| story_id | FK → stories null | null until clustered |
| raw | jsonb null | structured sources only (KEV, HN); never article HTML |
| search_vector | tsvector | generated from title + excerpt, GIN index |

Unique: `(source_id, external_id)`. Upsert on conflict: update title/excerpt/url if changed, never duplicate.

### `cves`
| column | type | notes |
|---|---|---|
| id | text PK | `CVE-YYYY-NNNN…` uppercase |
| description | text null | from NVD |
| cvss_score | numeric(3,1) null | prefer CVSS v4, then v3.1, then v3.0 |
| cvss_version, cvss_vector, cvss_severity | text null | |
| epss_score, epss_percentile | numeric null | |
| in_kev | boolean | default false |
| kev_date_added, kev_due_date | date null | |
| kev_ransomware | text null | KEV `knownRansomwareCampaignUse` |
| kev_vendor, kev_product, kev_name | text null | |
| nvd_published_at | timestamptz null | |
| nvd_enriched_at, epss_enriched_at | timestamptz null | |

### `item_cves`
`(item_id, cve_id)` composite PK.

### `stories`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| title | text | see §6.5 |
| first_seen_at, last_activity_at | timestamptz | index on last_activity_at desc |
| item_count | int | denormalized |
| max_cvss | numeric null | denormalized from linked CVEs |
| has_kev | boolean | denormalized |
| max_epss | numeric null | denormalized |
| summary | text null | reserved for Phase 3 AI summaries |

### `story_cves`
`(story_id, cve_id)` composite PK.

### `ingestion_runs`: one row per trigger request
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| trigger | enum | `schedule`, `admin`, `api`, `cli` |
| triggered_by | text null | `admin`, `cli:<os user>`, `api:<token label>` |
| kind | enum | `ingest`, `enrich`, `recluster`, `backfill` |
| scope | jsonb | `{ sourceIds, force, includeDisabled, since, ... }` |
| status | enum | `queued`, `running`, `succeeded`, `partial`, `failed`, `cancelled` |
| created_at, started_at, finished_at | timestamptz | |
| stats | jsonb | totals |
| error | text null | |

### `ingestion_run_sources`: per-source outcome within a run
| column | type | notes |
|---|---|---|
| run_id, source_id | composite PK | |
| job_id | text null | pg-boss job id |
| status | enum | `queued`, `coalesced`, `running`, `succeeded`, `not_modified`, `skipped_locked`, `failed` |
| coalesced_into_job_id | text null | when a duplicate request merged into an existing job |
| http_status | int null | |
| items_seen, items_new, items_updated | int | |
| duration_ms | int null | |
| error | text null | |

### `app_settings`: single-row table (enforce with `id boolean PK default true CHECK (id)`)
| column | type | notes |
|---|---|---|
| scheduler_enabled | boolean | default true. Pauses scheduled ingestion only; manual triggers still work |
| scheduler_interval_minutes | int | default 15. Must be one of the presets in §7.5 (CHECK constraint) |
| enrich_refresh_enabled | boolean | default true. Daily NVD/EPSS refresh (§6.6) |
| last_tick_at | timestamptz null | written by the worker on every `ingest.tick` |
| updated_at | timestamptz | |
| updated_by | text null | e.g. `admin` |

The initial migration inserts the default row. Postgres is the source of truth for these settings. pg-boss schedules are derived from them, never edited directly.

### `worker_heartbeats`
`worker_id` PK, `hostname`, `started_at`, `last_beat_at`, `version`. The worker writes a beat every 30s.

---

## 6. Ingestion pipeline

### 6.1 Adapter contract

```ts
type NormalizedItem = {
  externalId: string;
  url: string;
  title: string;
  excerpt: string | null;     // plain text, ≤ 400 chars
  author: string | null;
  publishedAt: Date | null;
  cveIds: string[];           // extracted, uppercased, deduped
  raw?: unknown;              // structured sources only
};

type FetchResult =
  | { status: "not_modified" }
  | { status: "ok"; items: NormalizedItem[]; etag?: string; lastModified?: string };

interface SourceAdapter {
  type: SourceType;
  fetch(source: Source, opts: { force: boolean; signal: AbortSignal }): Promise<FetchResult>;
}
```

When `force` is false, adapters send `If-None-Match` / `If-Modified-Since` and return `not_modified` on HTTP 304. When `force` is true, they skip conditional headers.

### 6.2 `runSource(sourceId, opts)`: the core function

1. Acquire `pg_try_advisory_lock(hashtext('ingest:' || sourceId))`. If the lock is not acquired, record `skipped_locked` and return. This guarantees no overlap even when a CLI `--inline` run and the worker hit the same source together.
2. Fetch through `safe-fetch` (§10).
3. Normalize, strip HTML, truncate excerpts, and extract CVEs from title + excerpt (+ `raw` for KEV).
4. In one transaction: upsert items, upsert `item_cves`, insert placeholder rows into `cves` for unseen IDs, and update source bookkeeping (etag, timestamps, failures reset).
5. After commit, enqueue `enrich.cve` for new or stale CVEs and `cluster.items`.
6. Record results in `ingestion_run_sources`. Release the lock in `finally`.

On failure: increment `consecutive_failures` and set `last_error`. One failing source must never fail other sources in the same run. Sources are **not** auto-disabled. The admin UI flags any source with ≥ 5 consecutive failures as unhealthy.

### 6.3 URL canonicalization (`lib/url.ts`)
Lowercase scheme + host, drop the fragment, remove `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, strip a trailing slash, sort remaining query params, then hash with sha256. Reject anything that isn't `http:`/`https:`.

### 6.4 CVE extraction (`lib/cve.ts`)
Regex `/\bCVE-(\d{4})-(\d{4,7})\b/gi` → uppercase → dedupe. Discard years < 1999 or > current year + 1. Unit test this thoroughly (fixture cases with lowercase, en-dashes, CVE IDs inside URLs, ranges like "CVE-2026-1234 through -1236" where only the first is captured).

### 6.5 Clustering (`ingest/cluster.ts`)
Process items where `story_id IS NULL`, oldest first. Rules in order:

1. **Same canonical URL** as an item already in a story → join that story. This is how an HN post linking to a BleepingComputer article joins the article's story.
2. **Shares a CVE** with a story whose `last_activity_at` is within `CLUSTER_WINDOW_DAYS` (default 14) → join it. If several match, choose the one with the most recent activity.
3. Otherwise → create a new story.

Story title is the title of the earliest `news`/`advisory` item in it, falling back to the KEV name, then to any item. After assigning, recompute the story's denormalized fields (`item_count`, `last_activity_at`, `max_cvss`, `has_kev`, `max_epss`, `story_cves`).

The function is deterministic and safe to re-run. `recluster --since` sets `story_id = NULL` for items in the range, deletes stories that are left empty, and runs the same function again.

### 6.6 Enrichment
- **NVD** (`https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=…`): Rate limits are tight: 5 requests / 30s without a key, 50 with `NVD_API_KEY`. Run the `enrich.cve` queue at concurrency 1 with a throttle derived from whether a key is set, and back off on 403/429/503. Newly published CVEs often have no CVSS yet. Record `nvd_enriched_at` anyway, and let the daily refresh job retry them.
- **EPSS** (`https://api.first.org/data/v1/epss?cve=A,B,C`): batch up to 100 CVEs per request.
- **KEV**: the KEV adapter writes `in_kev` and the KEV fields to `cves` directly.
- **Daily `enrich.refresh`**: re-enrich CVEs with no CVSS that are less than 30 days old, plus any with `nvd_enriched_at` older than 7 days that appeared in items in the last 30 days. Refresh EPSS daily for CVEs seen in the last 30 days.

### 6.7 Source-specific rules
- **CISA KEV** (`https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`): The file is the full catalog with no changelog. Upsert every entry into `cves`. Create an **item** only for entries whose `dateAdded` is within `KEV_ITEM_LOOKBACK_DAYS` (default 14). Otherwise the first sync would flood the feed with 1,000+ historical entries. Item title: `Added to CISA KEV: {vulnerabilityName}`. `externalId` = `cveID`.
- **Hacker News** (Algolia `https://hn.algolia.com/api/v1/search_by_date`): `config.queries` holds terms (`CVE`, `vulnerability`, `zero-day`, `exploit`, `ransomware`, `breach`, `RCE`). Use `tags=story` and `numericFilters=created_at_i>{last_success - 1h}`. Keep stories that have a URL and `points >= config.minPoints` (default 20). Store points/comments in `raw`. The item URL is the linked article; store the HN discussion link in `raw.hnUrl`.
- **RSS**: feeds hold only recent entries, so RSS **cannot be backfilled**. Say so in the CLI if someone tries.

---

## 7. Triggering ingestion: scheduled and manual

### 7.1 Queues (pg-boss)

Create queues explicitly at worker startup. Verify policy names against the installed pg-boss version.

| Queue | Policy | singletonKey | Purpose |
|---|---|---|---|
| `ingest.tick` | exclusive | — | Runs at the admin-configured interval (default 15 min, §7.5). Enqueues `ingest.source` for each enabled source that is due. |
| `scheduler.sync` | exclusive | — | Reads `app_settings` and applies it to pg-boss schedules (§7.5). Sent by the web app after a settings change; also runs at worker startup. |
| `ingest.source` | stately | `sourceId` | Runs `runSource`. Allows at most one queued + one active job **per source**. |
| `enrich.cve` | stately | `cveId` | NVD + EPSS for one CVE (throttled). |
| `enrich.refresh` | exclusive | — | Scheduled daily (§6.6). |
| `cluster.items` | stately | — | Clusters unassigned items. |
| `maintenance.prune` | exclusive | — | Daily: delete `ingestion_runs` older than 90 days. |

Job payloads carry `runId` so job results are written back to `ingestion_run_sources`.

> ⚠️ pg-boss returns `null` from `send()` when a queue policy rejects a job, and **does not throw**. Every `send()` call must check the result. A `null` for `ingest.source` means a job for that source is already queued: record the source as `coalesced`, look up the existing job id, and store it in `coalesced_into_job_id`. Never treat `null` as success without recording it.

The web app uses a send-only pg-boss instance (no workers, no scheduling/maintenance where the installed version allows disabling them). Workers and schedules run **only** in `worker/index.ts`. Use a stable key on `schedule()` so restarts don't create duplicate schedules.

### 7.2 Entry points

All entry points call `triggerIngestion({ trigger, triggeredBy, kind, sourceIds | 'all', force, includeDisabled, inline, dryRun })`. That function creates the `ingestion_runs` row, enqueues the jobs (or runs inline), and returns `{ runId, sources: [{ sourceId, status }] }`.

**A. Scheduler** (`trigger: schedule`): `ingest.tick` → due sources only, `force: false`. Interval and on/off are admin-configured (§7.5). If no source is due, the tick creates **no** `ingestion_runs` row and makes no external requests, so idle ticks cost nothing but one DB query.

**B. Admin UI** (`trigger: admin`):
- "Run all now": enqueues all enabled sources, ignoring due-time. Optional "Force refresh" checkbox.
- Per-source "Run now", with optional force. "Include disabled" is only offered on a disabled source's own row.
- "Test source": an inline **dry run**. It fetches and parses with a 20s timeout and returns a preview table (title, date, CVEs found) **without writing anything**. Used before saving a new source and when debugging a broken feed. It doesn't create an `ingestion_runs` row.
- "Re-enrich" button on CVE pages; "Recluster since…" on the admin page.

**C. CLI** (`trigger: cli`), via `pnpm ingest`:
```
pnpm ingest --all                       # enqueue all enabled sources
pnpm ingest --source bleepingcomputer   # one source (repeatable flag)
pnpm ingest --source x --force          # skip ETag/If-Modified-Since
pnpm ingest --all --wait                # enqueue, then poll and print results until done
pnpm ingest --source x --inline         # run in-process, no worker needed (still records a run)
pnpm ingest --source x --dry-run        # fetch + parse + print table, no DB writes
pnpm enrich --cve CVE-2026-12345        # re-enrich one CVE
pnpm enrich --stale                     # same as the daily refresh, now
pnpm recluster --since 2026-10-01
pnpm backfill:hn --since 2026-10-01     # HN supports time ranges; RSS does not
```
The CLI exits non-zero if any source failed. `--inline` is meant for local development and debugging when the worker isn't running. The advisory lock (§6.2) keeps it safe even if the worker is running.

**D. External HTTP trigger** (`trigger: api`): `POST /api/ingest` with `Authorization: Bearer <INGEST_API_TOKEN>` and the same body shape as the admin endpoint. It lets system cron, GitHub Actions, or another scheduler drive ingestion if the worker's own schedule is turned off (`WORKER_SCHEDULES_ENABLED=false`). Returns `202 { runId }`. Compare the token in constant time. Rate limit: reject with `429` if an `api`-triggered run was created in the last 60s.

### 7.3 Admin/API endpoints
| Method & path | Body / result |
|---|---|
| `POST /api/admin/ingest` | `{ sourceIds: string[] \| "all", force?, includeDisabled? }` → `202 { runId, sources: [{ sourceId, status: "queued" \| "coalesced" \| "skipped_disabled" }] }` |
| `POST /api/admin/sources/:id/test` | → `200 { items: NormalizedItem[], httpStatus, durationMs }` (dry run) |
| `POST /api/admin/cves/:id/enrich` | → `202 { runId }` |
| `POST /api/admin/recluster` | `{ since: ISODate }` → `202 { runId }` |
| `GET /api/admin/runs?limit=` | recent runs |
| `GET /api/admin/runs/:id` | run + per-source rows |
| `POST /api/admin/runs/:id/cancel` | cancels still-queued jobs in the run; running jobs finish |
| `GET /api/admin/settings/scheduler` | `{ enabled, intervalMinutes, presets, nextRunAt, managedExternally, sources: [{ id, effectiveIntervalMinutes }], estimatedRequestsPerDay }` |
| `PUT /api/admin/settings/scheduler` | `{ enabled?, intervalMinutes?, enrichRefreshEnabled? }` → saves, sends `scheduler.sync`, returns the GET shape. `400` for a non-preset interval |
| `PATCH /api/admin/sources/:id` | `{ enabled?, minIntervalMinutes? \| null }` |
| `POST /api/ingest` | external trigger (§7.2 D) |
| `GET /api/health` | `{ db: "ok", worker: { lastBeatAgeSec }, scheduler: { enabled, intervalMinutes, lastTickAt, nextRunAt }, queues: { name: depth } }` |

Admin UI may use Server Actions instead of fetch calls. Either way, they must call the same service functions as the routes.

### 7.4 Trigger and scheduler scenarios the implementation must handle

| Scenario | Expected behavior |
|---|---|
| Manual run while a scheduled run of the same source is **active** | Allowed: one more job queues behind it (stately). Status `queued`. |
| Manual run while a job for that source is already **queued** | No new job. Status `coalesced`, pointing at the existing job id. UI says "already queued". |
| Admin double-clicks "Run now" | Second request coalesces. Button is disabled while that source has a queued/active job. |
| Repeated manual triggers without force | Per-source cooldown: if the source succeeded < 60s ago, return `skipped_cooldown` unless `force: true`. |
| `--inline` CLI run overlapping a worker job | Advisory lock → the second one records `skipped_locked`. No duplicate writes either way. |
| Worker is down | Jobs stay queued. Admin dashboard shows a red "Worker offline" pill when the last heartbeat is > 90s old, plus a hint to run `pnpm dev:worker` or use `--inline`. |
| Trigger targets a disabled source | Skipped (`skipped_disabled`) unless `includeDisabled: true`. |
| Trigger for an unknown source id | `400` listing the unknown ids. Nothing is enqueued. |
| One source in a multi-source run fails | That source's row is `failed` with the error; the others continue. Run status becomes `partial`. |
| Source returns 304 | Status `not_modified`, counts as success, resets failures. |
| `force: true` | Skips conditional headers and cooldown, but not the advisory lock or coalescing. |
| Source hangs | 30s fetch timeout; pg-boss job expiry 10 min; job retries 2× with backoff, then `failed`. |
| Admin cancels a run | Queued jobs cancelled → `cancelled`; running jobs finish normally. |
| KEV first sync via manual trigger | Catalog fully loaded into `cves`; only recent entries become items (§6.7). |
| Recluster triggered during ingestion | `cluster.items` is stately, so it queues behind any active clustering instead of running concurrently. |
| Admin changes the interval while a scheduled run is in progress | The run finishes normally. The new interval applies from the next schedule boundary. |
| Admin raises the interval (e.g. 15 → 60) | No burst: the due check uses `last_fetched_at`, so only sources that are actually due run on the next tick. |
| Admin pauses the scheduler | No new ticks. Jobs already queued still run, unless "Also cancel queued scheduled jobs" was ticked. Manual triggers keep working. Dashboard shows a "Scheduler paused" banner. |
| Settings saved while the worker is offline | Settings are saved. The `scheduler.sync` job waits in the queue, and the worker also syncs on startup. UI says "Will apply when the worker is back online". |
| Interval that isn't a preset | `400`, nothing saved. |
| Tick fires with no sources due | No `ingestion_runs` row, no external requests. |
| Global interval 5 min, KEV override 60 min | KEV still runs hourly; everything else every 5 min. |
| Next tick fires while the previous tick is still enqueuing | `ingest.tick` is exclusive, so `send()` returns `null`. Log at debug level, not as an error. |
| `WORKER_SCHEDULES_ENABLED=false` | Worker creates no schedules regardless of settings. Settings panel shows "Scheduling is managed externally" with controls disabled. Manual triggers unaffected. |

The admin dashboard polls run status every 3s while any run is `queued`/`running`, and stops polling when all runs are done.

### 7.5 Scheduler configuration (admin)

The admin controls the scheduler from the dashboard. Nothing about its timing is hardcoded.

**Interval presets.** The admin chooses from 5, 10, 15, 30, 60, 120, 180, 360, 720, or 1440 minutes. **Default: 15.** Use presets rather than free-form input, because each divides evenly into an hour or a day and maps to a clean cron expression:
- under 60 min → `*/N * * * *`
- 60–720 min → `0 */H * * *`
- 1440 min → `0 0 * * *`

All schedules run in UTC. The UI displays times in the viewer's local timezone. Put the preset → cron mapping and the "next run at" calculation (next multiple of the interval since UTC midnight) in one pure module with unit tests. No cron library is needed.

**Per-source overrides.** Effective interval = `max(global interval, source.min_interval_minutes)`. Overrides can only make a source run less often, never more often than the global tick. A source is due when `last_fetched_at` is null or `now - last_fetched_at >= effective interval - 2 min`. The 2-minute grace stops fetch latency from pushing a source to every other tick (fetched at 12:00:20, the 12:15:00 tick must still see it as due). If an admin sets an override lower than the global interval, save it, but show "Runs every {global} min (global interval is the minimum)".

**Applying changes.** `PUT /api/admin/settings/scheduler` saves `app_settings`, then sends a `scheduler.sync` job. Schedules are only ever written by the worker. The `scheduler.sync` handler:
1. If `WORKER_SCHEDULES_ENABLED=false`, unschedule everything and return.
2. If `scheduler_enabled`, call `schedule('ingest.tick', cronFor(interval), {}, { tz: 'UTC', key: 'ingest-tick' })`; otherwise unschedule it. If the installed pg-boss version doesn't overwrite an existing schedule on a repeat `schedule()` call, unschedule first, then schedule.
3. Apply `enrich_refresh_enabled` to the daily `enrich.refresh` schedule (03:00 UTC).
4. `maintenance.prune` always stays scheduled daily.

The worker also runs this sync at startup, so the database settings win if anything drifted. Each tick writes `app_settings.last_tick_at`.

**Cost visibility.** The settings panel shows an estimated number of outbound requests per day, recalculated live as the admin changes values before saving: the sum over enabled sources of `(1440 / effective interval) × requestsPerFetch`. RSS and KEV = 1 request per fetch, HN = number of configured queries. Adapters declare `requestsPerFetch` and an optional `costPerRequestUsd`. Phase 3 paid sources (X) set the latter, so the estimate can show dollars per day, and they get a default override of 60 min or more.

**Settings panel** (on `/admin`): on/off toggle, interval dropdown, last tick, next run, estimated requests/day, enrichment-refresh toggle, and a Save button that confirms what will change ("Ingestion will run every 60 min starting 14:00").

---

## 8. Frontend

Visual direction: a dense, scannable, information-first layout that is calm, readable, and fast, closer to a terminal-grade news desk than a marketing site. Support system light/dark mode. Use server components that read from the DB directly, with client components only for filters and admin interactivity.

**`/`: Story feed**
- Each story row shows: title (links to `/story/[id]`), badges (`KEV`, ransomware-linked, CVSS severity with score, EPSS percentile), CVE IDs, vendor/product (from KEV/NVD when known), source count, and "first seen / updated" relative times.
- Filters, kept in URL search params so filtered views can be shared: time range (24h / 7d / 30d), KEV only, min CVSS, source category, specific source, vendor, free-text search (Postgres full-text).
- Default sort: `last_activity_at desc`. Alternative sorts: "Most covered" (item_count) and "Highest risk" (has_kev, then max_epss, then max_cvss).
- Cursor pagination on `(last_activity_at, id)`.

**`/story/[id]`**: CVE panel(s) with full enrichment, KEV due date, and links to NVD/KEV, plus a chronological list of every item (source, title, excerpt, link out, published time).

**`/cve/[id]`**: CVE details plus every story mentioning it. Admin-only "Re-enrich" button.

**`/admin`**: worker status pill, scheduler settings panel (§7.5), queue depths, sources table (name, type, category, enabled toggle, interval override + effective interval, last success, next due, last error, failure count, items in last 24h, Run now, Test), "Run all now", and recent runs with live status. `/admin/runs/[id]` shows per-source results and errors. `/admin/sources/new` is a form that requires a successful Test before saving.

Every external link uses `rel="noopener noreferrer"`. Item text is rendered as plain text only — **never** `dangerouslySetInnerHTML` on feed content.

---

## 9. Seed sources (`scripts/seed.ts`)

The seed script must **verify each URL** (fetch + parse once). It inserts working ones as enabled and failing ones as disabled with `last_error` set, then prints a report. These URLs are starting points and may have moved.

| id | type | category | url |
|---|---|---|---|
| cisa-kev | cisa_kev | advisory | https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json |
| cisa-advisories | rss | advisory | https://www.cisa.gov/cybersecurity-advisories/all.xml |
| bleepingcomputer | rss | news | https://www.bleepingcomputer.com/feed/ |
| thehackernews | rss | news | https://feeds.feedburner.com/TheHackersNews |
| krebsonsecurity | rss | news | https://krebsonsecurity.com/feed/ |
| securityweek | rss | news | https://www.securityweek.com/feed/ |
| therecord | rss | news | https://therecord.media/feed |
| darkreading | rss | news | https://www.darkreading.com/rss.xml |
| schneier | rss | research | https://www.schneier.com/feed/atom/ |
| talos | rss | research | https://blog.talosintelligence.com/rss/ |
| unit42 | rss | research | https://unit42.paloaltonetworks.com/feed/ |
| msrc | rss | advisory | https://msrc.microsoft.com/blog/feed |
| hackernews | hackernews | community | https://hn.algolia.com/api/v1/search_by_date |

Seeded overrides: `cisa-kev` gets `min_interval_minutes = 60`, because the catalog changes a few times a day at most. All other sources start with no override and follow the global interval (default 15 min).

---

## 10. Security requirements

This is a security news site, so it has to hold up to its own audience.

- **Auth boundary:** Do **not** rely on `proxy.ts` for authorization (see CVE-2025-29927 for why middleware-only auth is risky). `requireAdmin()` must be called in the admin layout, in every admin route handler, and in every Server Action. `proxy.ts` may redirect unauthenticated users to login as a convenience only.
- **Admin login:** single admin, password from `ADMIN_PASSWORD`, compared in constant time. Session cookie is httpOnly, `Secure` in production, `SameSite=Lax`, and signed with `SESSION_SECRET` (≥ 32 chars). Rate-limit login attempts (5 per 15 min per IP, stored in Postgres).
- **CSRF:** state-changing admin routes check the `Origin` header matches the app origin, or use Server Actions.
- **`safe-fetch`:** 30s timeout, 5 MB response cap, max 5 redirects, identifying `User-Agent` from `FETCH_USER_AGENT`. **SSRF guard:** resolve the hostname and reject private, loopback, link-local, and metadata ranges (IPv4 and IPv6) for every request **and every redirect hop**, because admins can add arbitrary source URLs.
- **Content handling:** strip all HTML from feed fields. Allow only `http:`/`https:` URLs. Render everything as text.
- **Secrets:** env only, validated by `src/env.ts` at startup. `.env` stays out of git; `.env.example` lists every variable.
- Security headers via `next.config.ts`: CSP (no inline scripts beyond what Next requires), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`.

---

## 11. Configuration

`.env.example`:
```
DATABASE_URL=postgres://secwire:secwire@localhost:5432/secwire
ADMIN_PASSWORD=change-me
SESSION_SECRET=generate-a-32+-char-random-string
INGEST_API_TOKEN=generate-a-random-token
NVD_API_KEY=                      # optional; raises NVD rate limit
FETCH_USER_AGENT=SecWire/0.1 (+mailto:you@example.com)
KEV_ITEM_LOOKBACK_DAYS=14
CLUSTER_WINDOW_DAYS=14
WORKER_SCHEDULES_ENABLED=true     # deployment-level kill switch; false = rely on external POST /api/ingest.
                                  # Interval and on/off are admin settings in the DB (§7.5), not env vars.
```

`package.json` scripts: `dev`, `dev:worker`, `dev:all` (concurrently), `build`, `start`, `start:worker`, `db:generate`, `db:migrate`, `db:seed`, `ingest`, `enrich`, `recluster`, `backfill:hn`, `test`, `lint`, `typecheck`.

`docker-compose.yml`: `db` (postgres:17, named volume, healthcheck), `web` and `worker` (same image, different commands, both depend on a healthy `db`). Migrations run as a one-off command before `web`/`worker` start. The DB user needs permission to create the pg-boss schema.

---

## 12. Phases and acceptance criteria

### Phase 0: Scaffold
Next.js 16 + TS strict + Tailwind, Drizzle with initial migration, docker-compose Postgres, `env.ts`, Vitest, ESLint, empty worker that connects to pg-boss and writes heartbeats, `/api/health`, `DECISIONS.md`.
**Done when:** `docker compose up -d db && pnpm db:migrate && pnpm dev:all` starts the app and worker, and `/api/health` reports DB ok and a fresh worker heartbeat.

### Phase 1: Ingestion core, manual triggers, configurable scheduler
Adapters for RSS, CISA KEV, and HN. `safe-fetch`, URL canonicalization, CVE extraction, `runSource` with advisory lock, every queue in §7.1 except the enrich/cluster queues, `triggerIngestion`, all four entry points (§7.2), `app_settings` + scheduler settings panel + `scheduler.sync` (§7.5), per-source interval overrides, admin login + dashboard + run detail + add/test source, seed script. A temporary `/` page lists recent **items** (unclustered).
**Done when:**
- A fresh install schedules `ingest.tick` every 15 min with no admin action.
- Changing the interval in the admin panel updates the pg-boss schedule (verify via `SELECT name, cron FROM pgboss.schedule` or the installed version's equivalent) without restarting the worker. Pausing removes it, and a worker restart keeps the DB setting.
- Unit tests cover preset → cron mapping, next-run calculation, effective interval, and the due check including the 2-minute grace.
- `pnpm db:seed` reports per-source verification results.
- `pnpm ingest --all --wait` ingests successfully; running it again creates **zero** new items.
- Every scenario in §7.4 that doesn't depend on enrich/cluster queues is covered by a test or a documented manual check in `DECISIONS.md`.
- Unit tests use fixtures for every adapter (no network in tests).
- An integration test against a test database proves idempotency and coalescing.

### Phase 2: Enrichment, clustering, real UI
NVD + EPSS enrichment with throttling, `enrich.refresh`, clustering (§6.5) + `recluster`, story feed with all filters and sorts, story and CVE pages, full-text search, remaining §7.4 scenarios.
**Done when:** after ingesting a day of data, articles about the same CVE appear as one story with correct KEV/CVSS/EPSS badges; clustering tests cover all three rules plus multi-CVE items; `recluster` is idempotent.

### Phase 3: Later (do not build until asked)
Bluesky author feeds (no auth) and Mastodon account RSS from a curated researcher list. X via pay-per-use API behind a feature flag with a monthly spend cap. Vendor watchlists with email/Slack alerts. AI summaries generated once per story cluster (not per item) and cached in `stories.summary`, regenerated only when new items join.
