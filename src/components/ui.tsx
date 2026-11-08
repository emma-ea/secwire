import type { ReactNode } from "react";

/** Every external link: new tab, no opener, no referrer (SPEC §8). */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

const TONES = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-amber-500/30",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30",
  muted: "bg-foreground/5 text-foreground/60 ring-foreground/15",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium leading-4 ring-1 ring-inset whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  succeeded: "ok",
  not_modified: "ok",
  partial: "warn",
  failed: "bad",
  queued: "info",
  running: "info",
  coalesced: "muted",
  skipped_locked: "muted",
  skipped_disabled: "muted",
  skipped_cooldown: "muted",
  cancelled: "muted",
};

const STATUS_LABELS: Record<string, string> = {
  not_modified: "not modified",
  skipped_locked: "skipped (locked)",
  skipped_disabled: "skipped (disabled)",
  skipped_cooldown: "skipped (cooldown)",
  coalesced: "already queued",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "muted"}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function Panel({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-foreground/10">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{title}</h2>
        {actions}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export const btn =
  "inline-flex items-center gap-1 rounded border border-foreground/20 px-2 py-0.5 text-xs hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40";
export const btnPrimary =
  "inline-flex items-center gap-1 rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
export const input =
  "rounded border border-foreground/20 bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500";
