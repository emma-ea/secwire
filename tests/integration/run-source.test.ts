import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getPool } from "@/db/client";
import { cves, ingestionRunSources, items, sources } from "@/db/schema";
import { stopSenderBoss } from "@/ingest/boss";
import { runSource } from "@/ingest/run-source";
import { triggerIngestion } from "@/ingest/trigger";
import { addSource, count, fakeFetcher, fixture, resetDb, rssWith, startTestBoss } from "./helpers";

let boss: PgBoss;
beforeAll(async () => {
  boss = await startTestBoss();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await stopSenderBoss();
  await closeDb();
});
beforeEach(() => resetDb(boss));

const NOW = new Date("2026-11-08T12:00:00Z");

describe("runSource — idempotency (SPEC §2, §12)", () => {
  it("running a source twice creates zero new items the second time", async () => {
    await addSource({ id: "bc" });
    const fetcher = fakeFetcher(() => ({ body: fixture("rss-bleepingcomputer.xml") }));

    const first = await runSource("bc", { force: false, fetcher, now: NOW });
    expect(first).toMatchObject({ status: "succeeded", itemsSeen: 5, itemsNew: 5, itemsUpdated: 0 });

    const second = await runSource("bc", { force: false, fetcher, now: NOW });
    expect(second).toMatchObject({ status: "succeeded", itemsSeen: 5, itemsNew: 0, itemsUpdated: 0 });
    expect(await count("items")).toBe(5);
  });

  it("updates title/excerpt/url in place when they change, never duplicating", async () => {
    await addSource({ id: "s" });
    let title = "Original title";
    const fetcher = fakeFetcher(() => ({ body: rssWith([{ guid: "a", title }, { guid: "b", title: "Stable" }]) }));

    await runSource("s", { force: false, fetcher, now: NOW });
    title = "Updated title CVE-2026-4242";
    const r = await runSource("s", { force: false, fetcher, now: NOW });

    expect(r).toMatchObject({ itemsNew: 0, itemsUpdated: 1 });
    const rows = await getDb().select().from(items).orderBy(items.externalId);
    expect(rows.map((i) => i.title)).toEqual(["Updated title CVE-2026-4242", "Stable"]);
    // The new CVE from the updated title is linked and has a placeholder row.
    expect(await count("item_cves")).toBe(1);
    expect((await getDb().select().from(cves)).map((c) => c.id)).toEqual(["CVE-2026-4242"]);
  });

  it("writes item_cves and placeholder cves; search_vector is populated", async () => {
    await addSource({ id: "edge" });
    await runSource("edge", { force: false, fetcher: fakeFetcher(() => ({ body: fixture("rss-edge-cases.xml") })), now: NOW });
    expect(await count("items")).toBe(3);
    expect((await getDb().select({ id: cves.id }).from(cves).orderBy(cves.id)).map((c) => c.id)).toEqual([
      "CVE-2026-1234",
      "CVE-2026-2000",
      "CVE-2026-5678",
    ]);
    const hit = await getDb().execute(sql`SELECT count(*)::int AS n FROM items WHERE search_vector @@ plainto_tsquery('english', 'acme gateway')`);
    expect(hit.rows[0]).toEqual({ n: 1 });
  });

  it("stores validators and returns not_modified on 304, resetting failures", async () => {
    await addSource({ id: "s", consecutiveFailures: 3, lastError: "boom" });
    let status = 200;
    const fetcher = fakeFetcher(() =>
      status === 304 ? { status } : { body: rssWith([{ guid: "a", title: "x" }]), headers: { etag: '"v1"' } },
    );
    await runSource("s", { force: false, fetcher, now: NOW });
    status = 304;
    const r = await runSource("s", { force: false, fetcher, now: NOW });

    expect(r.status).toBe("not_modified");
    expect(fetcher.calls[1]!.opts.headers).toMatchObject({ "if-none-match": '"v1"' });
    const [src] = await getDb().select().from(sources).where(eq(sources.id, "s"));
    expect(src).toMatchObject({ etag: '"v1"', consecutiveFailures: 0, lastError: null });
    expect(src!.lastSuccessAt).not.toBeNull();
  });

  it("force skips conditional headers", async () => {
    await addSource({ id: "s", etag: '"v1"', lastModified: "Sat, 07 Nov 2026 00:00:00 GMT" });
    const fetcher = fakeFetcher(() => ({ body: rssWith([]) }));
    await runSource("s", { force: true, fetcher, now: NOW });
    expect(fetcher.calls[0]!.opts.headers).not.toHaveProperty("if-none-match");
  });
});

