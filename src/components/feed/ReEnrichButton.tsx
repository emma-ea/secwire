"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { reEnrichCveAction } from "@/app/admin/actions";
import { btn } from "@/components/ui";

/** Admin-only (the action calls requireAdmin). Queues NVD + EPSS for one CVE. */
export function ReEnrichButton({ cveId }: { cveId: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ runId?: string; text: string } | null>(null);

  return (
    <span className="inline-flex items-baseline gap-2">
      <button
        type="button"
        className={btn}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await reEnrichCveAction(cveId);
            if (!r.ok) return setResult({ text: r.error });
            setResult({
              runId: r.data.runId,
              text: r.data.status === "coalesced" ? "Already queued" : "Queued",
            });
          })
        }
      >
        {pending ? "Queuing…" : "Re-enrich"}
      </button>
      {result && (
        <span>
          {result.text}
          {result.runId && (
            <>
              {" · "}
              <Link href={`/admin/runs/${result.runId}`} className="text-accent hover:underline">
                run
              </Link>
            </>
          )}
        </span>
      )}
    </span>
  );
}
