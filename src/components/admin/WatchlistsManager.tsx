"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteWatchlistAction, previewWatchlistAction, saveWatchlistAction, testWatchlistAction } from "@/app/admin/actions";
import type { ChannelStatus } from "@/ingest/alerts";
import { LocalTime } from "../LocalTime";
import { Badge, btn, btnPrimary, input, Panel, StatusBadge } from "../ui";

type Channel = "slack" | "email";
type WatchlistView = {
  id: string;
  name: string;
  terms: string[];
  minCvss: number | null;
  kevOnly: boolean;
  ransomwareOnly: boolean;
  channels: Channel[];
  enabled: boolean;
};
type DeliveryView = {
  id: string;
  watchlist_name: string;
  kind: "new" | "kev";
  title: string;
  story_id: string | null;
  status: string;
  sent_channels: Channel[];
  attempts: number;
  error: string | null;
  created_at: string;
};

type Draft = { name: string; terms: string; minCvss: string; kevOnly: boolean; ransomwareOnly: boolean; channels: Channel[]; enabled: boolean };
const EMPTY: Draft = { name: "", terms: "", minCvss: "", kevOnly: false, ransomwareOnly: false, channels: [], enabled: true };

const toDraft = (w: WatchlistView): Draft => ({
  name: w.name,
  terms: w.terms.join(", "),
  minCvss: w.minCvss === null ? "" : String(w.minCvss),
  kevOnly: w.kevOnly,
  ransomwareOnly: w.ransomwareOnly,
  channels: w.channels,
  enabled: w.enabled,
});

const toInput = (d: Draft) => ({
  name: d.name.trim(),
  terms: d.terms.split(",").map((t) => t.trim()).filter(Boolean),
  minCvss: d.minCvss.trim() === "" ? null : Number(d.minCvss),
  kevOnly: d.kevOnly,
  ransomwareOnly: d.ransomwareOnly,
  channels: d.channels,
  enabled: d.enabled,
});

