# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SecWire is a security-news aggregator: it ingests RSS, CISA KEV and Hacker News, enriches items with CVE data (NVD/EPSS/KEV), and clusters them into stories. **`SPEC.md` is the source of truth** for requirements; `DECISIONS.md` records every deviation from it and every resolved ambiguity.

## Working rules (from SPEC.md)

- Work **one phase at a time** (SPEC §12). At the start of a phase, propose a plan and wait for approval. At the end, run `pnpm typecheck && pnpm lint && pnpm test`, summarize, and stop. Phase 3 items are not built until asked.
- Don't add dependencies beyond SPEC §3 without asking.
- When something is ambiguous, pick the simpler option and record it in `DECISIONS.md`.
- Commit at each coherent step of progress, not only at the end of a phase.
- **Check the installed library's docs rather than relying on memory.** Next.js 16 ships its docs at `node_modules/next/dist/docs/` (see `AGENTS.md`). For pg-boss 12 and Drizzle 0.45, read the `.d.ts` files in `node_modules`. When an API differs from what SPEC.md names, follow the installed version and note it in `DECISIONS.md`.

## Commands

```bash
docker compose up -d db          # Postgres 17 on 127.0.0.1:5432
pnpm db:migrate                  # apply migrations (scripts/migrate.ts, runtime migrator)
pnpm db:seed                     # verify + insert the SPEC §9 sources (never overwrites existing rows)
pnpm dev:all                     # Next dev server + worker together
pnpm dev / pnpm dev:worker       # either one alone

pnpm ingest --all --wait         # enqueue all enabled sources, wait for results (see scripts/ingest.ts for flags)
pnpm ingest --source <id> --inline | --dry-run | --force
pnpm backfill:hn --since YYYY-MM-DD
pnpm enrich --cve CVE-2026-12345 [--inline|--wait]   # NVD + EPSS for one CVE
pnpm enrich --stale [--inline|--wait]                # the daily refresh, now
pnpm recluster --since YYYY-MM-DD [--inline|--wait]

pnpm typecheck                   # next typegen && tsc --noEmit (typegen creates LayoutProps/PageProps/RouteContext globals)
pnpm lint
pnpm test                        # unit + integration (integration needs the db container running)
pnpm test:unit                   # no database needed
pnpm test:integration            # uses a separate secwire_test DB, created + migrated by tests/integration/global-setup.ts
pnpm vitest run tests/cve.test.ts           # one file
pnpm vitest run -t "coalesces"              # by test name

pnpm db:generate                 # drizzle-kit: diff src/db/schema.ts -> new SQL migration
pnpm drizzle-kit generate --custom --name=<name>   # empty migration for hand-written SQL (e.g. data inserts)

docker compose --profile app up --build      # full stack in containers (migrate → web + worker); WEB_PORT overrides 3000
```

`.env` (copied from `.env.example`) is loaded by Next automatically, by the worker and scripts through `--env-file-if-exists`, and by `drizzle.config.ts` through `process.loadEnvFile()`. pnpm is pinned to 10.x via `packageManager`, because corepack 0.32 can't run pnpm ≥ 11.

## Architecture

**Two processes, one database.** The Next.js app (`src/app`) only reads Postgres and enqueues jobs. All external fetching runs in the pg-boss worker (`worker/index.ts`), except the admin "Test source" dry run. pg-boss keeps its queue in the `pgboss` schema of the same database; there is no Redis. Workers and schedules are registered **only** in `worker/index.ts`. The web app gets a send-only pg-boss instance (Phase 1).

**One service layer, many entry points.** The scheduler, admin UI, CLI (`scripts/`) and `POST /api/ingest` all go through `src/ingest/trigger.ts` → `src/ingest/run-source.ts`. Entry points contain no fetching logic of their own. `runSource` takes a per-source Postgres advisory lock, so a CLI `--inline` run and the worker can't overlap.

**Scheduler settings live in Postgres.** `app_settings` is a single-row table: its `CHECK (id)` constraint allows only one row, and migration `0001` inserts that row. pg-boss schedules are derived from it by the worker's `scheduler.sync` handler and are never edited directly. Interval presets live in `src/lib/scheduler.ts` and are mirrored in a CHECK constraint, so changing the list needs a migration.

**pg-boss gotcha:** `send()` returns `null` instead of throwing when a queue policy rejects a job. Check every result. For `ingest.source`, a `null` means the request was coalesced into an existing job (SPEC §7.1). Queue names, policies and schedule keys live in `src/ingest/boss.ts`. The worker creates queues at startup (`ensureQueues`); the web app and CLI use `getSenderBoss()`.

**Run bookkeeping.** Every trigger creates an `ingestion_runs` row plus one `ingestion_run_sources` row per source (`src/ingest/runs.ts`). The source rows move from `queued`/`running` to a terminal status, and whoever writes the last result finalizes the run (`finalizeRun`, which holds a row lock). These rows are also the arbiter for cancel: flip the row first, then cancel the job.

