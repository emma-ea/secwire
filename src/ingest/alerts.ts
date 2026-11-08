/**
 * Vendor watchlists with Slack/email alerts (Phase 3).
 *
 * A story matches a watchlist when one of its terms appears (case-insensitive
 * substring) in a linked CVE's KEV/NVD vendor or product, or as a whole word in
 * the story title, and it passes the watchlist's CVSS/KEV/ransomware filters.
 *
 * At most once: alert_deliveries has a unique (watchlist, anchor item, kind)
 * row. The anchor is the story's earliest item, which survives recluster
 * (story ids don't). Kinds:
 *   - "new": the first time a story matches;
 *   - "kev": once more if the story was not in KEV at its "new" alert and now is.
 * Saving a watchlist writes "new" rows with status "skipped" for stories that
 * already match (baseline), so creating one doesn't flood the channels.
 *
 * scanAlerts() runs as the alerts.scan job (after clustering and enrichment,
 * and on every tick): match → insert rows (ON CONFLICT DO NOTHING) → deliver
 * pending rows. Failed deliveries retry on later scans, up to MAX_ATTEMPTS, and
 * only to channels that haven't accepted the alert yet.
 */
import { createTransport, type Transporter } from "nodemailer";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { getPool, withTransaction, type Queryable } from "../db/client";
import { getEnv } from "../env";
import { safeFetch } from "../lib/safe-fetch";
import { epssPercent, percentileLabel, severityFor } from "../lib/severity";
import type { Fetcher } from "./adapters/types";
import { getSenderBoss, QUEUES } from "./boss";

export const ALERT_CHANNELS = ["slack", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];
/** Stories active this recently are matched (and baselined). */
export const ALERT_WINDOW_DAYS = 7;
export const MAX_ATTEMPTS = 3;
const ALERT_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('secwire:alerts')) AS locked";
const ALERT_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('secwire:alerts'))";

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

export const watchlistInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    terms: z
      .array(z.string().trim().min(2, "terms need at least 2 characters").max(100))
      .min(1)
      .max(50)
      .transform((ts) => [...new Set(ts)]),
    minCvss: z.number().min(0).max(10).nullable().default(null),
    kevOnly: z.boolean().default(false),
    ransomwareOnly: z.boolean().default(false),
    channels: z
      .array(z.enum(ALERT_CHANNELS))
      .max(2)
      .default([])
      .transform((cs) => [...new Set(cs)]),
    enabled: z.boolean().default(true),
  })
  .strict();
export type WatchlistInput = z.input<typeof watchlistInputSchema>;
export type Watchlist = z.output<typeof watchlistInputSchema> & { id: string; createdAt: Date; updatedAt: Date };