describe("runSource — CISA KEV first sync (SPEC §6.7, §7.4)", () => {
  it("loads the whole catalog into cves but only recent entries become items; idempotent", async () => {
    await addSource({ id: "cisa-kev", type: "cisa_kev", category: "advisory" });
    const fetcher = fakeFetcher(() => ({ body: fixture("kev.json") }));

    const r1 = await runSource("cisa-kev", { force: false, fetcher, now: NOW });
    expect(r1).toMatchObject({ status: "succeeded", itemsNew: 4 });
    expect(await count("items")).toBe(4);
    const kev = await getDb().select().from(cves).where(eq(cves.inKev, true));
    expect(kev.length).toBe(8);
    expect(kev.find((c) => c.id === "CVE-2026-19868")).toMatchObject({
      kevVendor: "SonicWall",
      kevDueDate: "2026-11-20",
      kevDateAdded: "2026-11-06",
    });

    const r2 = await runSource("cisa-kev", { force: false, fetcher, now: NOW });
    expect(r2).toMatchObject({ itemsNew: 0, itemsUpdated: 0 });
  });

  it("clears in_kev for CVEs that left the catalog", async () => {
    await addSource({ id: "cisa-kev", type: "cisa_kev", category: "advisory" });
    const full = JSON.parse(fixture("kev.json")) as { vulnerabilities: Array<{ cveID: string }> };
    let body = JSON.stringify(full);
    const fetcher = fakeFetcher(() => ({ body }));
    await runSource("cisa-kev", { force: false, fetcher, now: NOW });

    const removed = full.vulnerabilities[full.vulnerabilities.length - 1]!.cveID;
    body = JSON.stringify({ ...full, vulnerabilities: full.vulnerabilities.slice(0, -1) });
    await runSource("cisa-kev", { force: false, fetcher, now: NOW });

    const [row] = await getDb().select().from(cves).where(eq(cves.id, removed));
    expect(row!.inKev).toBe(false);
  });
});

describe("runSource — advisory lock (SPEC §6.2, §7.4)", () => {
  it("records skipped_locked when another session holds the source's lock", async () => {
    await addSource({ id: "s" });
    const holder = await getPool().connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('ingest:' || $1))", ["s"]);
      const fetcher = fakeFetcher(() => ({ body: rssWith([{ guid: "a", title: "x" }]) }));
      const r = await triggerIngestion({ trigger: "cli", sourceIds: ["s"], inline: true, fetcher });
      expect(r.sources[0]!.status).toBe("skipped_locked");
      expect(fetcher.calls).toHaveLength(0);
      expect(await count("items")).toBe(0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('ingest:' || $1))", ["s"]);
      holder.release();
    }
  });

  it("releases the lock afterwards, even when the fetch fails", async () => {
    await addSource({ id: "s" });
    await runSource("s", { force: false, fetcher: fakeFetcher(() => ({ status: 500 })) });
    const r = await getDb().execute<{ ok: boolean }>(
      sql`SELECT pg_try_advisory_lock(hashtext('ingest:s')) AS ok`,
    );
    expect(r.rows[0]!.ok).toBe(true);
    await getDb().execute(sql`SELECT pg_advisory_unlock(hashtext('ingest:s'))`);
  });
});

describe("runSource — failures (SPEC §6.2)", () => {
  it("a final failure increments consecutive_failures and sets last_error; sources are not auto-disabled", async () => {
    await addSource({ id: "s", consecutiveFailures: 4 });
    const r = await runSource("s", { force: false, fetcher: fakeFetcher(() => ({ status: 404 })) });
    expect(r).toMatchObject({ status: "failed", httpStatus: 404, retryable: false });
    const [src] = await getDb().select().from(sources).where(eq(sources.id, "s"));
    expect(src).toMatchObject({ consecutiveFailures: 5, enabled: true, lastError: expect.stringContaining("404") });
  });

  it("a retryable failure on a non-final attempt doesn't count yet and leaves the row running", async () => {
    await addSource({ id: "s" });
    const t = await triggerIngestion({ trigger: "admin", sourceIds: ["s"], boss });
    const r = await runSource("s", {
      runId: t.runId!,
      force: false,
      attempt: 1,
      isFinalAttempt: false,
      fetcher: fakeFetcher(() => ({ status: 503 })),
    });
    expect(r).toMatchObject({ status: "failed", retryable: true });
    const [row] = await getDb().select().from(ingestionRunSources);
    expect(row).toMatchObject({ status: "running", httpStatus: 503, attempts: 1 });
    const [src] = await getDb().select().from(sources);
    expect(src!.consecutiveFailures).toBe(0);
  });
});
