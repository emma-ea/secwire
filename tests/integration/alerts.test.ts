import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb, getPool, withTransaction } from "@/db/client";
import { cves, itemCves, items } from "@/db/schema";
import { resetEnvCache } from "@/env";
import {
  createWatchlist,
  defaultSenders,
  emailMessage,
  matchingStories,
  recentDeliveries,
  scanAlerts,
  sendTestAlert,
  slackMessage,
  updateWatchlist,
  type AlertMessage,
  type Senders,
} from "@/ingest/alerts";
import { clusterItems, recluster } from "@/ingest/cluster";
import { refreshStoriesForCves } from "@/ingest/stories";
import { hashCanonicalUrl } from "@/lib/url";
import { addSource, fakeFetcher, resetDb } from "./helpers";

const now = Date.now();
let n = 0;

async function item(hoursAgo: number, title: string, cve?: string) {
  n++;
  const url = `https://news.example.com/a/${n}`;
  const at = new Date(now - hoursAgo * 3_600_000);
  const [row] = await getDb()
    .insert(items)
    .values({ sourceId: "bc", externalId: `e${n}`, url, canonicalUrlHash: hashCanonicalUrl(url), title, publishedAt: at, fetchedAt: at })
    .returning({ id: items.id });
  if (cve) await getDb().insert(itemCves).values({ itemId: row!.id, cveId: cve });
  return row!.id;
}

function fakeSenders(fail: { slack?: number; email?: number } = {}) {
  const sent = { slack: [] as string[], email: [] as Array<{ subject: string; text: string }> };
  const left = { ...fail };
  const senders: Senders = {
    async slack(m) {
      if ((left.slack ?? 0) > 0) {
        left.slack!--;
        throw new Error("slack down");
      }
      sent.slack.push(m.text);
    },
    async email(m) {
      if ((left.email ?? 0) > 0) {
        left.email!--;
        throw new Error("smtp down");
      }
      sent.email.push(m);
    },
  };
  return { senders, sent };
}

const CHANNEL_ENV = {
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXX",
  SMTP_URL: "smtp://localhost:2525",
  ALERT_EMAIL_FROM: "secwire@example.test",
  ALERT_EMAIL_TO: "admin@example.test",
  APP_URL: "https://secwire.example.test",
};
function setEnv(env: Record<string, string>) {
  for (const k of Object.keys(CHANNEL_ENV)) delete process.env[k];
  Object.assign(process.env, env);
  resetEnvCache();
}

beforeEach(async () => {
  await resetDb();
  await getDb().execute(sql`TRUNCATE watchlists, alert_deliveries CASCADE`);
  await addSource({ id: "bc", category: "news" });
  await getDb().insert(cves).values([
    { id: "CVE-2026-1001", cvssScore: 9.1, nvdVendor: "Ivanti", nvdProduct: "Connect Secure" },
    { id: "CVE-2026-1002", cvssScore: 7.2, nvdVendor: "Ivanti", nvdProduct: "EPMM" },
    { id: "CVE-2026-1003", cvssScore: 9.8, kevVendor: "Microsoft", kevProduct: "Exchange Server", inKev: true },
  ]);
  setEnv(CHANNEL_ENV);
});
afterEach(() => setEnv({}));
afterAll(() => closeDb());

