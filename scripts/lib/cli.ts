import os from "node:os";
import { closeDb } from "../../src/db/client";
import { stopSenderBoss } from "../../src/ingest/boss";

export function cliUser(): string {
  try {
    return `cli:${os.userInfo().username}`;
  } catch {
    return "cli:unknown";
  }
}

/** Minimal fixed-width table; cells are truncated, never wrapped. */
export function printTable(rows: Array<Record<string, unknown>>, maxCell = 60): void {
  if (!rows.length) {
    console.log("(none)");
    return;
  }
  const cols = Object.keys(rows[0]!);
  const str = (v: unknown) => {
    const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : String(v);
    const flat = s.replace(/\s+/g, " ");
    return flat.length > maxCell ? `${flat.slice(0, maxCell - 1)}…` : flat;
  };
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => str(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => str(r[c]))));
}

/** Runs main, closes DB + pg-boss, exits with the returned code. */
export function runCli(main: () => Promise<number>): void {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? `error: ${err.message}` : err);
      return 1;
    })
    .then(async (code) => {
      await stopSenderBoss();
      await closeDb().catch(() => {});
      process.exit(code);
    });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
