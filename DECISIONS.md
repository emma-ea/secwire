# Decisions

Choices made where SPEC.md was ambiguous, where an installed library differed from
the spec, or where something was deliberately deferred. Newest phase at the bottom.

## Phase 0 — Scaffold

### Toolchain & versions
- **pnpm 10.34.9, not the latest (12.x).** The machine's corepack (0.32) expects
  `bin/pnpm.cjs`; pnpm 11+ ships only `.mjs`/native binaries, so corepack can't
  launch them. Pinned via `packageManager` in `package.json`. Revisit after a
  corepack upgrade.
- **TypeScript 5.9 and ESLint 9**, as pinned by `create-next-app@16.4.5`, instead of
  the newest TypeScript 7 / ESLint 10. ESLint 9 prints a deprecation warning on
  install; it's harmless and goes away when `eslint-config-next` moves to 10.
- **Node ≥ 22.12** (`engines`), required by pg-boss 12 and Vitest 5.
- **Tailwind 4 through `@tailwindcss/turbopack`** (the scaffold's default), so there's
  no `postcss.config.mjs`.
- *(Superseded in Phase 1: `cacheComponents` is now off — see "CSP and rendering" below.)*
  **`cacheComponents` stays on** (the scaffold default). Under Cache Components a
  `GET` route handler is prerendered unless it touches runtime data, so
  `/api/health` calls `await connection()` explicitly. Pages that read the DB will
  need the same treatment, or `<Suspense>` boundaries, in Phase 1.
- `typecheck` runs `next typegen` first so `LayoutProps`/`PageProps` globals exist.
- `vitest.config.mts` (not `.ts`): the package is CommonJS (`"type"` unset) and Vite
  warns about loading an ESM config as CJS.

### Configuration
- **Env is checked when first used, not at import time** (`getEnv()`), so
  `next build` and image builds don't need secrets. The web server checks at boot
  in `src/instrumentation.ts`; the worker and scripts check on startup.
- **Env minimums:** `ADMIN_PASSWORD` ≥ 8, `SESSION_SECRET` ≥ 32 (spec),
  `INGEST_API_TOKEN` ≥ 16. In `NODE_ENV=production` the `.env.example` placeholder
  values are rejected. Error messages list variable names only, never values.
- **`.env.example` comments sit on their own lines**, not inline as in SPEC §11.
  Node's `--env-file` parser and dotenv treat inline `#` differently.
- Scripts and the worker load `.env` via Node's `--env-file-if-exists`, passed
  through `tsx`. `drizzle.config.ts` uses `process.loadEnvFile()`.

### Database
- **The full §5 schema ships in the first migration**, including tables that
  Phase 1/2 will fill. Later phases add only what §5 doesn't list (e.g.
  `login_attempts` for §10 rate limiting).
- **Snake_case columns** come from Drizzle's `casing: "snake_case"`, set in both
  `drizzle.config.ts` and `db/client.ts`. Those two must stay in sync.
- **The default `app_settings` row** is inserted by a custom migration
  (`0001_app_settings_default_row.sql`, `ON CONFLICT DO NOTHING`), as §5 asks.
- **Extra CHECK constraints** beyond the spec, as defense in depth:
  `items.url ~* '^https?://'`, `char_length(items.excerpt) <= 400`, the CVE ID
  format, and `sources.min_interval_minutes > 0`.
- **Interval presets** live in `src/lib/scheduler.ts` and feed the
  `app_settings_interval_preset` CHECK. Changing the list requires a new migration.
- **`numeric` columns use Drizzle `mode: "number"`**, so CVSS/EPSS come back as JS
  numbers rather than strings.
- **`items.search_vector`** is `GENERATED ALWAYS … STORED` from
  `to_tsvector('english', title || ' ' || excerpt)` with a GIN index.
- **FK delete behavior:** deleting a source cascades to its items and run rows.
  Deleting a story sets `items.story_id` to NULL (so the item gets re-clustered).
  `item_cves`/`story_cves` cascade.
