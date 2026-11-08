"use client";

import { relativeTime } from "@/lib/format";
import { useNow } from "./useNow";

type Props = {
  iso: string | null | undefined;
  /** relative: "5m ago"; time: local HH:MM; datetime: local date + time. */
  mode?: "relative" | "time" | "datetime";
  fallback?: string;
};

/**
 * Renders a UTC timestamp in the viewer's local timezone (SPEC §7.5). The
 * server render shows UTC; the client swaps in local/relative text after mount.
 */
export function LocalTime({ iso, mode = "relative", fallback = "never" }: Props) {
  const now = useNow();

  if (!iso) return <span className="text-muted">{fallback}</span>;
  const d = new Date(iso);
  const title = now ? d.toLocaleString() : `${iso.slice(0, 16).replace("T", " ")} UTC`;

  let text: string;
  if (!now) text = `${iso.slice(0, 16).replace("T", " ")}Z`;
  else if (mode === "relative") text = relativeTime(d, now);
  else if (mode === "time") text = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  else text = d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  return (
    <time dateTime={iso} title={title} suppressHydrationWarning>
      {text}
    </time>
  );
}
