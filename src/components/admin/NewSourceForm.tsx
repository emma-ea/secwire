"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSourceAction, testNewSourceAction } from "@/app/admin/actions";
import type { TestSourceResult } from "@/ingest/test-source";
import { btn, btnPrimary, input } from "../ui";
import { TestPreview } from "./TestPreview";

const TYPES = ["rss", "hackernews", "cisa_kev", "bluesky", "mastodon", "x"] as const;
const URL_PLACEHOLDER: Record<(typeof TYPES)[number], string> = {
  rss: "https://example.com/feed.xml",
  hackernews: "https://hn.algolia.com/api/v1/search_by_date",
  cisa_kev: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  bluesky: "https://bsky.app/profile/handle.example.com",
  mastodon: "https://infosec.exchange/@user",
  x: "https://api.x.com/2/tweets/search/recent",
};
const SOCIAL = new Set<string>(["bluesky", "mastodon", "x"]);
const CATEGORIES = ["news", "research", "advisory", "community", "social"] as const;
const HN_DEFAULT_QUERIES = "CVE, vulnerability, zero-day, exploit, ransomware, breach, RCE";

export function NewSourceForm() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("rss");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("news");
  const [url, setUrl] = useState("");
  const [override, setOverride] = useState("");
  const [hnQueries, setHnQueries] = useState(HN_DEFAULT_QUERIES);
  const [hnMinPoints, setHnMinPoints] = useState("20");
  const [xAccounts, setXAccounts] = useState("");
  const [result, setResult] = useState<TestSourceResult | null>(null);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();

  const config =
    type === "hackernews"
      ? {
          queries: hnQueries.split(",").map((q) => q.trim()).filter(Boolean),
          minPoints: Number(hnMinPoints) || 0,
        }
      : type === "x"
        ? { accounts: xAccounts.split(/[\s,]+/).map((a) => a.replace(/^@/, "")).filter(Boolean), filter: "relevant" }
        : SOCIAL.has(type)
          ? { filter: "relevant" }
          : {};
  // Save requires a successful test of exactly what will be saved.
  const key = JSON.stringify({ type, url: url.trim(), config });
  const canSave = result?.ok === true && testedKey === key && id && name;

  function test() {
    setError(null);
    startTest(async () => {
      const r = await testNewSourceAction({ type, url: url.trim(), config });
      setResult(r);
      setTestedKey(key);
    });
  }

  function save() {
    setError(null);
    startSave(async () => {
      const r = await createSourceAction({
        id: id.trim(),
        name: name.trim(),
        type,
        category,
        url: url.trim(),
        minIntervalMinutes: override.trim() ? Number(override) : null,
        config,
      });
      if (!r.ok) setError(r.error);
      else router.push("/admin");
    });
  }

  const field = "grid gap-1 text-xs";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          <span className="text-muted">ID (slug)</span>
          <input className={`${input} font-mono`} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="e.g. sans-isc" />
        </label>
        <label className={field}>
          <span className="text-muted">Name</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="SANS ISC" />
        </label>
        <label className={field}>
          <span className="text-muted">Type</span>
          <select className={input} value={type} onChange={(e) => {
              const t = e.target.value as (typeof TYPES)[number];
              setType(t);
              if (SOCIAL.has(t)) setCategory("social");
              if (t === "x") setUrl(URL_PLACEHOLDER.x);
            }}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className={field}>
          <span className="text-muted">Category</span>
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className={`${field} sm:col-span-2`}>
          <span className="text-muted">{type === "x" ? "API URL" : SOCIAL.has(type) ? "Profile URL" : "Feed / API URL"}</span>
          <input className={`${input} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDER[type]} />
        </label>
        <label className={field}>
          <span className="text-muted">Minimum interval override (minutes, optional)</span>
          <input className={`${input} font-mono`} inputMode="numeric" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="—" />
        </label>
        {SOCIAL.has(type) && (
          <p className="text-xs text-muted sm:col-span-2">
            Only posts that mention a CVE, or link out and match a security keyword, are kept. Replies and reposts are skipped.
          </p>
        )}
        {type === "x" && (
          <>
            <label className={`${field} sm:col-span-2`}>
              <span className="text-muted">Accounts (usernames, comma-separated)</span>
              <input className={`${input} font-mono`} value={xAccounts} onChange={(e) => setXAccounts(e.target.value)} placeholder="account1, account2" />
            </label>
            <p className="text-xs text-muted sm:col-span-2">
              Paid: X bills each post returned, and Test fetches count against the monthly cap. Runs hourly unless you set an override.
            </p>
          </>
        )}
        {type === "hackernews" && (
          <>
            <label className={`${field} sm:col-span-2`}>
              <span className="text-muted">Queries (comma-separated)</span>
              <input className={input} value={hnQueries} onChange={(e) => setHnQueries(e.target.value)} />
            </label>
            <label className={field}>
              <span className="text-muted">Minimum points</span>
              <input className={`${input} font-mono`} inputMode="numeric" value={hnMinPoints} onChange={(e) => setHnMinPoints(e.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={test} disabled={testing || !url.trim()}>
          {testing ? "Testing…" : "Test"}
        </button>
        <button type="button" className={btnPrimary} onClick={save} disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save source"}
        </button>
        {!canSave && result?.ok && testedKey !== key && <span className="text-xs text-muted">Inputs changed since the last test — test again.</span>}
        {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>

      {result && <TestPreview result={result} />}
    </div>
  );
}