- **Migrations run via `scripts/migrate.ts`** (Drizzle's runtime migrator), not
  `drizzle-kit migrate`. That way production images don't need dev dependencies.
  `drizzle-kit` is used only for `db:generate`.
- **Compose binds Postgres to `127.0.0.1:5432`** only.

### Worker & health
- **`worker_id` = `hostname:pid:startTime(base36)`.** Heartbeats use the DB's
  `now()` to avoid host clock skew. On startup the worker deletes heartbeat rows
  older than 24h; on shutdown it leaves its own row, so health shows a growing age
  rather than "never seen".
- **Repeated shutdown signals:** the first SIGINT/SIGTERM triggers a graceful
  `boss.stop()`. A repeat within 2s is ignored, because `concurrently` and
  `tsx watch` relay Ctrl-C more than once. A later repeat forces an exit.
- **`/api/health`** returns `503` only when the DB is unreachable. A stale worker is
  reported (`worker.online = false` past 90s, per §7.4) but stays `200`, since the
  web app itself is healthy. Error details are logged server-side, never returned.
  Response is `Cache-Control: no-store`.
- **`/api/health` placeholders until Phase 1:** `scheduler.nextRunAt` is `null` and
  `queues` is `{}`. They need the scheduler module and a web-side pg-boss client.
  *(Done in Phase 1.)*

### Deferred to Phase 1 (all done in Phase 1)
- **Full CSP.** Next's inline hydration scripts need per-request nonces set in
  `proxy.ts`, which makes every page render dynamically. Phase 0 ships the parts
  that can't break anything: `frame-ancestors 'none'`, `base-uri 'self'`,
  `object-src 'none'` and `form-action 'self'`, plus `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`.
- **Dockerfile and the `web`/`worker`/`migrate` compose services.** Phase 0 compose
  runs `db` only.
- **Integration-test database setup** (a separate `secwire_test` DB). Phase 0 tests
  are unit tests with no DB.
- **Phase 1+ `package.json` scripts** (`db:seed`, `ingest`, `backfill:hn`,
  `enrich`, `recluster`) exist but just print which phase implements them and
  exit 1.

## Phase 1 — Ingestion core, manual triggers, configurable scheduler

### Library behavior (checked against installed versions)
- **pg-boss 12.38:**
  - The `stately`, `exclusive` and `singletonKey` policies exist as SPEC §7.1 names them.
  - `schedule()` **upserts on `(name, key)`**, so a repeat call overwrites in place
    and there's no need to unschedule first.
  - `send()` returns `null` on a policy rejection. Every call site handles it.
  - `findJobs(name, { key, queued: true })` finds the job a request coalesced into.
  - Queues are created at worker startup with `createQueue`. `updateQueue` keeps
    options current, but a queue's policy can't change after creation.
- **ESM/CJS:** the package stays CommonJS (no `"type": "module"`). tsx handles
  both, and the worker uses `__dirname`.
- **Drizzle gotcha:** inside `select({...})`, a `${table.column}` interpolation
  renders *unqualified* (`"id"`). Correlated subqueries are therefore written
  with explicit aliases (see `listSourcesForAdmin`).
- **Node `net.BlockList`** matches IPv4 addresses against IPv6 rules through
  mapping. `safe-fetch` keeps separate lists per address family.

### Spec gaps and deviations
- **Three extra `run_source_status` values:** `skipped_disabled`,
  `skipped_cooldown` and `cancelled`. §7.3/§7.4 use them but the §5 enum omits
  them (migration 0002). `ingestion_run_sources` also gains `attempts`,
  `started_at` and `finished_at`.
- **`login_attempts` table** for the §10 login rate limit (migration 0002).
- **KEV catalog data travels in `FetchResult.cves`.** It's an optional extension of the
  §6.1 contract. Adapters stay free of database access, and `runSource` upserts
  the catalog in the same transaction as the items. CVEs no longer in the catalog
  get `in_kev = false`.
- **KEV item URL:** KEV has no page per entry, so items link to the catalog
  filtered by CVE (`…/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-…`).
- **HN look-back is at least 24h**, not `last_success − 1h`. A story fetched
  within an hour of posting rarely has 20 points yet, so the spec's window would
  filter out almost everything. The window is
  `min(last_success − 1h, now − 24h)`, or 48h on a first run. Re-fetching is
  idempotent, and updated points land in `raw`. `points>=minPoints` is also sent
  to Algolia as a numeric filter.
- **Seed `cisa-advisories` points to `…/cybersecurity-advisories.xml`**, not
  `…/all.xml`. `all.xml` embeds full advisory HTML and is about 5.7 MB
  decompressed, which exceeds the §10 5 MB cap. ICS advisories (6.2 MB) can't be
  ingested under that cap either. Raising the cap per source is a possible
  Phase 2 decision.
- **Seed `msrc` stays disabled.** `msrc.microsoft.com/blog/feed` now redirects to
  an HTML page, and the blog has no feed any more. The only MSRC feed (the Security
  Update Guide, 3 MB, about 5,400 entries, one per CVE revision) would flood the
  feed. The RSS adapter now reports "URL returned an HTML page" for this case.
- **The seed script never overwrites existing sources**, so admin edits survive a
  re-seed. Delete a row to re-verify it.
- **Backfill (`pnpm backfill:hn`) always runs inline** in the CLI, under the same
  advisory lock. Run kind is `backfill`.
- **`enrich_refresh_enabled`** is stored and shown in Phase 1. Its schedule is applied
  in Phase 2, when the `enrich.refresh` queue exists.
- **`/api/admin/status`** is an extra admin GET route. It serves the dashboard's
  3s polling (runs, sources, worker, queue depths) in one request. Polling uses a
  GET route rather than a Server Action because Server Actions run one at a time
  on the client and would block the admin's own clicks.

### Ingestion semantics
- **Retries:** a failed fetch throws so that pg-boss retries it (2 retries, backoff
  from 30s), but only for transient errors: network, DNS, timeout, HTTP
  408/429/5xx. A 4xx or a parse error fails immediately, because retrying can't
  help.
- **Failure counting:** `consecutive_failures` goes up once per failed *job*, on its
  final attempt. Every attempt updates `last_error` and `last_fetched_at`. The
  second keeps the due check from hitting a broken source on every tick.
- **The run row records each attempt:** it stays `running` between attempts, with
  `attempts` and the last error.
- **Run status:**
  - **failed:** every source failed.
  - **partial:** some failed, and others succeeded, returned not_modified, were
    coalesced or were cancelled.
  - **cancelled:** cancelled, with no failures.
  - **succeeded:** everything else, including all skipped, all coalesced and
    not_modified.
  - Whoever writes the last source result finalizes the run, under a row lock.
- **Coalesced rows are terminal in their own run.** Results are written to the run
  that owns the job. A coalesced request's `force` flag is dropped: the queued job
  runs as it was sent, since §7.4 says force doesn't bypass coalescing.
- **Cooldown** (60s since `last_success_at`) applies to manual and API triggers,
  not to scheduler ticks, which already use the due check.
- **Cancellation:** our `ingestion_run_sources` row decides the race. It is flipped
  `queued → cancelled` first, and the pg-boss job is cancelled only if that update
  won. A job that slips through to a worker sees the cancelled row and does
  nothing.
- **Abandoned work:** a row stuck `running` for 15 minutes (job expiry is 10)
  is marked failed on the next tick or at worker startup, so its run can finish.
- **`ingest.tick` writes `last_tick_at` on every run**, even idle ones. That costs
  one `UPDATE` plus the due query. No sources due means no run row and no external
  requests.
- **"Next tick while the previous tick is still enqueuing" (§7.4):** pg-boss's own
  cron sends tick jobs internally, so we never see that `send()` return `null`. The
  `exclusive` policy still ensures only one tick is queued or active. Our own
  `send()` calls to the exclusive `scheduler.sync` treat `null` as "a sync is
  already queued", not as an error.
- **`WORKER_SCHEDULES_ENABLED=false` unschedules prune as well**, following §7.5
  step 1 ("unschedule everything") over step 4.
- **`safe-fetch` uses `node:http`/`https`** with a guarded `lookup`. Global
  `fetch` has no per-connection lookup hook without adding undici. The guard
  rejects a hostname if *any* resolved address is non-public. IPv4-mapped,
  NAT64, 6to4 and Teredo IPv6 ranges are blocked because they can embed private
  IPv4 addresses. The 5 MB cap applies to *decompressed* bytes, which also stops
  gzip bombs.
- **Text handling:** HTML entities are decoded *after* tags are stripped, and a
  second pass strips any markup that was entity-encoded. As a result, a title that
  literally contains `<script>` loses that text. That's acceptable for a
  display-only plain-text excerpt.

### Auth, CSRF and CSP
- **Admin pages sit in a `(dashboard)` route group** whose layout calls
  `requireAdmin()`. That keeps `/admin/login` outside it, and URLs are unchanged.
  Pages also call `requireAdmin()` themselves, because layouts and pages render in
  parallel.
- **Session:** an iron-session cookie `secwire_admin` lasting 12h. It is httpOnly,
  `SameSite=Lax`, and `Secure` in production.
- **Login rate limit:** 5 *failed* attempts per IP per 15 minutes, plus 20 failed
  attempts across all IPs. The IP is the first `X-Forwarded-For` value, which a
  client can fake unless a proxy overwrites it; the global cap covers that. Old
  attempts are pruned daily.
- **CSRF:**
  - Admin route handlers require an `Origin` header whose host matches `Host`
    (or `X-Forwarded-Host`). A missing `Origin` is rejected.
  - The UI uses Server Actions, which Next checks the same way.
  - The external `/api/ingest` endpoint uses a bearer token instead.
- **Token checks:** `/api/ingest` compares tokens in constant time (both sides
  hashed with sha256, then `timingSafeEqual`). It returns 429 with `Retry-After: 60`
  if an API run was created in the last 60s. Two exactly simultaneous requests
  could both pass; that's accepted.
- **CSP and rendering:**
  - `proxy.ts` sets a per-request nonce CSP on pages:
    `script-src 'self' 'nonce-…' 'strict-dynamic'` and `style-src 'self' 'nonce-…'`
    in production.
  - In dev it adds `'unsafe-eval'`, and `style-src` drops the nonce in favor of
    `'unsafe-inline'`, because browsers ignore `'unsafe-inline'` whenever a nonce
    is present and the dev overlay injects inline styles.
  - Nonces only work on pages rendered per request, so `cacheComponents` is now
    **off**, and the root layout calls `await connection()`. Every page reads
    Postgres on each request anyway.
  - API routes and static assets get a static `default-src 'none'` CSP from
    `next.config.ts`.
  - I checked in Chrome that the production build hydrates with no CSP
    violations.

### Docker
- **One image runs web, worker and migrate.** It keeps the full dependency tree,
  because the worker runs TypeScript through tsx, so `tsx` moved to
  `dependencies`.
- **Compose:** `web`, `worker` and `migrate` sit behind the `app` profile, so
  `docker compose up -d db` still starts only Postgres. The web port is
  `${WEB_PORT:-3000}`. Secrets come from `.env`, and `DATABASE_URL` is overridden
  to reach the `db` service.

## Phase 2 — Enrichment, clustering, real UI

### Hacker News relevance
- **Strict Algolia search.** With Algolia's default settings, about 48 of 49 ingested
  HN stories were off-topic. Typo tolerance turned "CVE" into "CEO", and prefix
  and URL matching found "RCE" inside "source". Every request now sends
  `typoTolerance=false`, `restrictSearchableAttributes=title`,
  `queryType=prefixNone`, `ignorePlurals=true` and `advancedSyntax=false`.
- **Local title check as well** (`titleMatchesQuery`): a hit is kept only when its
  title contains the query's words as consecutive whole words (plurals allowed).
  This guards against Algolia changing its defaults, and drops "Zero to Calc in Six
  Days" for the query "zero day".
- **Hyphens become spaces** in queries (`zero-day` → `zero day`), since Algolia
  found nothing for the hyphenated form. `0day` is a new default query, so HN
  costs 8 requests per fetch. The dev database's `hackernews` config was updated,
  and its 48 off-topic items were deleted with the owner's approval. Known gap:
  inflected forms such as "Breached" don't match `breach`. Admins can add terms to
  `config.queries`.

### Data model (migration 0003)
- **`items.activity_at`** is a generated column: `LEAST(published_at, fetched_at)`.
  `LEAST` skips NULLs, so an undated item uses `fetched_at`, and a future-dated
  entry is clamped to when it was fetched. Clustering order, the cluster window
  and story times (`first_seen_at`, `last_activity_at`) all use it.
- **Extra denormalized story columns:** `max_epss_percentile` and
  `has_ransomware` (for the badges), plus `cve_ids`, `vendors` and `source_ids`
  arrays (for display and the source/vendor filters). `source_ids` has a GIN index.
  `refreshStories()` is the only place that computes them.
- **Extra CVE columns:** `nvd_status`, `nvd_vendor`, `nvd_product` and `cwe_ids`.
  Vendor and product come from NVD's CNA `affected` block, which has
  human-readable names ("Palo Alto Networks"), and fall back to the first
  vulnerable CPE. Placeholder vendors ("Unknown", "n/a") count as unknown. For
  display, the KEV vendor wins over NVD's.
- **Sort indexes match the keyset expressions.** The risk sort orders by
  `coalesce(max_epss, -1)` and `coalesce(max_cvss, -1)`, so the cursor
  comparison and the index use the same expressions.

### Enrichment (SPEC §6.6)
- **Only CVEs that items mention are enriched.** The KEV catalog adds about
  1,800 CVEs that no item links to. Looking all of them up would take about 3
  hours of keyless NVD quota at every refresh. The post-ingest hook enqueues
  `enrich.cve` only for item-linked CVEs that NVD hasn't been asked about yet,
  and the daily refresh only looks at CVEs linked to items fetched in the last
  30 days. A CVE page still shows KEV data for catalog-only CVEs, and the admin
  can re-enrich any CVE.
- **Throttle:** one in-process throttle spaces NVD requests 6.5s apart without a
  key and 0.65s apart with one, which stays under 5 and 50 per 30s. A 403, 429
  or 503 response sets a backoff (30s, doubling to at most 5 min, reset after
  a success) and throws, so pg-boss retries with its own backoff (`retryLimit 5`,
  `retryDelay 60`). The throttle is per process: a CLI `--inline` enrich running
  at the same time as the worker isn't coordinated with it. This is acceptable
  for a developer tool.
- **EPSS piggybacks.** Each `enrich.cve` request also carries up to 99 other
  item-linked CVEs still missing EPSS, so most CVEs never need an EPSS request
  of their own. An EPSS failure is recorded but doesn't fail the NVD part.
  Every requested id gets `epss_enriched_at`, including ids EPSS doesn't score.
- **The daily refresh** (`enrich.refresh`, 03:00 UTC, only while
  `enrich_refresh_enabled`) selects CVEs seen in items in the last 30 days that:
  were never enriched; or have no CVSS, are under 30 days old and weren't
  checked in the last 12h; or have NVD data older than 7 days. It fetches EPSS
  for every CVE seen in the last 30 days in batches of 100, and enqueues one
  `enrich.cve` job per NVD target with `epss: false`. So the run is "succeeded"
  once the NVD jobs are *queued*; they complete in the background.
- **A CVE that NVD doesn't know yet** still gets `nvd_enriched_at`, as the spec
  says. The CVE page shows "not scored yet".
- **NVD descriptions are stored as given (trimmed)**, not passed through
  `htmlToText`. They are plain text that can legitimately contain `<`, and the
  UI renders them as text.

### Clustering (SPEC §6.5)
- **The window is measured from the item's own time, in both directions.** An item
  joins a CVE-sharing story only when the story's `last_activity_at ≥
  item.activity_at − window` and its `first_seen_at ≤ item.activity_at + window`.
  Measuring from "now" would make the result depend on when clustering runs,
  and `recluster` couldn't reproduce it.
- **Ties:** candidates are ordered by `last_activity_at DESC, first_seen_at DESC,
  id`. Two stories with identical times are vanishingly rare; if it happens, the
  pick depends on story ids, which `recluster` regenerates.
- **Stories are never merged.** An item whose CVEs belong to several stories joins
  the most recently active one, and that story's `story_cves` grows (tested).
- **Rule 1 has no time window**, as the spec says. It looks at earlier items in the
  same batch as well as stored ones.
- **Locking:** every writer of story rows (clustering, recluster, the story
  refresh after enrichment) takes a transaction-level advisory lock
  (`secwire:stories`), so they never interleave. Item assignments are written in
  one statement per batch to keep row locks against concurrent ingestion short.
  Incremental clustering commits every 1,000 items; `recluster` is one
  transaction, so readers never see stories half rebuilt.
- **`recluster --since`** releases items with `activity_at ≥ since`, recomputes
  the stories they leave (deleting empty ones), then clusters. Idempotency is
  tested by comparing groupings and every denormalized field across repeated
  runs, and against a full recluster. Story ids change; the contents don't.
- **Recluster jobs use `singletonKey: "recluster"`** on the stately
  `cluster.items` queue. Pipeline cluster jobs have no key. Without the key, a
  queued pipeline job would make pg-boss reject the recluster (`send()` →
  null). With it, the recluster queues separately, and the advisory lock
  serializes the two. A second recluster while one is queued coalesces into it
  (its run id is returned).
- **Self-healing:** the tick and worker startup enqueue `cluster.items` whenever
  unassigned items exist, so a lost post-ingest enqueue can't strand items.

### Enrich and recluster runs
- **They use `ingestion_runs` with no `ingestion_run_sources` rows.** The job
  handler sets the status and `stats` directly. Retries leave the run
  `running`, with the attempt's error, until the final attempt. Runs stuck
  `running` for 45 minutes are failed on the next tick, like source rows. Cancel
  isn't offered for them, since they are a single job.
- **Coalescing:** if pg-boss rejects the job, the response points at the run that
  owns the queued job, and the new run row is deleted. When the queued job came
  from the pipeline and has no run, the new run is kept, marked succeeded with
  `{coalesced: true}`.
- **Pipeline `enrich.cve` jobs (from ingestion and the refresh) create no runs.**
  There would be one per CVE. The worker logs each one, and the dashboard shows
  the NVD/EPSS backlog instead.

### Feed (SPEC §8)
- **Time range filters on `last_activity_at`.** The default is 7 days, so the
  feed is "what's active".
- **Full-text search** matches stories with *any* item whose `search_vector`
  matches `websearch_to_tsquery('english', q)`. A query that is exactly a CVE
  id matches through `story_cves` instead.
- **The vendor filter** is a case-insensitive substring match on the story's
  vendor names, with `%`/`_` escaped, plus a datalist of recent vendors. The
  category filter matches stories with at least one item from that category.
- **Cursors** are opaque base64url JSON holding the sort's key values as Postgres
  text (microsecond timestamps and exact numerics round-trip). They are
  validated strictly; a malformed cursor, or one from another sort, shows the
  first page. Pagination only moves forward ("Next page", "First page").
- **Filters are a GET form** (`next/form`). The feed works without JavaScript; with
  JavaScript, selects apply as soon as they change. Empty fields appear as
  empty params in the URL and are ignored.

### Dev environment note
- On 2026-11-08 the dev server got stuck in a reload loop on every page:
  Turbopack sent an HMR `restart` for the main chunk list on each connection.
  Committed code reproduced it too, so it wasn't caused by app code. Deleting
  `.next` and restarting `pnpm dev` fixed it. If pages keep reloading in dev, try
  that first.

### SPEC §7.4 scenario coverage
Automated tests are in `tests/integration/*` (they need `docker compose up -d db`)
and `tests/*.test.ts`. Manual checks were run on 2026-11-08 against the dev stack.

| Scenario | How it's covered |
|---|---|
| Manual run while a scheduled run is active | test: `trigger.test.ts` "queues one more behind it (stately)" |
| Manual run while a job is queued | test: "coalesces into the existing job" (`coalesced_into_job_id` set) |
| Admin double-clicks Run now | test: same coalescing test. UI: button disabled while source busy (checked in Chrome) |
| Repeated triggers without force (cooldown) | test: "cooldown … skipped unless forced"; CLI checked by hand |
| `--inline` overlapping a worker job | test: `run-source.test.ts` "skipped_locked when another session holds the lock" |
| Worker is down | manual: stopped worker, health `online:false` at 91s, CLI warned, job stayed `created` in pg-boss, then ran on restart. UI: red pill (`WorkerPill`) |
| Trigger targets a disabled source | test: "disabled sources are skipped unless includeDisabled" |
| Unknown source id | test: "reject the whole request and enqueue nothing"; `/api/ingest` 400 checked by hand |
| One source fails in a multi-source run | test: "one failing source doesn't fail the others; the run is partial" |
| Source returns 304 | test: "returns not_modified on 304, resetting failures"; live: 3/8 sources at the 16:15 tick |
| `force: true` | tests: skips conditional headers and cooldown, still coalesces |
| Source hangs | test: `safe-fetch.test.ts` timeout. Config: job `expireInSeconds: 600`, `retryLimit: 2`, backoff; retry path in "throws for pg-boss to retry…" |
| Admin cancels a run | tests: "cancels queued jobs…" and "running jobs finish normally" |
| KEV first sync | test: "loads the whole catalog… only recent entries become items"; live: 1,769 CVEs, 13 items |
| Recluster during ingestion | test: `enrich.test.ts` "recluster queues behind clustering instead of being swallowed by a queued pipeline job". Clustering and recluster serialize on the story advisory lock |
| Interval change while a scheduled run is in progress | by design: jobs already enqueued are unaffected, and the schedule row changes for the next cron boundary |
| Admin raises interval (15 → 60), no burst | test: "raising the interval (15 → 60) causes no burst" |
| Admin pauses the scheduler | tests: "pausing removes the tick schedule" and "also cancel queued scheduled jobs…". Chrome: banner shown, schedule row removed, kept after worker restart |
| Settings saved while worker offline | test: sync job stays queued (`syncQueued`); worker syncs on startup (manual restart check). UI shows "Will apply when the worker is back online" |
| Interval that isn't a preset | test: "rejects non-preset intervals with nothing saved"; route maps it to 400 |
| Tick with no sources due | test: "no ingestion_runs row, but last_tick_at is written"; live 16:00 tick created no run |
| Global 5 min, KEV override 60 min | unit: `scheduler.test.ts` "KEV … stays hourly under a 5-min global tick"; live 16:15 tick skipped KEV |
| Next tick while previous still enqueuing | `exclusive` policy on `ingest.tick` (see above) |
| `WORKER_SCHEDULES_ENABLED=false` | manual: worker started with it set and `pgboss.schedule` went empty; UI disables the panel (`managedExternally`) |

Phase 2, checked by hand on 2026-11-08 against the dev stack:
- `pnpm recluster --since 2020-01-01 --inline` clustered 214 real items into 207
  stories. All 6 multi-item stories share a CVE; for example, SonicWall's
  CVE-2026-19868 joins its KEV entry and a SecurityWeek article.
- `pnpm enrich --stale` queued NVD for the 27 item-linked CVEs and scored EPSS
  for all of them in a single request. The worker drained the NVD jobs at 6.5s
  spacing, and a SQL check found 0 of 207 stories whose
  `max_cvss`/`has_kev`/`max_epss`/`item_count` differ from their CVEs and items.
- In Chrome: risk sort, search, KEV filter, story page, CVE page (a lowercase
  id redirects), admin "Re-enrich" (run succeeded, story refreshed) and "Recluster
  since 2026-11-01" (125 items released, the same 121 stories rebuilt).
- The new admin routes return 403 without a matching Origin and 401 without a
  session.

Also checked by hand (Phase 1):
- A fresh install schedules `*/15 * * * *`.
- Changing the interval in the panel rewrote the schedule to `0 */1 * * *` with no
  restart.
- `pnpm ingest --all --wait` created 249 items, and a forced re-run created 0.
- `/api/ingest` returns 401, 400, 202 and 429 for the matching requests.
- A forged session cookie is rejected by the layout and the admin API.
- Every `<script>` carries the nonce, and every external link has
  `rel="noopener noreferrer"`.
- The SSRF guard blocks `169.254.169.254` from the add-source Test.

## Phase 3 — Social sources, X, AI summaries, watchlists

The SPEC gives Phase 3 no acceptance criteria. These were agreed at the start of the phase:
- A Bluesky or Mastodon post that links to an article joins that article's story.
- X refuses to fetch once the monthly cap is reached, and does nothing while its flag is off.
- A story gets one summary, and a new one only when items join.
- A matching story sends exactly one alert per watchlist, plus one more if it later becomes KEV, including when the scan re-runs.

New dependencies, approved by the user: `@anthropic-ai/sdk` and `nodemailer` (with `@types/nodemailer`).

### Bluesky and Mastodon (migration 0004)
- **Source URL is the profile page.**
  - Bluesky: `https://bsky.app/profile/<handle>`. The adapter calls the public AppView `app.bsky.feed.getAuthorFeed` (no auth) with `filter=posts_no_replies&limit=50`.
  - Mastodon: `https://instance/@user`. The adapter reads `/@user.rss`, which already leaves out replies and boosts.
  - Admins paste the URL they see in a browser.
- **What is kept.** Reposts, pins, replies and quote paragraphs (`<p class="quote-inline">RE: …`) are skipped. A post is kept only when it:
  - mentions a CVE (in its text, its link or the link preview), or
  - links to an outside page and its text or link preview matches a security keyword (`SECURITY_KEYWORDS` in `src/ingest/adapters/social.ts`, whole words, plurals allowed).
- **Why keywords and not "any link".** The plan said "CVE or link". Real timelines showed links alone are mostly off-topic: newspaper features, YouTube, politics. With keywords, 5 of 50 of one journalist's posts survive, and all are on-topic. `config.filter: "all"` turns the filter off; `config.keywords` replaces the list.
- **What doesn't count as a link.** Links to the network itself are not articles: bsky.app, the account's own instance, mentions and hashtags.
- **URLs mirror HN.** The item URL is the linked article, so the post joins the article's story by rule 1. `raw.postUrl` keeps the permalink, which the story page shows as "Post on Bluesky/Mastodon". A post with no link uses its permalink.
- **Title** is the post's first line with bare URLs removed, at most 140 characters, so Mastodon's link text doesn't end up in titles.
- **14-day lookback.** Posts older than 14 days are ignored, so a new account's first sync doesn't import months of timeline.
- **Conditional GET.** Bluesky has none, so it always returns `ok` and items dedupe on the `at://` URI. Mastodon RSS sends ETags and gets 304s.
- **Curated accounts** are seeded through `pnpm db:seed` with the usual verification; all 10 verified on 2026-11-08.
  - Bluesky: Catalin Cimpanu, Zack Whittaker, Lorenzo Franceschi-Bicchierai, Dan Goodin, Kevin Beaumont.
  - Mastodon: Brian Krebs, Will Dormann, Kevin Beaumont, SANS ISC, watchTowr.
  - Accounts I rejected: `briankrebs.bsky.social` (a parody), `cyb3rops.bsky.social` (5 posts), and `@screaminggoat` (410 Gone).
