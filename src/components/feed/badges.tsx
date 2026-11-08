import { Badge, type Tone } from "@/components/ui";
import { epssPercent, percentileLabel, severityFor } from "@/lib/severity";

const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: "bad", HIGH: "warn", MEDIUM: "info", LOW: "muted", NONE: "muted" };

export function KevBadge() {
  return (
    <Badge tone="bad" title="Listed in CISA's Known Exploited Vulnerabilities catalog: exploited in the wild">
      KEV
    </Badge>
  );
}

export function RansomwareBadge() {
  return (
    <Badge tone="bad" title="CISA KEV: known to be used in ransomware campaigns">
      ransomware
    </Badge>
  );
}

export function CvssBadge({ score, severity, version }: { score: number | null; severity?: string | null; version?: string | null }) {
  if (score === null) return null;
  const sev = (severity ?? severityFor(score) ?? "").toUpperCase();
  return (
    <Badge tone={SEVERITY_TONE[sev] ?? "muted"} title={`CVSS${version ? ` v${version}` : ""} base score ${score.toFixed(1)}${sev ? ` (${sev.toLowerCase()})` : ""}`}>
      {sev ? `${sev.toLowerCase()} ` : ""}
      {score.toFixed(1)}
    </Badge>
  );
}

export function EpssBadge({ percentile, score }: { percentile: number | null; score?: number | null }) {
  const label = percentileLabel(percentile);
  if (!label || percentile === null) return null;
  const tone: Tone = percentile >= 0.95 ? "warn" : "muted";
  const prob = epssPercent(score);
  return (
    <Badge tone={tone} title={`EPSS: ${prob ? `${prob} probability of exploitation in the next 30 days, ` : ""}${label} percentile`}>
      EPSS {label}
    </Badge>
  );
}
