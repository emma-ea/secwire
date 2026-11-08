import { describe, expect, it } from "vitest";
import { buildHealth } from "@/lib/health";

const settings = {
  schedulerEnabled: true,
  schedulerIntervalMinutes: 15,
  lastTickAt: new Date("2026-11-08T12:00:00Z"),
};

describe("buildHealth", () => {
  it("reports db ok and an online worker with a fresh heartbeat", () => {
    const { status, body } = buildHealth({ lastBeatAgeSec: 12.4, settings });
    expect(status).toBe(200);
    expect(body).toEqual({
      db: "ok",
      worker: { lastBeatAgeSec: 12, online: true },
      scheduler: {
        enabled: true,
        intervalMinutes: 15,
        lastTickAt: "2026-11-08T12:00:00.000Z",
        nextRunAt: null,
      },
      queues: {},
    });
  });

  it("marks the worker offline after 90s but stays 200", () => {
    expect(buildHealth({ lastBeatAgeSec: 90, settings }).body.worker.online).toBe(true);
    const { status, body } = buildHealth({ lastBeatAgeSec: 91, settings });
    expect(status).toBe(200);
    expect(body.worker).toEqual({ lastBeatAgeSec: 91, online: false });
  });

  it("handles a worker that has never beaten", () => {
    const { status, body } = buildHealth({ lastBeatAgeSec: null, settings });
    expect(status).toBe(200);
    expect(body.worker).toEqual({ lastBeatAgeSec: null, online: false });
  });

  it("clamps small negative ages from clock jitter to 0", () => {
    expect(buildHealth({ lastBeatAgeSec: -0.3, settings }).body.worker.lastBeatAgeSec).toBe(0);
  });

  it("tolerates a missing app_settings row", () => {
    const { body } = buildHealth({ lastBeatAgeSec: 5, settings: null });
    expect(body.scheduler).toEqual({
      enabled: null,
      intervalMinutes: null,
      lastTickAt: null,
      nextRunAt: null,
    });
  });

  it("returns 503 without leaking error details when the DB is unreachable", () => {
    const { status, body } = buildHealth(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(status).toBe(503);
    expect(body.db).toBe("error");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