**Enrichment and clustering (Phase 2).** After `runSource` commits, `afterIngest` (`src/ingest/hooks.ts`) enqueues `cluster.items` and one `enrich.cve` per item-linked CVE that NVD hasn't been asked about yet. KEV catalog-only CVEs are deliberately never auto-enriched. `enrich.cve` runs at concurrency 1 behind the in-process NVD throttle (`src/ingest/enrich/throttle.ts`). `src/ingest/cluster.ts` implements the §6.5 rules and `recluster`. `src/ingest/stories.ts` `refreshStories()` is the **only** code that computes a story's denormalized fields (counts, times, `story_cves`, badges, vendors, title). Every writer of story rows takes the `secwire:stories` advisory lock (`lockStories`). Enrich and recluster runs are `ingestion_runs` rows with no per-source rows; `src/ingest/trigger-jobs.ts` creates them, used by the CLI, admin API and Server Actions alike. Recluster jobs use `singletonKey: "recluster"` so a queued pipeline cluster job can't swallow them.

**Read side.** Public pages (`/`, `/story/[id]`, `/cve/[id]`) query through `src/feed/queries.ts`. `src/feed/params.ts` is pure: it parses URL filters and encodes/validates keyset cursors, whose values are kept as Postgres text so timestamps keep microseconds.

**Job handlers** live in `src/ingest/handlers.ts` and are thin. `worker/index.ts` only wires them to queues, which is why integration tests can call `handleTick` and `handleSourceJob` directly.

### Conventions that span files

- **Env is checked when first used, not at import time.** Call `getEnv()` from `src/env.ts`; never read `process.env` directly. The web server checks the env at boot in `src/instrumentation.ts`, and the worker and scripts check it on startup. This keeps `next build` from needing secrets.
- **DB access:** use `getDb()` / `getPool()` from `src/db/client.ts`. They are lazy singletons cached on `globalThis` so they survive dev hot reloads. Long-running scripts call `closeDb()` when finished. SQL-heavy modules (clustering, story refresh, feed queries) use raw `pg` through `withTransaction()` / `Queryable`, because node-postgres passes JS arrays as Postgres arrays. Drizzle's `sql` template would spread them into separate params. Drizzle's `execute()` returns timestamps as strings; raw `pg` returns `Date`.
- **Column naming:** columns are camelCase in TypeScript and snake_case in SQL through Drizzle's `casing: "snake_case"`. That option must stay set in **both** `drizzle.config.ts` and `src/db/client.ts`. Raw `sql` strings use snake_case names.
- **Every page renders per request.** `cacheComponents` is off and the root layout calls `await connection()`, because `proxy.ts` sets a per-request nonce CSP (production: no `unsafe-inline`/`unsafe-eval`). Never add inline `<script>`, and don't use `style={...}` attributes in production paths; use Tailwind classes. Route handlers that read the DB call `await connection()` too.
- **Adapters** (`src/ingest/adapters/`) are pure: they fetch through an injectable `fetcher` (default `safeFetch`) and return `NormalizedItem[]` (plus `cves` for KEV). They never touch the DB; `runSource` persists. Tests pass `fetcher: fakeFetcher(...)` (`tests/helpers/fake-fetch.ts`) with files from `tests/fixtures/`, so no test touches the network. `runSource`, `triggerIngestion({inline})` and `handleSourceJob` all accept the same `fetcher` seam.
- **Admin:**
  - Pages live under `src/app/admin/(dashboard)/`. The route group's layout and each page call `requireAdmin()`; `/admin/login` sits outside the group.
  - UI mutations are Server Actions in `src/app/admin/actions.ts`; each one calls `requireAdmin()` and then the same service functions as the `/api/admin/*` routes.
  - Every route handler calls `guardAdminApi(req)`, which checks the Origin header on non-GET requests and the session.
- **Drizzle raw SQL inside `select({...})`:** `${table.col}` renders unqualified there. Correlated subqueries need explicit aliases (see `listSourcesForAdmin`).
- **Testable core, thin wrapper:** keep logic in pure functions under `src/lib` and test those directly; route handlers just call them. For example, `buildHealth()` / `readHealthSnapshot()` in `src/lib/health.ts` back `src/app/api/health/route.ts`. Tests in `tests/` use fixtures and never touch the network.
- **Security rules (SPEC §10):**
  - `proxy.ts` is not the auth boundary. `requireAdmin()` goes in the admin layout, in every admin route handler, and in every Server Action.
  - Every outbound fetch goes through `src/lib/safe-fetch.ts`, which applies the SSRF guard on each redirect hop.
  - Feed content is rendered as plain text only; never use `dangerouslySetInnerHTML` on it.
  - Public error responses never include internal error details.
- **Tests that enrich** pass `throttle: new Throttle(0, realClock, { initial: 1, max: 1 })` and a `fakeFetcher` serving `tests/fixtures/nvd-*.json` / `epss-batch.json`, so they never sleep or hit the network.
- **Dev server reload loop:** if every page reloads endlessly in `pnpm dev` (Turbopack HMR keeps sending `restart`), stop the dev server, delete `.next`, and start it again.
- `DECISIONS.md` ends with a table mapping every SPEC §7.4 scenario to its test or manual check. Keep it current when behavior changes.
