import { describe, expect, it } from "vitest";
import {
  SCHEDULER_INTERVAL_PRESETS,
  cronForInterval,
  effectiveIntervalMinutes,
  estimateDailyRequests,
  isPreset,
  isSourceDue,
  nextDueAt,
  nextRunAt,
  overrideIsBelowGlobal,
} from "@/lib/scheduler";

const at = (iso: string) => new Date(iso);

describe("cronForInterval", () => {
  it.each([
    [5, "*/5 * * * *"],
    [10, "*/10 * * * *"],
    [15, "*/15 * * * *"],
    [30, "*/30 * * * *"],
    [60, "0 */1 * * *"],
    [120, "0 */2 * * *"],
    [180, "0 */3 * * *"],
    [360, "0 */6 * * *"],
    [720, "0 */12 * * *"],
    [1440, "0 0 * * *"],
  ])("%i min → %s", (min, cron) => {
    expect(cronForInterval(min)).toBe(cron);
  });

  it("covers every preset", () => {
    for (const p of SCHEDULER_INTERVAL_PRESETS) expect(() => cronForInterval(p)).not.toThrow();
  });

  it("rejects non-presets", () => {
    for (const bad of [0, 1, 7, 45, 90, 240, 1000, 2880, -15, 15.5]) {
      expect(isPreset(bad)).toBe(false);
      expect(() => cronForInterval(bad)).toThrow(/preset/);
    }
  });
});

describe("nextRunAt", () => {
  it("returns the next multiple of the interval since UTC midnight", () => {
    expect(nextRunAt(15, at("2026-11-08T12:07:30Z")).toISOString()).toBe("2026-11-08T12:15:00.000Z");
    expect(nextRunAt(60, at("2026-11-08T12:07:30Z")).toISOString()).toBe("2026-11-08T13:00:00.000Z");
    expect(nextRunAt(180, at("2026-11-08T13:00:00Z")).toISOString()).toBe("2026-11-08T15:00:00.000Z");
    expect(nextRunAt(720, at("2026-11-08T12:00:01Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });

  it("is strictly after now when exactly on a boundary", () => {
    expect(nextRunAt(15, at("2026-11-08T12:15:00Z")).toISOString()).toBe("2026-11-08T12:30:00.000Z");
  });

  it("rolls over midnight", () => {
    expect(nextRunAt(1440, at("2026-11-08T00:00:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(nextRunAt(5, at("2026-11-08T23:58:00Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(nextRunAt(360, at("2026-12-31T19:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("effectiveIntervalMinutes", () => {
  it("uses the global interval when there is no override", () => {
    expect(effectiveIntervalMinutes(15, null)).toBe(15);
  });

  it("an override can only make a source run less often", () => {
    expect(effectiveIntervalMinutes(5, 60)).toBe(60);
    expect(effectiveIntervalMinutes(60, 5)).toBe(60);
    expect(overrideIsBelowGlobal(60, 5)).toBe(true);
    expect(overrideIsBelowGlobal(5, 60)).toBe(false);
    expect(overrideIsBelowGlobal(5, null)).toBe(false);
  });
});

describe("isSourceDue", () => {
  const now = at("2026-11-08T12:15:00Z");

  it("is due when never fetched", () => {
    expect(isSourceDue(null, 15, now)).toBe(true);
  });

  it("applies the 2-minute grace (fetched 12:00:20 → due at 12:15:00)", () => {
    expect(isSourceDue(at("2026-11-08T12:00:20Z"), 15, now)).toBe(true);
  });

  it("is due exactly at interval − 2 min, not before", () => {
    expect(isSourceDue(at("2026-11-08T12:02:00Z"), 15, now)).toBe(true);
    expect(isSourceDue(at("2026-11-08T12:02:01Z"), 15, now)).toBe(false);
  });

  it("raising the global interval causes no burst (15 → 60)", () => {
    // Fetched 10 min ago under the old 15-min interval; at 60 min it isn't due.
    expect(isSourceDue(at("2026-11-08T12:05:00Z"), 60, now)).toBe(false);
  });

  it("KEV at a 60-min override stays hourly under a 5-min global tick", () => {
    const eff = effectiveIntervalMinutes(5, 60);
    const fetched = at("2026-11-08T12:00:30Z");
    const dueTicks: string[] = [];
    for (let m = 5; m <= 120; m += 5) {
      const tick = new Date(Date.UTC(2026, 10, 8, 12, m));
      if (isSourceDue(fetched, eff, tick)) {
        dueTicks.push(tick.toISOString().slice(11, 16));
        break;
      }
    }
    expect(dueTicks).toEqual(["13:00"]);
  });
});

describe("nextDueAt", () => {
  it("is the next tick for a never-fetched source", () => {
    expect(nextDueAt(null, 15, null, at("2026-11-08T12:07:00Z")).toISOString()).toBe("2026-11-08T12:15:00.000Z");
  });

  it("skips ticks until the override has elapsed", () => {
    expect(
      nextDueAt(at("2026-11-08T12:00:30Z"), 5, 60, at("2026-11-08T12:07:00Z")).toISOString(),
    ).toBe("2026-11-08T13:00:00.000Z");
  });
});

describe("estimateDailyRequests", () => {
  it("sums (1440 / effective interval) × requestsPerFetch over enabled sources", () => {
    const r = estimateDailyRequests(
      [
        { enabled: true, minIntervalMinutes: null, requestsPerFetch: 1 }, // 96
        { enabled: true, minIntervalMinutes: 60, requestsPerFetch: 1 }, // 24 (KEV)
        { enabled: true, minIntervalMinutes: null, requestsPerFetch: 7 }, // 672 (HN, 7 queries)
        { enabled: false, minIntervalMinutes: null, requestsPerFetch: 1 }, // ignored
      ],
      15,
    );
    expect(r.requestsPerDay).toBe(96 + 24 + 672);
    expect(r.costPerDayUsd).toBe(0);
  });

  it("includes cost for paid sources", () => {
    const r = estimateDailyRequests(
      [{ enabled: true, minIntervalMinutes: 60, requestsPerFetch: 2, costPerRequestUsd: 0.01 }],
      15,
    );
    expect(r.requestsPerDay).toBe(48);
    expect(r.costPerDayUsd).toBeCloseTo(0.48);
  });
});
