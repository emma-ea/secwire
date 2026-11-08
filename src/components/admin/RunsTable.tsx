"use client";

import Link from "next/link";
import { useTransition } from "react";
import { cancelRunAction } from "@/app/admin/actions";
import type { DashboardStatus } from "@/ingest/dashboard";
import { LocalTime } from "../LocalTime";
import { btn, StatusBadge } from "../ui";

type Run = DashboardStatus["runs"][number];

export function RunsTable({ runs, onChanged }: { runs: Run[]; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  if (!runs.length) return <p className="text-xs text-muted">No runs yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Trigger</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Scope</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const active = r.status === "queued" || r.status === "running";
            // Cancel works through per-source rows; enrich/recluster runs are a single job.
            const cancellable = active && (r.kind === "ingest" || r.kind === "backfill");
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  <Link href={`/admin/runs/${r.id}`} className="hover:underline">
                    <LocalTime iso={r.createdAt} />
                  </Link>
                </td>
                <td className="whitespace-nowrap">
                  {r.trigger}
                  {r.triggeredBy && r.triggeredBy !== r.trigger && <span className="text-muted"> · {r.triggeredBy}</span>}
                </td>
                <td>{r.kind}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="max-w-56 truncate" title={r.scopeText}>
                  {r.scopeText}
                </td>
                <td className="whitespace-nowrap font-mono">{r.resultText}</td>
                <td className="whitespace-nowrap text-right">
                  <Link href={`/admin/runs/${r.id}`} className={btn}>
                    Details
                  </Link>{" "}
                  {cancellable && (
                    <button
                      type="button"
                      className={btn}
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await cancelRunAction(r.id);
                          onChanged();
                        })
                      }
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