describe("watchlist alerts (Phase 3)", () => {
  it("baselines existing matches, then alerts exactly once per new story; re-scans and recluster don't repeat", async () => {
    await item(30, "Ivanti Connect Secure flaw exploited", "CVE-2026-1001");
    await clusterItems({ windowDays: 14 });

    const { watchlist, baselined } = await createWatchlist({ name: "Ivanti", terms: ["ivanti"], channels: ["slack", "email"] });
    expect(baselined).toBe(1);
    const { senders, sent } = fakeSenders();
    expect(await scanAlerts({ senders })).toMatchObject({ locked: true, watchlists: 1, created: 0, sent: 0 });

    // A new Ivanti story arrives.
    await item(2, "Ivanti EPMM bug patched", "CVE-2026-1002");
    await clusterItems({ windowDays: 14 });
    expect(await scanAlerts({ senders })).toMatchObject({ created: 1, sent: 1, failed: 0 });
    expect(sent.slack).toHaveLength(1);
    expect(sent.slack[0]).toContain("*New story* · watchlist *Ivanti*");
    expect(sent.slack[0]).toContain("<https://secwire.example.test/story/");
    expect(sent.email[0]!.subject).toBe("[SecWire] Ivanti: Ivanti EPMM bug patched");

    // More coverage of the same story, re-scans, a recluster: still one alert.
    await item(1, "More on the Ivanti EPMM bug", "CVE-2026-1002");
    await clusterItems({ windowDays: 14 });
    expect(await scanAlerts({ senders })).toMatchObject({ created: 0, sent: 0 });
    await recluster(new Date(now - 48 * 3_600_000), { windowDays: 14 });
    expect(await scanAlerts({ senders })).toMatchObject({ created: 0, sent: 0 });
    expect(sent.slack).toHaveLength(1);
    expect((await recentDeliveries()).map((d) => [d.kind, d.status, d.sent_channels])).toEqual([["new", "sent", ["slack", "email"]]]);
    expect(watchlist.channels).toEqual(["slack", "email"]);
  });

  it("escalates once when an alerted story enters KEV (but not if it was KEV when first alerted)", async () => {
    await createWatchlist({ name: "Ivanti", terms: ["ivanti"], channels: ["slack"] });
    await createWatchlist({ name: "Exchange", terms: ["exchange"], channels: ["slack"] });
    await item(3, "Ivanti EPMM bug", "CVE-2026-1002");
    await item(3, "Exchange zero-day", "CVE-2026-1003");
    await clusterItems({ windowDays: 14 });
    const { senders, sent } = fakeSenders();
    expect(await scanAlerts({ senders })).toMatchObject({ created: 2, sent: 2 });

    await getDb().execute(sql`UPDATE cves SET in_kev = true WHERE id = 'CVE-2026-1002'`);
    await withTransaction((c) => refreshStoriesForCves(c, ["CVE-2026-1002", "CVE-2026-1003"]));
    expect(await scanAlerts({ senders })).toMatchObject({ created: 1, sent: 1 });
    expect(sent.slack.at(-1)).toContain("*Now in CISA KEV* · watchlist *Ivanti*");
    expect(await scanAlerts({ senders })).toMatchObject({ created: 0, sent: 0 });
  });

  it("filters: min CVSS, KEV only, whole-word title terms, vendor substring", async () => {
    await item(3, "Ivanti EPMM bug", "CVE-2026-1002"); // CVSS 7.2
    await item(3, "Exchange zero-day", "CVE-2026-1003"); // CVSS 9.8, KEV
    await item(3, "Stock exchanges hit by outage"); // no CVE; "exchanges" isn't the word "exchange"
    await item(3, "Exchange Online phishing wave"); // no CVE; title word match
    await clusterItems({ windowDays: 14 });
    const titles = async (w: Parameters<typeof matchingStories>[0]) => (await matchingStories(w)).map((s) => s.title).sort();
    const base = { minCvss: null, kevOnly: false, ransomwareOnly: false };
    expect(await titles({ ...base, terms: ["ivanti"] })).toEqual(["Ivanti EPMM bug"]);
    expect(await titles({ ...base, terms: ["ivanti"], minCvss: 8 })).toEqual([]);
    expect(await titles({ ...base, terms: ["exchange"] })).toEqual(["Exchange Online phishing wave", "Exchange zero-day"]);
    expect(await titles({ ...base, terms: ["exchange"], kevOnly: true })).toEqual(["Exchange zero-day"]);
    expect(await titles({ ...base, terms: ["micro"] })).toEqual(["Exchange zero-day"]); // vendor substring
    expect(await titles({ ...base, terms: ["100%_"] })).toEqual([]);
  });

  it("retries only the failed channel, up to 3 attempts", async () => {
    await createWatchlist({ name: "Ivanti", terms: ["ivanti"], channels: ["slack", "email"] });
    await item(3, "Ivanti EPMM bug", "CVE-2026-1002");
    await clusterItems({ windowDays: 14 });
    const { senders, sent } = fakeSenders({ email: 1 });
    expect(await scanAlerts({ senders })).toMatchObject({ created: 1, sent: 0, failed: 1 });
    expect((await recentDeliveries())[0]).toMatchObject({ status: "failed", sent_channels: ["slack"], attempts: 1, error: "email: smtp down" });
    expect(await scanAlerts({ senders })).toMatchObject({ sent: 1, failed: 0 });
    expect([sent.slack.length, sent.email.length]).toEqual([1, 1]);

    const stuck = fakeSenders({ slack: 99 });
    await item(2, "Ivanti Connect Secure flaw", "CVE-2026-1001");
    await clusterItems({ windowDays: 14 });
    for (let i = 0; i < 5; i++) await scanAlerts({ senders: stuck.senders });
    const failed = (await recentDeliveries()).find((d) => d.title === "Ivanti Connect Secure flaw")!;
    expect(failed).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("no configured channel → skipped (nothing sent); a disabled watchlist is ignored", async () => {
    setEnv({});
    const { watchlist } = await createWatchlist({ name: "Ivanti", terms: ["ivanti"], channels: ["slack"] });
    await item(3, "Ivanti EPMM bug", "CVE-2026-1002");
    await clusterItems({ windowDays: 14 });
    const { senders, sent } = fakeSenders();
    expect(await scanAlerts({ senders })).toMatchObject({ created: 1, skipped: 1 });
    expect(sent.slack).toHaveLength(0);
    expect(await sendTestAlert(watchlist.id, { senders })).toEqual({ sent: [], errors: ["no configured channel is selected for this watchlist"] });

    await updateWatchlist(watchlist.id, { name: "Ivanti", terms: ["ivanti", "epmm"], channels: ["slack"], enabled: false });
    await item(1, "Ivanti Connect Secure flaw", "CVE-2026-1001");
    await clusterItems({ windowDays: 14 });
    expect(await scanAlerts({ senders })).toMatchObject({ watchlists: 0, created: 0 });
  });

  it("a concurrent scan skips instead of double-sending", async () => {
    const c = await getPool().connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext('secwire:alerts'))");
      expect(await scanAlerts({ senders: fakeSenders().senders })).toMatchObject({ locked: false });
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('secwire:alerts'))");
      c.release();
    }
  });

  it("test alert uses the latest match", async () => {
    const { watchlist } = await createWatchlist({ name: "Ivanti", terms: ["ivanti"], channels: ["slack"] });
    await item(3, "Ivanti EPMM bug", "CVE-2026-1002");
    await clusterItems({ windowDays: 14 });
    const { senders, sent } = fakeSenders();
    expect(await sendTestAlert(watchlist.id, { senders })).toEqual({ sent: ["slack"], errors: [] });
    expect(sent.slack[0]).toContain("*Test alert*");
    expect(sent.slack[0]).toContain("Ivanti EPMM bug");
  });

  it("the Slack sender POSTs JSON to the webhook, never following redirects", async () => {
    const f = fakeFetcher(() => ({ status: 200, body: "ok" }));
    await defaultSenders({ fetcher: f }).slack({ text: "hi" });
    expect(f.calls[0]).toMatchObject({
      url: CHANNEL_ENV.SLACK_WEBHOOK_URL,
      opts: { method: "POST", body: '{"text":"hi"}', maxRedirects: 0, headers: { "content-type": "application/json" } },
    });
    await expect(defaultSenders({ fetcher: fakeFetcher(() => ({ status: 404 })) }).slack({ text: "x" })).rejects.toThrow(/HTTP 404/);
  });
});

