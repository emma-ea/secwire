"use client";

import { useMemo, useState, useTransition } from "react";
import { saveSchedulerAction } from "@/app/admin/actions";
import type { SchedulerState } from "@/ingest/scheduler-service";
import { formatInterval } from "@/lib/format";
import { effectiveIntervalMinutes, estimateDailyRequests, nextRunAt } from "@/lib/scheduler";
import { LocalTime } from "../LocalTime";
import { useNow } from "../useNow";
import { btnPrimary, input, Panel } from "../ui";

type Props = {
  initial: SchedulerState;
  workerOnline: boolean;
  /** Live source list from dashboard polling (enabled flags / overrides change). */
  sources: Array<{ id: string; enabled: boolean; minIntervalMinutes: number | null }>;
  onSaved?: () => void;
};

export function SchedulerPanel({ initial, workerOnline, sources, onSaved }: Props) {
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [interval, setIntervalMinutes] = useState(initial.intervalMinutes);
  const [enrichRefresh, setEnrichRefresh] = useState(initial.enrichRefreshEnabled);
  const [cancelQueued, setCancelQueued] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const now = useNow();

  const locked = saved.managedExternally;
  const dirty = enabled !== saved.enabled || interval !== saved.intervalMinutes || enrichRefresh !== saved.enrichRefreshEnabled;

  // Live estimate: recalculated as values change, before saving (SPEC §7.5).
  const estimate = useMemo(() => {
    const perFetch = new Map(saved.sources.map((s) => [s.id, s]));
    return estimateDailyRequests(
      sources.map((s) => ({
        enabled: s.enabled && enabled,
        minIntervalMinutes: s.minIntervalMinutes,
        requestsPerFetch: perFetch.get(s.id)?.requestsPerFetch ?? 1,
        costPerRequestUsd: perFetch.get(s.id)?.costPerRequestUsd ?? 0,
      })),
      interval,
    );
  }, [sources, saved.sources, interval, enabled]);

  const overridden = sources.filter((s) => s.enabled && effectiveIntervalMinutes(interval, s.minIntervalMinutes) !== interval);

  const confirmText = !dirty
    ? null
    : !enabled
      ? "Scheduled ingestion will be paused. Manual triggers keep working."
      : now
        ? `Ingestion will run every ${formatInterval(interval)} starting ${nextRunAt(interval, now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
        : null;

  /** Any edit clears the previous save's message so it can't describe stale values. */
  function edit(apply: () => void) {
    setMessage(null);
    apply();
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const r = await saveSchedulerAction({
        enabled,
        intervalMinutes: interval,
        enrichRefreshEnabled: enrichRefresh,
        cancelQueuedScheduled: !enabled && cancelQueued,
      });
      if (!r.ok) {
        setMessage({ tone: "bad", text: r.error });
        return;
      }
      setSaved(r.data.state);
      setCancelQueued(false);
      const parts = ["Saved."];
      if (r.data.cancelledJobs) parts.push(`Cancelled ${r.data.cancelledJobs} queued scheduled job(s).`);
      if (!r.data.workerOnline) parts.push("Will apply when the worker is back online.");
      setMessage({ tone: r.data.workerOnline ? "ok" : "warn", text: parts.join(" ") });
      onSaved?.();
    });
  }

  return (
    <Panel
      title="Scheduler"
      actions={
        locked ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">Scheduling is managed externally</span>
        ) : null
      }
    >
      {locked && (
        <p className="mb-3 text-xs text-muted">
          <code className="font-mono">WORKER_SCHEDULES_ENABLED=false</code>: the worker creates no schedules. Drive
          ingestion with <code className="font-mono">POST /api/ingest</code>. Manual triggers are unaffected.
        </p>
      )}
      <fieldset disabled={locked || pending} className="grid gap-3 text-xs sm:grid-cols-[auto_1fr]">
        <label className="contents">
          <span className="text-muted">Scheduled ingestion</span>
          <span className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => edit(() => setEnabled(e.target.checked))} />
            {enabled ? "On" : "Paused"}
          </span>
        </label>

        <label className="contents">
          <span className="text-muted">Interval</span>
          <select
            className={`${input} w-40`}
            value={interval}
            onChange={(e) => edit(() => setIntervalMinutes(Number(e.target.value)))}
          >
            {saved.presets.map((p) => (
              <option key={p} value={p}>
                every {formatInterval(p)}
              </option>
            ))}
          </select>
        </label>

        <label className="contents">
          <span className="text-muted">Daily NVD/EPSS refresh</span>
          <span className="flex items-center gap-2">
            <input type="checkbox" checked={enrichRefresh} onChange={(e) => edit(() => setEnrichRefresh(e.target.checked))} />
            {enrichRefresh ? "On" : "Off"} <span className="text-muted">(daily at 03:00 UTC)</span>
          </span>
        </label>

        {!enabled && saved.enabled && (
          <label className="contents">
            <span className="text-muted">When pausing</span>
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={cancelQueued} onChange={(e) => setCancelQueued(e.target.checked)} />
              Also cancel queued scheduled jobs
            </span>
          </label>
        )}

        <span className="text-muted">Last tick</span>
        <span>
          <LocalTime iso={saved.lastTickAt} />
        </span>

        <span className="text-muted">Next run</span>
        <span>{saved.nextRunAt ? <LocalTime iso={saved.nextRunAt} mode="time" /> : <span className="text-muted">—</span>}</span>

        <span className="text-muted">Est. requests/day</span>
        <span className="font-mono">
          ~{estimate.requestsPerDay.toLocaleString()}
          {estimate.costPerDayUsd > 0 && ` · $${estimate.costPerDayUsd.toFixed(2)}/day`}
          {overridden.length > 0 && (
            <span className="ml-2 font-sans text-muted">
              ({overridden.map((s) => s.id).join(", ")} run{overridden.length === 1 ? "s" : ""} less often via override)
            </span>
          )}
        </span>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimary} disabled={locked || pending || !dirty} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </button>
        {confirmText && <span className="text-xs">{confirmText}</span>}
        {message && (
          <span
            className={`text-xs ${message.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : message.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300"}`}
          >
            {message.text}
          </span>
        )}
        {!workerOnline && !message && dirty && (
          <span className="text-xs text-amber-700 dark:text-amber-300">Worker offline: changes apply when it&apos;s back.</span>
        )}
      </div>
    </Panel>
  );
}
