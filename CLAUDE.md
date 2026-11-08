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
pnpm dev:all                     # Next dev server + worker together
pnpm dev / pnpm dev:worker       # either one alone

pnpm typecheck                   # next typegen && tsc --noEmit (typegen creates LayoutProps/PageProps globals)
pnpm lint
pnpm test                        # vitest run
pnpm vitest run tests/env.test.ts         # one file
pnpm vitest run -t "rejects a non-boolean" # by test name

pnpm db:generate                 # drizzle-kit: diff src/db/schema.ts -> new SQL migration
pnpm drizzle-kit generate --custom --name=<name>   # empty migration for hand-written SQL (e.g. data inserts)
```

`.env` (copied from `.env.example`) is loaded by Next automatically, by the worker and scripts through `--env-file-if-exists`, and by `drizzle.config.ts` through `process.loadEnvFile()`. pnpm is pinned to 10.x via `packageManager`, because corepack 0.32 can't run pnpm ≥ 11.

## Architecture

**Two processes, one database.** The Next.js app (`src/app`) only reads Postgres and enqueues jobs. All external fetching runs in the pg-boss worker (`worker/index.ts`), except the admin "Test source" dry run. pg-boss keeps its queue in the `pgboss` schema of the same database; there is no Redis. Workers and schedules are registered **only** in `worker/index.ts`. The web app gets a send-only pg-boss instance (Phase 1).

**One service layer, many entry points.** The scheduler, admin UI, CLI (`scripts/`) and `POST /api/ingest` all go through `src/ingest/trigger.ts` → `src/ingest/run-source.ts`. Entry points contain no fetching logic of their own. `runSource` takes a per-source Postgres advisory lock, so a CLI `--inline` run and the worker can't overlap.

**Scheduler settings live in Postgres.** `app_settings` is a single-row table: its `CHECK (id)` constraint allows only one row, and migration `0001` inserts that row. pg-boss schedules are derived from it by the worker's `scheduler.sync` handler and are never edited directly. Interval presets live in `src/lib/scheduler.ts` and are mirrored in a CHECK constraint, so changing the list needs a migration.

**pg-boss gotcha:** `send()` returns `null` instead of throwing when a queue policy rejects a job. Check every result. For `ingest.source`, a `null` means the request was coalesced into an existing job (SPEC §7.1).

### Conventions that span files

- **Env is checked when first used, not at import time.** Call `getEnv()` from `src/env.ts`; never read `process.env` directly. The web server checks the env at boot in `src/instrumentation.ts`, and the worker and scripts check it on startup. This keeps `next build` from needing secrets.
- **DB access:** use `getDb()` / `getPool()` from `src/db/client.ts`. They are lazy singletons cached on `globalThis` so they survive dev hot reloads. Long-running scripts call `closeDb()` when finished.
- **Column naming:** columns are camelCase in TypeScript and snake_case in SQL through Drizzle's `casing: "snake_case"`. That option must stay set in **both** `drizzle.config.ts` and `src/db/client.ts`. Raw `sql` strings use snake_case names.
- **Cache Components is on** (`next.config.ts`). `GET` route handlers and pages get prerendered unless they touch runtime data. Any handler or page that reads the DB must call `await connection()` from `next/server`, or use Suspense, so it runs per request.
- **Testable core, thin wrapper:** keep logic in pure functions under `src/lib` and test those directly; route handlers just call them. For example, `buildHealth()` / `readHealthSnapshot()` in `src/lib/health.ts` back `src/app/api/health/route.ts`. Tests in `tests/` use fixtures and never touch the network.
- **Security rules (SPEC §10):**
  - `proxy.ts` is not the auth boundary. `requireAdmin()` goes in the admin layout, in every admin route handler, and in every Server Action.
  - Every outbound fetch goes through `src/lib/safe-fetch.ts`, which applies the SSRF guard on each redirect hop.
  - Feed content is rendered as plain text only; never use `dangerouslySetInnerHTML` on it.
  - Public error responses never include internal error details.
- The `package.json` scripts for later phases (`ingest`, `db:seed`, `enrich`, `recluster`, `backfill:hn`) are stubs that exit 1 until their phase implements them.
