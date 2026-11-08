"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { runIngestAction } from "@/app/admin/actions";
import type { DashboardStatus } from "@/ingest/dashboard";
import type { SchedulerState } from "@/ingest/scheduler-service";
import { btn, btnPrimary, Panel } from "../ui";
import { ClusterPanel } from "./ClusterPanel";
import { RunsTable } from "./RunsTable";
import { SchedulerPanel } from "./SchedulerPanel";
import { SourcesTable } from "./SourcesTable";
import { WorkerPill } from "./WorkerPill";

const POLL_MS = 3_000;

export function Dashboard({ initialStatus, scheduler }: { initialStatus: DashboardStatus; scheduler: SchedulerState }) {
  const [status, setStatus] = useState(initialStatus);
  const [sched, setSched] = useState(scheduler);
  const [kick, setKick] = useState(0);
  const inFlight = useRef(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/admin/status", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      if (res.ok) setStatus((await res.json()) as DashboardStatus);
    } finally {
      inFlight.current = false;
    }
  }, [router]);

  const refreshScheduler = useCallback(async () => {
    const res = await fetch("/api/admin/settings/scheduler", { cache: "no-store" });
    if (res.ok) setSched((await res.json()) as SchedulerState);
  }, []);

  const changed = useCallback(() => {
    void refresh();
    setKick((k) => k + 1);
  }, [refresh]);

  // Poll every 3s while anything is queued/running; stop when all runs are done (SPEC §7.4).
  const active =
    status.runs.some((r) => r.status === "queued" || r.status === "running") || status.sources.some((s) => s.busy);
  useEffect(() => {
    if (!active && kick === 0) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    // After a user action, poll at least briefly even if nothing looks active yet.
    const stopKick = active ? undefined : setTimeout(() => setKick(0), POLL_MS * 2 + 500);
    return () => {
      clearInterval(t);
      if (stopKick) clearTimeout(stopKick);
    };
  }, [active, kick, refresh]);

  const schedulerActive = sched.enabled && !sched.managedExternally;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Admin</h1>
        <WorkerPill online={status.worker.online} lastBeatAgeSec={status.worker.lastBeatAgeSec} />
        {active && <span className="text-xs text-muted">live · refreshing every 3s</span>}
      </div>

      {!sched.enabled && !sched.managedExternally && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <strong>Scheduler paused.</strong> No scheduled ingestion runs. Manual triggers still work.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <SchedulerPanel
          initial={sched}
          workerOnline={status.worker.online}
          sources={status.sources}
          onSaved={() => {
            void refreshScheduler();
            changed();
          }}
        />
        <div className="space-y-4">
        <Panel title="Queues">
          {status.queues === null ? (
            <p className="text-xs text-muted">pg-boss unavailable (has the worker ever started?)</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Queued</th>
                  <th>Active</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {status.queues.map((q) => (
                  <tr key={q.name}>
                    <td className="font-mono">{q.name}</td>
                    <td className="font-mono">{q.queued}</td>
                    <td className="font-mono">{q.active}</td>
                    <td className="font-mono">{q.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <ClusterPanel backlog={status.backlog} onDone={changed} />
        </div>
      </div>

      <Panel
        title={`Sources (${status.sources.length})`}
        actions={
          <div className="flex items-center gap-2">
            <RunAll onDone={changed} />
            <Link href="/admin/sources/new" className={btn}>
              Add source
            </Link>
          </div>
        }
      >
        <SourcesTable
          sources={status.sources}
          globalInterval={sched.intervalMinutes}
          schedulerActive={schedulerActive}
          onChanged={changed}
        />
      </Panel>

      <Panel title="Recent runs">
        <RunsTable runs={status.runs} onChanged={changed} />
      </Panel>
    </div>
  );
}

function RunAll({ onDone }: { onDone: () => void }) {
  const [force, setForce] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2 text-xs">
      {msg && <span className="text-muted">{msg}</span>}
      <label className="flex items-center gap-1 text-muted">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        Force refresh
      </label>
      <button
        type="button"
        className={btnPrimary}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await runIngestAction({ sourceIds: "all", force });
            if (!r.ok) setMsg(r.error);
            else {
              const counts = r.data.sources.reduce<Record<string, number>>((a, s) => ({ ...a, [s.status]: (a[s.status] ?? 0) + 1 }), {});
              setMsg(Object.entries(counts).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ") || "nothing to run");
            }
            setForce(false);
            onDone();
          })
        }
      >
        {pending ? "Starting…" : "Run all now"}
      </button>
    </div>
  );
}
