import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { closeDb, getPool } from "@/db/client";
import { clusterItems } from "@/ingest/cluster";
import { runSource } from "@/ingest/run-source";
import { addSource, fakeFetcher, fixture, resetDb, rssWith, startTestBoss } from "./helpers";

const NOW = new Date("2026-11-08T12:00:00Z");
let boss: PgBoss;

beforeAll(async () => {
  boss = await startTestBoss();
  await resetDb(boss);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await closeDb();
});

describe("social sources (Phase 3)", () => {
  it("a post linking to an article joins the article's story (rule 1); chatter never reaches the DB", async () => {
    await addSource({ id: "bc", category: "news" });
    await addSource({ id: "bsky", type: "bluesky", category: "social", url: "https://bsky.app/profile/researcher.example.com" });
    await addSource({ id: "masto", type: "mastodon", category: "social", url: "https://infosec.example/@grace" });

    const rss = rssWith([
      { guid: "a1", title: "Hospital chain hit by ransomware", link: "https://news.example.com/2026/11/hospital-ransomware" },
      { guid: "a2", title: "Botnet of TV boxes dismantled", link: "https://news.example.com/2026/11/botnet-takedown" },
    ]);
    await runSource("bc", { force: false, fetcher: fakeFetcher(() => ({ body: rss })), now: NOW, boss });
    const b = await runSource("bsky", { force: false, fetcher: fakeFetcher(() => ({ body: fixture("bsky-author-feed.json") })), now: NOW, boss });
    const m = await runSource("masto", { force: false, fetcher: fakeFetcher(() => ({ body: fixture("mastodon-account.rss") })), now: NOW, boss });
    expect([b.status, b.itemsNew, m.status, m.itemsNew]).toEqual(["succeeded", 5, "succeeded", 3]);

    await clusterItems({ windowDays: 14 });
    const { rows } = await getPool().query<{ title: string; item_count: number; source_ids: string[] }>(
      `SELECT title, item_count, source_ids FROM stories WHERE 'bc' = ANY(source_ids) ORDER BY title`,
    );
    expect(rows).toEqual([
      // utm_source and the trailing slash are canonicalized away; the news article names the story.
      { title: "Botnet of TV boxes dismantled", item_count: 2, source_ids: ["bc", "masto"] },
      { title: "Hospital chain hit by ransomware", item_count: 2, source_ids: ["bc", "bsky"] },
    ]);

    // Shared CVE (rule 2) between the two networks' CVE posts.
    const cve = await getPool().query<{ source_ids: string[] }>(
      `SELECT s.source_ids FROM stories s JOIN story_cves sc ON sc.story_id = s.id WHERE sc.cve_id = 'CVE-2026-12345'`,
    );
    expect(cve.rows).toEqual([{ source_ids: ["bsky", "masto"] }]);
  });

  it("re-running a social source is idempotent", async () => {
    const again = await runSource("bsky", { force: true, fetcher: fakeFetcher(() => ({ body: fixture("bsky-author-feed.json") })), now: NOW, boss });
    expect([again.itemsNew, again.itemsUpdated]).toEqual([0, 0]);
  });
});