describe("alert message formatting", () => {
  const story: AlertMessage["story"] = {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    title: "<!channel> pwned & <b>owned</b>\r\nBcc: victim@example.com",
    has_kev: true,
    has_ransomware: false,
    max_cvss: 9.8,
    max_epss: 0.97,
    max_epss_percentile: 0.999,
    cve_ids: ["CVE-2026-1003"],
    source_ids: ["bc", "talos"],
    summary: "Attackers are exploiting it.",
    vendor_products: ["Microsoft Exchange Server"],
  };

  it("Slack: escapes control characters so feed text can't ping the channel or inject links", () => {
    const { text } = slackMessage({ kind: "kev", watchlist: "MS", story });
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt; pwned &amp; &lt;b&gt;owned&lt;/b&gt;");
    expect(text).toContain("CISA KEV (exploited) · CVSS 9.8 CRITICAL · EPSS 97% (99th pct) · CVE-2026-1003 · Microsoft Exchange Server");
  });

  it("email: plain text, single-line subject (no header injection)", () => {
    const { subject, text } = emailMessage({ kind: "new", watchlist: "MS", story });
    expect(subject).toBe("[SecWire] MS: <!channel> pwned & <b>owned</b> Bcc: victim@example.com");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text).toContain("AI summary: Attackers are exploiting it.");
    expect(text).toContain("2 sources");
  });
});
