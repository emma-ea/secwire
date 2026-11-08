/**
 * One-line descriptions of a run's scope and result for the admin runs table.
 * Ingest runs report sources/items; enrich and recluster runs report their
 * own stats (see trigger-jobs.ts). Pure.
 */
type RunLike = {
  kind: string;
  status: string;
  scope: Record<string, unknown>;
  stats: Record<string, unknown>;
};

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function describeRunScope(r: RunLike): string {
  if (r.kind === "enrich") {
    if (r.scope.mode === "cve") return s(r.scope.cveId) ?? "one CVE";
    return "stale CVEs (daily refresh)";
  }
  if (r.kind === "recluster") {
    const since = s(r.scope.since);
    return since ? `since ${since.slice(0, 10)}` : "all";
  }
  const ids = r.scope.sourceIds;
  if (ids === "all") return "all enabled sources";
  if (Array.isArray(ids)) return ids.length <= 2 ? ids.join(", ") : plural(ids.length, "source");
  return "";
}

export function describeRunResult(r: RunLike): string {
  const active = r.status === "queued" || r.status === "running";
  if (active && !Object.keys(r.stats).length) return "…";
  const st = r.stats;
  if (r.kind === "enrich") {
    if (st.coalesced === true) return "already queued";
    if (r.scope.mode === "cve") {
      const parts = [st.nvd === "not_found" ? "not in NVD yet" : n(st.cvssScore) !== null ? `CVSS ${n(st.cvssScore)}` : "no CVSS yet"];
      if (n(st.epssUpdated)) parts.push(`EPSS ${n(st.epssUpdated)}`);
      return parts.join(" · ");
    }
    const parts = [`NVD ${n(st.nvdQueued) ?? n(st.nvdEnriched) ?? 0}/${n(st.nvdTargets) ?? 0}`, `EPSS ${n(st.epssScored) ?? 0}/${n(st.epssTargets) ?? 0}`];
    return parts.join(" · ");
  }
  if (r.kind === "recluster") {
    const processed = n(st.processed) ?? 0;
    return `${plural(processed, "item")} → ${plural(n(st.created) ?? 0, "new story", "new stories")}`;
  }
  const sources = n(st.sources);
  const added = n(st.itemsNew);
  if (sources === null) return "…";
  return `${plural(sources, "source")} · ${added ?? 0} new`;
}
