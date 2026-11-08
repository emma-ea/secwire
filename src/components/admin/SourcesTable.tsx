"use client";

import { useState, useTransition } from "react";
import { runIngestAction, testSavedSourceAction, updateSourceAction } from "@/app/admin/actions";
import type { DashboardStatus } from "@/ingest/dashboard";
import type { TestSourceResult } from "@/ingest/test-source";
import { formatInterval } from "@/lib/format";
import { effectiveIntervalMinutes, nextDueAt, overrideIsBelowGlobal } from "@/lib/scheduler";
import { LocalTime } from "../LocalTime";
import { useNow } from "../useNow";
import { Badge, btn, input } from "../ui";
import { TestPreview } from "./TestPreview";

type Source = DashboardStatus["sources"][number];

const FEEDBACK: Record<string, string> = {
  queued: "queued",
  coalesced: "already queued",
  skipped_cooldown: "ran <60s ago — tick force to rerun",
  skipped_disabled: "disabled — tick “incl. disabled”",
};

type Props = {
  sources: Source[];
  globalInterval: number;
  schedulerActive: boolean;
  onChanged: () => void;
};

export function SourcesTable({ sources, globalInterval, schedulerActive, onChanged }: Props) {
  const [preview, setPreview] = useState<{ id: string; result: TestSourceResult } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const now = useNow();

  async function test(id: string) {
    setTesting(id);
    try {
      const r = await testSavedSourceAction(id);
      setPreview({
        id,
        result: "durationMs" in r ? r : { ok: false, items: [], httpStatus: null, durationMs: 0, error: r.error },
      });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Enabled</th>
              <th title="Optional per-source minimum interval; can only make a source run less often">Override / effective</th>
              <th>Last success</th>
              <th>Next due</th>
              <th>24h items</th>
              <th>Failures</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                globalInterval={globalInterval}
                nextDue={
                  schedulerActive && s.enabled && now
                    ? nextDueAt(s.lastFetchedAt ? new Date(s.lastFetchedAt) : null, globalInterval, s.minIntervalMinutes, now).toISOString()
                    : null
                }
                testing={testing === s.id}
                onTest={() => void test(s.id)}
                onChanged={onChanged}
              />
            ))}
          </tbody>
        </table>
      </div>
      {preview && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-muted">Test result</span>
            <button type="button" className={btn} onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          <TestPreview result={preview.result} title={preview.id} />
        </div>
      )}
    </div>
  );
}

function SourceRow({
  s,
  globalInterval,
  nextDue,
  testing,
  onTest,
  onChanged,
}: {
  s: Source;
  globalInterval: number;
  nextDue: string | null;
  testing: boolean;
  onTest: () => void;
  onChanged: () => void;
}) {
  const [force, setForce] = useState(false);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const eff = effectiveIntervalMinutes(globalInterval, s.minIntervalMinutes);

  function run() {
    setFeedback(null);
    startTransition(async () => {
      const r = await runIngestAction({ sourceIds: [s.id], force, includeDisabled: !s.enabled && includeDisabled });
      if (!r.ok) setFeedback(r.error);
      else {
        const st = r.data.sources[0]?.status ?? "?";
        setFeedback(FEEDBACK[st] ?? st);
      }
      setForce(false);
      onChanged();
    });
  }

  function patch(p: { enabled?: boolean; minIntervalMinutes?: number | null }) {
    startTransition(async () => {
      const r = await updateSourceAction(s.id, p);
      setFeedback(r.ok ? null : r.error);
      onChanged();
    });
  }

  function saveOverride(raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      setFeedback("override must be a whole number of minutes");
      return;
    }
    if (value !== s.minIntervalMinutes) patch({ minIntervalMinutes: value });
  }

  return (
    <tr className={s.enabled ? "" : "opacity-60"}>
      <td>
        <div className="font-medium">{s.name}</div>
        <div className="font-mono text-[11px] text-muted">{s.id}</div>
      </td>
      <td className="whitespace-nowrap">
        <div>{s.type}</div>
        <div className="text-[11px] text-muted">{s.category}</div>
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`Enable ${s.name}`}
          checked={s.enabled}
          disabled={pending}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
      </td>
      <td className="whitespace-nowrap">
        {/* Keyed on the saved value so a server-side change resets the draft. */}
        <input
          key={s.minIntervalMinutes ?? "none"}
          className={`${input} w-16 font-mono`}
          inputMode="numeric"
          placeholder="—"
          defaultValue={s.minIntervalMinutes?.toString() ?? ""}
          disabled={pending}
          onBlur={(e) => saveOverride(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && saveOverride(e.currentTarget.value)}
          aria-label={`Minimum interval override for ${s.name} (minutes)`}
        />{" "}
        <span className="font-mono">{formatInterval(eff)}</span>
        {overrideIsBelowGlobal(globalInterval, s.minIntervalMinutes) && (
          <div className="text-[11px] text-amber-700 dark:text-amber-300">
            Runs every {globalInterval} min (global interval is the minimum)
          </div>
        )}
      </td>
      <td className="whitespace-nowrap">
        <LocalTime iso={s.lastSuccessAt} />
      </td>
      <td className="whitespace-nowrap">{nextDue ? <LocalTime iso={nextDue} mode="time" /> : <span className="text-muted">—</span>}</td>
      <td className="font-mono">{s.items24h}</td>
      <td>
        {s.unhealthy ? (
          <Badge tone="bad" title="5 or more consecutive failures">
            {s.consecutiveFailures} · unhealthy
          </Badge>
        ) : (
          <span className="font-mono">{s.consecutiveFailures}</span>
        )}
      </td>
      <td className="max-w-56">
        {s.lastError ? (
          <span className="line-clamp-2 text-red-700 dark:text-red-300" title={s.lastError}>
            {s.lastError}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="whitespace-nowrap">
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={run} disabled={pending || s.busy} title={s.busy ? "A job for this source is queued or running" : undefined}>
            {s.busy ? "Running…" : "Run now"}
          </button>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            force
          </label>
          {!s.enabled && (
            <label className="flex items-center gap-1 text-[11px] text-muted">
              <input type="checkbox" checked={includeDisabled} onChange={(e) => setIncludeDisabled(e.target.checked)} />
              incl. disabled
            </label>
          )}
          <button type="button" className={btn} onClick={onTest} disabled={testing}>
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
        {feedback && <div className="mt-1 text-[11px] text-muted">{feedback}</div>}
      </td>
    </tr>
  );
}
