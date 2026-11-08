/**
 * Scheduler interval presets (SPEC §7.5). Each divides evenly into an hour or a
 * day so it maps to a clean cron expression. Also enforced by a CHECK
 * constraint on app_settings.scheduler_interval_minutes.
 *
 * Phase 1 adds the pure preset → cron mapping and next-run calculation here.
 */
export const SCHEDULER_INTERVAL_PRESETS = [
  5, 10, 15, 30, 60, 120, 180, 360, 720, 1440,
] as const;

export type SchedulerIntervalPreset =
  (typeof SCHEDULER_INTERVAL_PRESETS)[number];

export const DEFAULT_SCHEDULER_INTERVAL_MINUTES: SchedulerIntervalPreset = 15;

/** A worker is considered offline when its last heartbeat is older than this (SPEC §7.4). */
export const WORKER_OFFLINE_AFTER_SEC = 90;