export function WatchlistsManager({
  watchlists,
  channels,
  deliveries,
}: {
  watchlists: WatchlistView[];
  channels: ChannelStatus;
  deliveries: DeliveryView[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null); // id, "new", or null
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [preview, setPreview] = useState<Array<{ id: string; title: string; has_kev: boolean; max_cvss: number | null }> | null>(null);
  const [pending, start] = useTransition();

  const open = (id: string | null, d: Draft) => {
    setEditing(id ?? "new");
    setDraft(d);
    setPreview(null);
    setMsg(null);
  };

  const save = () =>
    start(async () => {
      const r = await saveWatchlistAction(editing === "new" ? null : editing, toInput(draft));
      if (!r.ok) return setMsg({ text: r.error, error: true });
      setMsg({ text: `Saved. ${r.data.baselined} already-matching stor${r.data.baselined === 1 ? "y" : "ies"} won't alert.` });
      setEditing(null);
      router.refresh();
    });

  const runPreview = () =>
    start(async () => {
      const r = await previewWatchlistAction(toInput(draft));
      if (!r.ok) return setMsg({ text: r.error, error: true });
      setPreview(r.data);
    });

  const toggleChannel = (c: Channel) =>
    setDraft((d) => ({ ...d, channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : [...d.channels, c] }));

  return (
    <div className="space-y-4">
      <Panel
        title={`Watchlists (${watchlists.length})`}
        actions={
          <button type="button" className={btn} onClick={() => open(null, EMPTY)}>
            New watchlist
          </button>
        }
      >
        <p className="mb-2 text-[11px] text-muted">
          Channels: Slack {channels.slack.configured ? <Badge tone="ok">configured</Badge> : <Badge tone="muted">off</Badge>}{" "}
          {!channels.slack.configured && channels.slack.reason} · Email{" "}
          {channels.email.configured ? <Badge tone="ok">configured</Badge> : <Badge tone="muted">off</Badge>}{" "}
          {!channels.email.configured && channels.email.reason}
        </p>
        {watchlists.length === 0 ? (
          <p className="text-xs text-muted">No watchlists yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Terms</th>
                  <th>Filters</th>
                  <th>Channels</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {watchlists.map((w) => (
                  <tr key={w.id}>
                    <td>
                      {w.name} {!w.enabled && <Badge tone="muted">paused</Badge>}
                    </td>
                    <td className="max-w-64 truncate" title={w.terms.join(", ")}>
                      {w.terms.join(", ")}
                    </td>
                    <td className="whitespace-nowrap">
                      {[w.minCvss !== null ? `CVSS ≥ ${w.minCvss}` : null, w.kevOnly ? "KEV only" : null, w.ransomwareOnly ? "ransomware" : null]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="whitespace-nowrap">{w.channels.length ? w.channels.join(", ") : <span className="text-muted">none</span>}</td>
                    <td className="whitespace-nowrap text-right">
                      <button type="button" className={btn} onClick={() => open(w.id, toDraft(w))}>
                        Edit
                      </button>{" "}
                      <button
                        type="button"
                        className={btn}
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const r = await testWatchlistAction(w.id);
                            if (!r.ok) return setMsg({ text: r.error, error: true });
                            setMsg({
                              text: r.data.errors.length ? `Test: ${r.data.errors.join("; ")}` : `Test alert sent to ${r.data.sent.join(", ")}`,
                              error: r.data.errors.length > 0,
                            });
                          })
                        }
                      >
                        Send test
                      </button>{" "}
                      <button
                        type="button"
                        className={btn}
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const r = await deleteWatchlistAction(w.id);
                            if (!r.ok) return setMsg({ text: r.error, error: true });
                            setMsg({ text: `Deleted "${w.name}"` });
                            router.refresh();
                          })
                        }
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <p className={`mt-2 text-xs ${msg.error ? "text-red-700 dark:text-red-300" : "text-muted"}`}>{msg.text}</p>}
      </Panel>

      {editing && (
        <Panel title={editing === "new" ? "New watchlist" : "Edit watchlist"}>
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-muted">Name</span>
              <input className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Edge devices" />
            </label>
            <label className="grid gap-1">
              <span className="text-muted">Minimum CVSS (optional)</span>
              <input
                className={`${input} font-mono`}
                inputMode="decimal"
                value={draft.minCvss}
                onChange={(e) => setDraft({ ...draft, minCvss: e.target.value })}
                placeholder="—"
              />
            </label>
            <label className="grid gap-1 sm:col-span-2">
              <span className="text-muted">Terms (comma-separated vendors or products)</span>
              <input className={input} value={draft.terms} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} placeholder="Ivanti, Fortinet, Palo Alto Networks" />
            </label>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.kevOnly} onChange={(e) => setDraft({ ...draft, kevOnly: e.target.checked })} /> KEV only
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.ransomwareOnly} onChange={(e) => setDraft({ ...draft, ransomwareOnly: e.target.checked })} /> Ransomware-linked only
              </label>
              {(["slack", "email"] as const).map((c) => (
                <label key={c} className="flex items-center gap-1.5" title={channels[c].reason ?? undefined}>
                  <input type="checkbox" checked={draft.channels.includes(c)} onChange={() => toggleChannel(c)} /> {c}
                  {!channels[c].configured && <span className="text-muted">(not configured)</span>}
                </label>
              ))}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled
              </label>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={save} disabled={pending}>
              {pending ? "Working…" : "Save"}
            </button>
            <button type="button" className={btn} onClick={runPreview} disabled={pending}>
              Preview matches (7 days)
            </button>
            <button type="button" className={btn} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          {preview && (
            <div className="mt-3 text-xs">
              <p className="mb-1 text-muted">
                {preview.length} recent stor{preview.length === 1 ? "y" : "ies"} match. These are baselined on save, so they won&apos;t alert.
              </p>
              <ul className="space-y-0.5">
                {preview.map((s) => (
                  <li key={s.id}>
                    <Link href={`/story/${s.id}`} className="hover:underline">
                      {s.title}
                    </Link>
                    {s.has_kev && <span className="text-muted"> · KEV</span>}
                    {s.max_cvss !== null && <span className="text-muted"> · CVSS {s.max_cvss}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Recent alerts">
        {deliveries.length === 0 ? (
          <p className="text-xs text-muted">No alerts yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Watchlist</th>
                  <th>Kind</th>
                  <th>Story</th>
                  <th>Status</th>
                  <th>Channels</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap">
                      <LocalTime iso={d.created_at} />
                    </td>
                    <td>{d.watchlist_name}</td>
                    <td>{d.kind === "kev" ? "now KEV" : "new"}</td>
                    <td className="max-w-80 truncate" title={d.title}>
                      {d.story_id ? (
                        <Link href={`/story/${d.story_id}`} className="hover:underline">
                          {d.title}
                        </Link>
                      ) : (
                        d.title
                      )}
                    </td>
                    <td className="whitespace-nowrap" title={d.error ?? undefined}>
                      <StatusBadge status={d.status === "sent" ? "succeeded" : d.status} />
                      {d.attempts > 1 && <span className="text-muted"> ×{d.attempts}</span>}
                    </td>
                    <td className="whitespace-nowrap">{d.sent_channels.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
