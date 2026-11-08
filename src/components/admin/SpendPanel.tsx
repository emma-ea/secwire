import type { DashboardStatus } from "@/ingest/dashboard";
import { Badge, Panel } from "../ui";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Paid providers: month-to-date spend against the monthly cap (Phase 3). */
export function SpendPanel({ spend }: { spend: DashboardStatus["spend"] }) {
  return (
    <Panel title="Paid APIs (this month, UTC)">
      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>Spent / cap</th>
            <th>Requests</th>
            <th>Units</th>
          </tr>
        </thead>
        <tbody>
          {spend.map((p) => {
            const over = p.capUsd > 0 ? p.usd / p.capUsd : 1;
            return (
              <tr key={p.provider}>
                <td>{p.label}</td>
                <td title={p.disabledReason ?? undefined}>
                  {p.enabled ? <Badge tone={over >= 0.9 ? "warn" : "ok"}>on</Badge> : <Badge tone="muted">off</Badge>}
                  {!p.enabled && p.disabledReason && <span className="ml-1 text-[11px] text-muted">{p.disabledReason}</span>}
                </td>
                <td className="font-mono whitespace-nowrap">
                  {usd(p.usd)} / {usd(p.capUsd)}
                </td>
                <td className="font-mono">{p.requests}</td>
                <td className="font-mono">{p.units}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted">
        A paid call is refused when this month&apos;s spend plus its worst-case cost would exceed the cap. Caps are set in env.
      </p>
    </Panel>
  );
}