type WatchlistRow = {
  id: string;
  name: string;
  terms: string[];
  min_cvss: string | null;
  kev_only: boolean;
  ransomware_only: boolean;
  channels: AlertChannel[] | string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

/** node-postgres returns arrays of custom enums as "{a,b}" strings. */
function enumArray<T extends string>(v: T[] | string): T[] {
  if (Array.isArray(v)) return v;
  const inner = v.replace(/^\{|\}$/g, "");
  return (inner ? inner.split(",") : []) as T[];
}

function toWatchlist(r: WatchlistRow): Watchlist {
  return {
    id: r.id,
    name: r.name,
    terms: r.terms,
    minCvss: r.min_cvss === null ? null : Number(r.min_cvss),
    kevOnly: r.kev_only,
    ransomwareOnly: r.ransomware_only,
    channels: enumArray<AlertChannel>(r.channels),
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const WL_COLUMNS = "id, name, terms, min_cvss, kev_only, ransomware_only, channels, enabled, created_at, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listWatchlists(q: Queryable = getPool()): Promise<Watchlist[]> {
  const r = await q.query<WatchlistRow>(`SELECT ${WL_COLUMNS} FROM watchlists ORDER BY lower(name), id`);
  return r.rows.map(toWatchlist);
}

export async function getWatchlist(id: string, q: Queryable = getPool()): Promise<Watchlist | null> {
  if (!UUID.test(id)) return null;
  const r = await q.query<WatchlistRow>(`SELECT ${WL_COLUMNS} FROM watchlists WHERE id = $1`, [id]);
  return r.rows[0] ? toWatchlist(r.rows[0]) : null;
}

/** Creates a watchlist and baselines stories that already match. */
export async function createWatchlist(input: WatchlistInput): Promise<{ watchlist: Watchlist; baselined: number }> {
  const w = watchlistInputSchema.parse(input);
  return withTransaction(async (c) => {
    const r = await c.query<WatchlistRow>(
      `INSERT INTO watchlists (name, terms, min_cvss, kev_only, ransomware_only, channels, enabled)
       VALUES ($1, $2, $3, $4, $5, $6::alert_channel[], $7) RETURNING ${WL_COLUMNS}`,
      [w.name, w.terms, w.minCvss, w.kevOnly, w.ransomwareOnly, w.channels, w.enabled],
    );
    const watchlist = toWatchlist(r.rows[0]!);
    return { watchlist, baselined: await baseline(c, watchlist) };
  });
}

/** Replaces a watchlist's settings; stories that newly match because of the edit are baselined too. */
export async function updateWatchlist(id: string, input: WatchlistInput): Promise<{ watchlist: Watchlist; baselined: number } | null> {
  if (!UUID.test(id)) return null;
  const w = watchlistInputSchema.parse(input);
  return withTransaction(async (c) => {
    const r = await c.query<WatchlistRow>(
      `UPDATE watchlists SET name = $2, terms = $3, min_cvss = $4, kev_only = $5, ransomware_only = $6,
              channels = $7::alert_channel[], enabled = $8, updated_at = now()
        WHERE id = $1 RETURNING ${WL_COLUMNS}`,
      [id, w.name, w.terms, w.minCvss, w.kevOnly, w.ransomwareOnly, w.channels, w.enabled],
    );
    if (!r.rows[0]) return null;
    const watchlist = toWatchlist(r.rows[0]);
    return { watchlist, baselined: await baseline(c, watchlist) };
  });
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await getPool().query("DELETE FROM watchlists WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type MatchedStory = {
  id: string;
  title: string;
  anchor_item_id: string;
  item_count: number;
  has_kev: boolean;
  has_ransomware: boolean;
  max_cvss: number | null;
  max_epss: number | null;
  max_epss_percentile: number | null;
  cve_ids: string[];
  source_ids: string[];
  summary: string | null;
  last_activity_at: Date;
  vendor_products: string[];
};

const likePattern = (t: string) => `%${t.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** Postgres ARE whole-word match: \m … \M around the escaped term. */
const wordRegex = (t: string) => `\\m${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\M`;

const STORY_FIELDS = `
  s.id, s.title, s.item_count, s.has_kev, s.has_ransomware, s.max_cvss::float8 AS max_cvss,
  s.max_epss::float8 AS max_epss, s.max_epss_percentile::float8 AS max_epss_percentile,
  s.cve_ids, s.source_ids, s.summary, s.last_activity_at,
  (SELECT i.id FROM items i WHERE i.story_id = s.id ORDER BY i.activity_at, i.id LIMIT 1) AS anchor_item_id,
  coalesce((SELECT array_agg(DISTINCT concat_ws(' ', coalesce(c.kev_vendor, c.nvd_vendor), coalesce(c.kev_product, c.nvd_product)))
              FROM story_cves sc JOIN cves c ON c.id = sc.cve_id
             WHERE sc.story_id = s.id AND coalesce(c.kev_vendor, c.nvd_vendor) IS NOT NULL), '{}') AS vendor_products`;

/** Stories active in the last `days` days that match the watchlist, most recent first. */
export async function matchingStories(
  w: Pick<Watchlist, "terms" | "minCvss" | "kevOnly" | "ransomwareOnly">,
  opts: { days?: number; limit?: number; q?: Queryable } = {},
): Promise<MatchedStory[]> {
  const q = opts.q ?? getPool();
  const r = await q.query<MatchedStory>(
    `SELECT ${STORY_FIELDS}
       FROM stories s
      WHERE s.last_activity_at > now() - make_interval(days => $1)
        AND ($2::numeric IS NULL OR s.max_cvss >= $2::numeric)
        AND (NOT $3::boolean OR s.has_kev)
        AND (NOT $4::boolean OR s.has_ransomware)
        AND (
          EXISTS (
            SELECT 1 FROM story_cves sc JOIN cves c ON c.id = sc.cve_id, unnest($5::text[]) p(pat)
             WHERE sc.story_id = s.id
               AND lower(concat_ws(' ', c.kev_vendor, c.kev_product, c.nvd_vendor, c.nvd_product)) LIKE p.pat
          )
          OR EXISTS (SELECT 1 FROM unnest($6::text[]) w(re) WHERE s.title ~* w.re)
        )
      ORDER BY s.last_activity_at DESC, s.id
      LIMIT $7`,
    [
      opts.days ?? ALERT_WINDOW_DAYS,
      w.minCvss,
      w.kevOnly,
      w.ransomwareOnly,
      w.terms.map(likePattern),
      w.terms.map(wordRegex),
      opts.limit ?? 500,
    ],
  );
  return r.rows.filter((s) => s.anchor_item_id);
}

async function baseline(q: Queryable, w: Watchlist): Promise<number> {
  let n = 0;
  for (const s of await matchingStories(w, { q })) {
    const r = await q.query(
      `INSERT INTO alert_deliveries (watchlist_id, anchor_item_id, kind, story_id, title, had_kev, status, error)
       VALUES ($1, $2, 'new', $3, $4, $5, 'skipped', 'already matched when the watchlist was saved')
       ON CONFLICT DO NOTHING`,
      [w.id, s.anchor_item_id, s.id, s.title, s.has_kev],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Channels and messages
// ---------------------------------------------------------------------------

export type ChannelStatus = Record<AlertChannel, { configured: boolean; reason: string | null }>;

export function channelStatus(): ChannelStatus {
  const env = getEnv();
  return {
    slack: { configured: Boolean(env.SLACK_WEBHOOK_URL), reason: env.SLACK_WEBHOOK_URL ? null : "SLACK_WEBHOOK_URL is not set" },
    email: {
      configured: Boolean(env.SMTP_URL && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO),
      reason: env.SMTP_URL && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO ? null : "SMTP_URL, ALERT_EMAIL_FROM and ALERT_EMAIL_TO must all be set",
    },
  };
}

export type AlertMessage = {
  kind: "new" | "kev" | "test";
  watchlist: string;
  story: Pick<
    MatchedStory,
    "id" | "title" | "has_kev" | "has_ransomware" | "max_cvss" | "max_epss" | "max_epss_percentile" | "cve_ids" | "source_ids" | "summary" | "vendor_products"
  >;
};

const oneLine = (s: string, max = 300) => {
  const t = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function storyUrl(id: string): string | null {
  const base = getEnv().APP_URL;
  return base ? `${base.replace(/\/+$/, "")}/story/${id}` : null;
}

function facts(s: AlertMessage["story"]): string[] {
  const out: string[] = [];
  if (s.has_kev) out.push("CISA KEV (exploited)");
  if (s.has_ransomware) out.push("ransomware-linked");
  if (s.max_cvss !== null) out.push(`CVSS ${s.max_cvss} ${severityFor(s.max_cvss) ?? ""}`.trim());
  if (s.max_epss !== null) {
    const pct = percentileLabel(s.max_epss_percentile);
    out.push(`EPSS ${epssPercent(s.max_epss)}${pct ? ` (${pct} pct)` : ""}`);
  }
  return out;
}

function headline(m: AlertMessage): string {
  return m.kind === "kev" ? "Now in CISA KEV" : m.kind === "test" ? "Test alert" : "New story";
}

/** Plain-text email (never HTML: feed text is untrusted). */
export function emailMessage(m: AlertMessage): { subject: string; text: string } {
  const s = m.story;
  const url = storyUrl(s.id);
  const lines = [
    `${headline(m)} for watchlist "${oneLine(m.watchlist, 100)}":`,
    "",
    oneLine(s.title, 500),
    facts(s).join(" · "),
    [s.cve_ids.slice(0, 10).join(", "), s.vendor_products.slice(0, 3).join(", ")].filter(Boolean).join(" · "),
    `${s.source_ids.length} source${s.source_ids.length === 1 ? "" : "s"}`,
  ];
  if (s.summary) lines.push("", `AI summary: ${oneLine(s.summary, 800)}`);
  if (url) lines.push("", url);
  lines.push("", "— SecWire watchlist alert");
  return {
    subject: oneLine(`[SecWire] ${m.watchlist}: ${m.kind === "kev" ? "now in KEV: " : m.kind === "test" ? "test: " : ""}${s.title}`, 200),
    text: lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"),
  };
}

/** Slack mrkdwn escaping: only &, < and > are special (this also neutralizes <!channel>-style mentions). */
export const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackMessage(m: AlertMessage): { text: string } {
  const s = m.story;
  const url = storyUrl(s.id);
  const title = slackEscape(oneLine(s.title, 300));
  const lines = [
    `*${headline(m)}* · watchlist *${slackEscape(oneLine(m.watchlist, 100))}*`,
    url ? `<${url}|${title.replace(/\|/g, "¦")}>` : title,
    slackEscape([...facts(s), s.cve_ids.slice(0, 5).join(", "), s.vendor_products.slice(0, 2).join(", ")].filter(Boolean).join(" · ")),
  ];
  if (s.summary) lines.push(`_${slackEscape(oneLine(s.summary, 600)).replace(/_/g, " ")}_`);
  return { text: lines.filter(Boolean).join("\n") };
}

export type Senders = {
  slack: (msg: { text: string }) => Promise<void>;
  email: (msg: { subject: string; text: string }) => Promise<void>;
};

let transport: Transporter | undefined;

/** Real senders from env; tests inject their own. */
export function defaultSenders(opts: { fetcher?: Fetcher } = {}): Senders {
  const env = getEnv();
  return {
    async slack(msg) {
      if (!env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL is not set");
      const res = await (opts.fetcher ?? safeFetch)(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
        timeoutMs: 15_000,
        maxRedirects: 0,
      });
      if (res.status < 200 || res.status > 299) throw new Error(`Slack webhook returned HTTP ${res.status}`);
    },
    async email(msg) {
      if (!env.SMTP_URL || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) throw new Error("email is not configured");
      transport ??= createTransport(env.SMTP_URL);
      await transport.sendMail({
        from: env.ALERT_EMAIL_FROM,
        to: env.ALERT_EMAIL_TO.split(",").map((a) => a.trim()).filter(Boolean),
        subject: msg.subject,
        text: msg.text,
      });
    },
  };
}

/** Sends to each channel; returns the ones that succeeded and errors for the rest. */
async function sendTo(channels: AlertChannel[], m: AlertMessage, senders: Senders): Promise<{ ok: AlertChannel[]; errors: string[] }> {
  const ok: AlertChannel[] = [];
  const errors: string[] = [];
  for (const ch of channels) {
    try {
      if (ch === "slack") await senders.slack(slackMessage(m));
      else await senders.email(emailMessage(m));
      ok.push(ch);
    } catch (err) {
      errors.push(`${ch}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    }
  }
  return { ok, errors };
}

/** "Send test alert" for one watchlist, using its most recent match (or a sample story). */
export async function sendTestAlert(id: string, deps: { senders?: Senders } = {}): Promise<{ sent: AlertChannel[]; errors: string[] } | null> {
  const w = await getWatchlist(id);
  if (!w) return null;
  const configured = channelStatus();
  const channels = w.channels.filter((c) => configured[c].configured);
  if (!channels.length) return { sent: [], errors: ["no configured channel is selected for this watchlist"] };
  const [story] = await matchingStories(w, { days: 30, limit: 1 });
  const sample: AlertMessage["story"] = story ?? {
    id: "00000000-0000-0000-0000-000000000000",
    title: `Example story matching ${w.terms[0]}`,
    has_kev: false,
    has_ransomware: false,
    max_cvss: null,
    max_epss: null,
    max_epss_percentile: null,
    cve_ids: [],
    source_ids: [],
    summary: null,
    vendor_products: [],
  };
  const r = await sendTo(channels, { kind: "test", watchlist: w.name, story: sample }, deps.senders ?? defaultSenders());
  return { sent: r.ok, errors: r.errors };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export type ScanResult = { locked: boolean; watchlists: number; created: number; sent: number; failed: number; skipped: number };

type PendingRow = {
  id: string;
  kind: "new" | "kev";
  attempts: number;
  sent_channels: AlertChannel[] | string;
  watchlist_name: string;
  channels: AlertChannel[] | string;
  anchor_item_id: string;
  title: string;
};

/** alerts.scan: match every enabled watchlist, record new alerts, deliver pending ones. */
export async function scanAlerts(deps: { senders?: Senders; q?: Queryable } = {}): Promise<ScanResult> {
  const out: ScanResult = { locked: false, watchlists: 0, created: 0, sent: 0, failed: 0, skipped: 0 };
  const client = await getPool().connect();
  try {
    // One scanner at a time (any number of workers); a concurrent scan just skips.
    if (!(await client.query<{ locked: boolean }>(ALERT_LOCK_SQL)).rows[0]?.locked) return out;
    out.locked = true;
    try {
      const lists = (await listWatchlists(client)).filter((w) => w.enabled);
      out.watchlists = lists.length;
      for (const w of lists) {
        for (const s of await matchingStories(w, { q: client })) {
          const n = await client.query(
            `INSERT INTO alert_deliveries (watchlist_id, anchor_item_id, kind, story_id, title, had_kev)
             VALUES ($1, $2, 'new', $3, $4, $5) ON CONFLICT DO NOTHING`,
            [w.id, s.anchor_item_id, s.id, s.title, s.has_kev],
          );
          out.created += n.rowCount ?? 0;
          if (s.has_kev) {
            // Escalation: only after a "new" row written while the story wasn't in KEV.
            const k = await client.query(
              `INSERT INTO alert_deliveries (watchlist_id, anchor_item_id, kind, story_id, title, had_kev)
               SELECT $1, $2, 'kev', $3, $4, true
                WHERE EXISTS (SELECT 1 FROM alert_deliveries
                               WHERE watchlist_id = $1 AND anchor_item_id = $2 AND kind = 'new' AND NOT had_kev)
               ON CONFLICT DO NOTHING`,
              [w.id, s.anchor_item_id, s.id, s.title],
            );
            out.created += k.rowCount ?? 0;
          }
        }
      }
      await deliverPending(client, deps.senders ?? defaultSenders(), out);
    } finally {
      await client.query(ALERT_UNLOCK_SQL).catch(() => {});
    }
  } finally {
    client.release();
  }
  return out;
}

async function deliverPending(client: Queryable, senders: Senders, out: ScanResult): Promise<void> {
  const pending = await client.query<PendingRow>(
    `SELECT d.id, d.kind, d.attempts, d.sent_channels, d.anchor_item_id, d.title, w.name AS watchlist_name, w.channels
       FROM alert_deliveries d JOIN watchlists w ON w.id = d.watchlist_id
      WHERE d.status = 'pending' OR (d.status = 'failed' AND d.attempts < $1)
      ORDER BY d.created_at, d.id
      LIMIT 200`,
    [MAX_ATTEMPTS],
  );
  const configured = channelStatus();
  for (const d of pending.rows) {
    const done = enumArray<AlertChannel>(d.sent_channels);
    const wanted = enumArray<AlertChannel>(d.channels).filter((c) => configured[c].configured);
    // The story as it is now (it may have gained items or KEV since the row was written).
    const s = await client.query<MatchedStory>(
      `SELECT ${STORY_FIELDS} FROM stories s WHERE s.id = (SELECT story_id FROM items WHERE id = $1)`,
      [d.anchor_item_id],
    );
    const story = s.rows[0];
    if (!wanted.length || !story) {
      await client.query(`UPDATE alert_deliveries SET status = 'skipped', error = $2 WHERE id = $1`, [
        d.id,
        !story ? "story no longer exists" : "no configured channel is selected for this watchlist",
      ]);
      out.skipped++;
      continue;
    }
    const todo = wanted.filter((c) => !done.includes(c));
    const r = await sendTo(todo, { kind: d.kind, watchlist: d.watchlist_name, story }, senders);
    const sentChannels = [...done, ...r.ok];
    const failed = r.errors.length > 0;
    await client.query(
      `UPDATE alert_deliveries
          SET status = $2::alert_status, sent_channels = $3::alert_channel[], attempts = attempts + 1, error = $4,
              sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [d.id, failed ? "failed" : "sent", sentChannels, failed ? r.errors.join("; ") : null],
    );
    if (failed) out.failed++;
    else out.sent++;
  }
}

/** Enqueues alerts.scan when any watchlist is enabled (stately: coalesces with a queued scan). */
export async function enqueueAlertScan(deps: { boss?: PgBoss; q?: Queryable } = {}): Promise<boolean> {
  const r = await (deps.q ?? getPool()).query<{ any: boolean }>("SELECT EXISTS (SELECT 1 FROM watchlists WHERE enabled) AS any");
  if (!r.rows[0]?.any) return false;
  const boss = deps.boss ?? (await getSenderBoss());
  return (await boss.send(QUEUES.alertsScan, {})) !== null;
}

export type RecentDelivery = {
  id: string;
  watchlist_name: string;
  kind: "new" | "kev";
  title: string;
  story_id: string | null;
  status: string;
  sent_channels: AlertChannel[];
  attempts: number;
  error: string | null;
  created_at: Date;
};

export async function recentDeliveries(limit = 30, q: Queryable = getPool()): Promise<RecentDelivery[]> {
  const r = await q.query<RecentDelivery & { sent_channels: AlertChannel[] | string }>(
    `SELECT d.id, w.name AS watchlist_name, d.kind, d.title, d.story_id, d.status, d.sent_channels, d.attempts, d.error, d.created_at
       FROM alert_deliveries d JOIN watchlists w ON w.id = d.watchlist_id
      WHERE NOT (d.status = 'skipped' AND d.error = 'already matched when the watchlist was saved')
      ORDER BY d.created_at DESC, d.id LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ ...x, sent_channels: enumArray<AlertChannel>(x.sent_channels) }));
}
