/** Pure display helpers, safe for client and server components. */

const UNITS: Array<[number, string]> = [
  [60, "s"],
  [60, "m"],
  [24, "h"],
  [30, "d"],
  [12, "mo"],
  [Infinity, "y"],
];

/** "12s ago", "5m ago", "in 3h". */
export function relativeTime(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(t.getTime())) return "—";
  let diff = Math.round((now.getTime() - t.getTime()) / 1000);
  const future = diff < 0;
  diff = Math.abs(diff);
  if (diff < 5) return "just now";
  let value = diff;
  for (const [step, unit] of UNITS) {
    if (value < step) return future ? `in ${value}${unit}` : `${value}${unit} ago`;
    value = Math.floor(value / step);
  }
  return "—";
}

export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} h`;
  return `${minutes / 1440} d`;
}
