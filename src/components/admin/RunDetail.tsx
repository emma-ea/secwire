"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { cancelRunAction } from "@/app/admin/actions";
import { LocalTime } from "../LocalTime";
import { btn, Panel, StatusBadge } from "../ui";

export type RunDetailData = {
  id: string;
  trigger: string;
  triggeredBy: string | null;
  kind: string;
  scope: Record<string, unknown>;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: { sources?: number; itemsSeen?: number; itemsNew?: number; itemsUpdated?: number } & Record<string, unknown>;
  error: string | null;
  sources: Array<{
    sourceId: string;
    jobId: string | null;
    status: string;
    coalescedIntoJobId: string | null;
    httpStatus: number | null;
    itemsSeen: number;
    itemsNew: number;
    itemsUpdated: number;
    durationMs: number | null;
    error: string | null;
    attempts: number;
  }>;
};

export function RunDetail({ initial }: { initial: RunDetailData }) {
  const [run, setRun] = useState(initial);
  const [pending, startTransition] = useTransition();
  const active = run.status === "queued" || run.status === "running";
  // Enrich and recluster runs are one job with no per-source rows.
  const isJobRun = run.kind === "enrich" || run.kind === "recluster";

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/admin/runs/${run.id}`, { cache: "no-store" });
    if (res.ok) setRun((await res.json()) as RunDetailData);
  }, [run.id]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(t);
  }, [active, refresh]);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2 normal-case tracking-normal">
          Run <span className="font-mono">{run.id}</span> <StatusBadge status={run.status} />
        </span>
      }
      actions={
        active && !isJobRun ? (
          <button
            type="button"
            className={btn}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await cancelRunAction(run.id);
                await refresh();
              })
            }
          >
            Cancel queued jobs
          </button>
        ) : null
      }
    >
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Trigger</dt>
        <dd>
          {run.trigger}
          {run.triggeredBy ? ` · ${run.triggeredBy}` : ""} · {run.kind}
        </dd>
        <dt className="text-muted">Scope</dt>
        <dd className="font-mono">{JSON.stringify(run.scope)}</dd>
        <dt className="text-muted">Created</dt>
        <dd>
          <LocalTime iso={run.createdAt} mode="datetime" />
        </dd>
        <dt className="text-muted">Finished</dt>
        <dd>
          <LocalTime iso={run.finishedAt} mode="datetime" fallback="—" />
        </dd>
        {isJobRun ? (
          <>
            {Object.entries(run.stats).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono">{v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
            {run.error && (
              <>
                <dt className="text-muted">Error</dt>
                <dd className="whitespace-pre-wrap text-red-700 dark:text-red-300">{run.error}</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt className="text-muted">Items</dt>
            <dd className="font-mono">
              {run.stats.itemsSeen ?? 0} seen · {run.stats.itemsNew ?? 0} new · {run.stats.itemsUpdated ?? 0} updated
            </dd>
          </>
        )}
      </dl>

      {!isJobRun && (
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Seen</th>
              <th>New</th>
              <th>Updated</th>
              <th>ms</th>
              <th>Attempts</th>
              <th>Job</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {run.sources.map((s) => (
              <tr key={s.sourceId}>
                <td className="font-mono">{s.sourceId}</td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="font-mono">{s.httpStatus ?? "—"}</td>
                <td className="font-mono">{s.itemsSeen}</td>
                <td className="font-mono">{s.itemsNew}</td>
                <td className="font-mono">{s.itemsUpdated}</td>
                <td className="font-mono">{s.durationMs ?? "—"}</td>
                <td className="font-mono">{s.attempts || "—"}</td>
                <td className="font-mono text-[11px] text-muted">
                  {s.coalescedIntoJobId ? `→ ${s.coalescedIntoJobId.slice(0, 8)}` : (s.jobId?.slice(0, 8) ?? "—")}
                </td>
                <td className="max-w-md whitespace-pre-wrap text-red-700 dark:text-red-300">{s.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </Panel>
  );
}
