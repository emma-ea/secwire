/**
 * Scheduler math (SPEC §7.5). Pure functions only — no DB, no clock reads
 * unless a `now` is passed in. All schedules run in UTC.
 */

export const SCHEDULER_INTERVAL_PRESETS = [
  5, 10, 15, 30, 60, 120, 180, 360, 720, 1440,
] as const;

export type SchedulerIntervalPreset = (typeof SCHEDULER_INTERVAL_PRESETS)[number];

export const DEFAULT_SCHEDULER_INTERVAL_MINUTES: SchedulerIntervalPreset = 15;

/** A worker is considered offline when its last heartbeat is older than this (SPEC §7.4). */
export const WORKER_OFFLINE_AFTER_SEC = 90;

/** Fetch latency allowance so a source fetched at 12:00:20 is still due at the 12:15:00 tick. */
export const DUE_GRACE_MINUTES = 2;

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export function isPreset(n: unknown): n is SchedulerIntervalPreset {
  return (
    typeof n === "number" &&
    (SCHEDULER_INTERVAL_PRESETS as readonly number[]).includes(n)
  );
}

/** Preset → cron (UTC). Throws on a non-preset, since callers must validate first. */
export function cronForInterval(minutes: number): string {
  if (!isPreset(minutes)) throw new Error(`Not a scheduler preset: ${minutes}`);
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes < DAY_MINUTES) return `0 */${minutes / 60} * * *`;
  return "0 0 * * *";
}

/**
 * Next run strictly after `now`: the next multiple of `minutes` since UTC
 * midnight. Matches the cron produced by cronForInterval for every preset.
 */
export function nextRunAt(minutes: number, now: Date): Date {
  if (!isPreset(minutes)) throw new Error(`Not a scheduler preset: ${minutes}`);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const step = minutes * MINUTE;
  const k = Math.floor((now.getTime() - midnight) / step) + 1;
  return new Date(midnight + k * step);
}

/** Overrides can only make a source run less often than the global tick. */
export function effectiveIntervalMinutes(
  globalMinutes: number,
  overrideMinutes: number | null | undefined,
): number {
  return overrideMinutes == null ? globalMinutes : Math.max(globalMinutes, overrideMinutes);
}

/** True when an override exists but is ignored because the global interval is longer. */
export function overrideIsBelowGlobal(
  globalMinutes: number,
  overrideMinutes: number | null | undefined,
): boolean {
  return overrideMinutes != null && overrideMinutes < globalMinutes;
}

export function isSourceDue(
  lastFetchedAt: Date | null | undefined,
  effectiveMinutes: number,
  now: Date,
): boolean {
  if (!lastFetchedAt) return true;
  const threshold = Math.max(0, effectiveMinutes - DUE_GRACE_MINUTES) * MINUTE;
  return now.getTime() - lastFetchedAt.getTime() >= threshold;
}

/** When the source will next be picked up by a tick (approximate, for display). */
export function nextDueAt(
  lastFetchedAt: Date | null | undefined,
  globalMinutes: number,
  overrideMinutes: number | null | undefined,
  now: Date,
): Date {
  const eff = effectiveIntervalMinutes(globalMinutes, overrideMinutes);
  let tick = nextRunAt(globalMinutes, now);
  if (!lastFetchedAt) return tick;
  // Walk ticks forward until the source is due (bounded: at most 1 day of ticks).
  for (let i = 0; i < DAY_MINUTES && !isSourceDue(lastFetchedAt, eff, tick); i++) {
    tick = new Date(tick.getTime() + globalMinutes * MINUTE);
  }
  return tick;
}

export type CostInput = {
  enabled: boolean;
  minIntervalMinutes: number | null;
  requestsPerFetch: number;
  costPerRequestUsd?: number;
};

export function estimateDailyRequests(
  sources: CostInput[],
  globalMinutes: number,
): { requestsPerDay: number; costPerDayUsd: number } {
  let requestsPerDay = 0;
  let costPerDayUsd = 0;
  for (const s of sources) {
    if (!s.enabled) continue;
    const fetchesPerDay = DAY_MINUTES / effectiveIntervalMinutes(globalMinutes, s.minIntervalMinutes);
    const req = fetchesPerDay * s.requestsPerFetch;
    requestsPerDay += req;
    costPerDayUsd += req * (s.costPerRequestUsd ?? 0);
  }
  return { requestsPerDay: Math.round(requestsPerDay), costPerDayUsd };
}
