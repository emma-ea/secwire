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
- **`cacheComponents` stays on** (the scaffold default). Under Cache Components a
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

### Deferred to Phase 1
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
