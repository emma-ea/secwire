export function WorkerPill({ online, lastBeatAgeSec }: { online: boolean; lastBeatAgeSec: number | null }) {
  if (online) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Worker online · beat {lastBeatAgeSec ?? "?"}s ago
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-0.5 font-medium text-red-700 dark:text-red-300">
        <span className="size-1.5 rounded-full bg-red-500" />
        Worker offline
        {lastBeatAgeSec !== null ? ` · last beat ${lastBeatAgeSec}s ago` : " · never seen"}
      </span>
      <span className="text-muted">
        Jobs stay queued until it&apos;s back. Run <code className="font-mono">pnpm dev:worker</code>, or use{" "}
        <code className="font-mono">pnpm ingest --inline</code>.
      </span>
    </span>
  );
}
