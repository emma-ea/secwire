"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { reclusterAction } from "@/app/admin/actions";
import type { DashboardStatus } from "@/ingest/dashboard";
import { btn, input, Panel } from "../ui";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** "Recluster since…" (SPEC §7.2 B) plus the enrich/cluster backlog. */
export function ClusterPanel({ backlog, onDone }: { backlog: DashboardStatus["backlog"]; onDone: () => void }) {
  const [since, setSince] = useState(() => daysAgo(7));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; runId?: string; error?: boolean } | null>(null);

  return (
    <Panel title="Stories & enrichment">
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <dt className="text-muted">Stories</dt>
        <dd className="font-mono">{backlog.stories}</dd>
        <dt className="text-muted">Items awaiting clustering</dt>
        <dd className="font-mono">{backlog.unclusteredItems}</dd>
        <dt className="text-muted">CVEs awaiting NVD</dt>
        <dd className="font-mono">{backlog.nvdPending}</dd>
        <dt className="text-muted">CVEs awaiting EPSS</dt>
        <dd className="font-mono">{backlog.epssPending}</dd>
      </dl>
      <form
        className="flex flex-wrap items-center gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          start(async () => {
            const r = await reclusterAction(since);
            if (!r.ok) return setMsg({ text: r.error, error: true });
            setMsg({ text: r.data.status === "coalesced" ? "A recluster is already queued" : "Recluster queued", runId: r.data.runId });
            onDone();
          });
        }}
      >
        <label htmlFor="recluster-since">Recluster since</label>
        <input
          id="recluster-since"
          type="date"
          required
          max={daysAgo(0)}
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className={input}
        />
        <button type="submit" className={btn} disabled={pending}>
          {pending ? "Queuing…" : "Recluster"}
        </button>
      </form>
      <p className="mt-1 text-[11px] text-muted">
        Unassigns items from that date on, removes emptied stories and clusters again. Queues behind any clustering in progress.
      </p>
      {msg && (
        <p className={`mt-1 text-xs ${msg.error ? "text-red-700 dark:text-red-300" : ""}`}>
          {msg.text}
          {msg.runId && (
            <>
              {" · "}
              <Link href={`/admin/runs/${msg.runId}`} className="text-accent hover:underline">
                view run
              </Link>
            </>
          )}
        </p>
      )}
    </Panel>
  );
}
