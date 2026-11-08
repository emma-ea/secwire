"use client";

import type { TestSourceResult } from "@/ingest/test-source";
import { ExternalLink } from "../ui";

/** Dry-run preview table: title, date, CVEs found (SPEC §7.2 B). Plain text only. */
export function TestPreview({ result, title }: { result: TestSourceResult; title?: string }) {
  return (
    <div className="rounded border border-foreground/10 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        {title && <span className="font-medium">{title}</span>}
        {result.ok ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            OK · {result.items.length} item(s)
          </span>
        ) : (
          <span className="text-red-700 dark:text-red-300">Failed: {result.error}</span>
        )}
        <span className="text-muted">
          HTTP {result.httpStatus ?? "—"} · {result.durationMs} ms · nothing was saved
        </span>
      </div>
      {result.items.length > 0 && (
        <div className="max-h-80 overflow-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Published</th>
                <th>Title</th>
                <th>CVEs</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((it) => (
                <tr key={it.externalId}>
                  <td className="whitespace-nowrap font-mono text-muted">
                    {it.publishedAt ? new Date(it.publishedAt).toLocaleString() : "—"}
                  </td>
                  <td>
                    <ExternalLink href={it.url} className="hover:underline">
                      {it.title}
                    </ExternalLink>
                  </td>
                  <td className="font-mono">{it.cveIds.join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
