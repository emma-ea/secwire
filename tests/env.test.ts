import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "@/env";

const valid = {
  DATABASE_URL: "postgres://secwire:secwire@localhost:5432/secwire",
  ADMIN_PASSWORD: "correct-horse",
  SESSION_SECRET: "x".repeat(32),
  INGEST_API_TOKEN: "t".repeat(32),
  FETCH_USER_AGENT: "SecWire/test",
};

describe("parseEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.KEV_ITEM_LOOKBACK_DAYS).toBe(14);
    expect(env.CLUSTER_WINDOW_DAYS).toBe(14);
    expect(env.WORKER_SCHEDULES_ENABLED).toBe(true);
    expect(env.NVD_API_KEY).toBeUndefined();
  });

  it("treats an empty NVD_API_KEY as unset", () => {
    expect(parseEnv({ ...valid, NVD_API_KEY: "" }).NVD_API_KEY).toBeUndefined();
    expect(parseEnv({ ...valid, NVD_API_KEY: "  " }).NVD_API_KEY).toBeUndefined();
    expect(parseEnv({ ...valid, NVD_API_KEY: "abc" }).NVD_API_KEY).toBe("abc");
  });

  it("coerces numeric and boolean strings", () => {
    const env = parseEnv({
      ...valid,
      KEV_ITEM_LOOKBACK_DAYS: "30",
      WORKER_SCHEDULES_ENABLED: "false",
    });
    expect(env.KEV_ITEM_LOOKBACK_DAYS).toBe(30);
    expect(env.WORKER_SCHEDULES_ENABLED).toBe(false);
  });

  it("rejects a non-boolean WORKER_SCHEDULES_ENABLED", () => {
    expect(() => parseEnv({ ...valid, WORKER_SCHEDULES_ENABLED: "maybe" })).toThrow(
      /WORKER_SCHEDULES_ENABLED/,
    );
  });

  it("requires SESSION_SECRET of at least 32 chars", () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET: must be at least 32 characters/,
    );
  });

  it("requires a postgres DATABASE_URL", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("lists every problem at once and never echoes secret values", () => {
    const secret = "short-secret-value";
    try {
      parseEnv({ SESSION_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const e = err as EnvError;
      expect(e.issues.map((i) => i.split(":")[0]).sort()).toEqual(
        ["ADMIN_PASSWORD", "DATABASE_URL", "FETCH_USER_AGENT", "INGEST_API_TOKEN", "SESSION_SECRET"].sort(),
      );
      expect(e.message).not.toContain(secret);
    }
  });

  it("rejects .env.example placeholders in production only", () => {
    const placeholders = {
      ...valid,
      ADMIN_PASSWORD: "change-me",
      SESSION_SECRET: "generate-a-32+-char-random-string",
      INGEST_API_TOKEN: "generate-a-random-token",
    };
    expect(() => parseEnv(placeholders)).not.toThrow();
    expect(() => parseEnv({ ...placeholders, NODE_ENV: "production" })).toThrow(
      /ADMIN_PASSWORD: still set to the \.env\.example placeholder/,
    );
  });
});
