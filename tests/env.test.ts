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

  it("Phase 3 features are off by default and validate their settings", () => {
    const env = parseEnv(valid);
    expect([env.X_ENABLED, env.X_MONTHLY_CAP_USD, env.ANTHROPIC_API_KEY, env.SUMMARY_MODEL, env.AI_MONTHLY_CAP_USD]).toEqual([
      false,
      10,
      undefined,
      "claude-haiku-5-5",
      5,
    ]);
    expect([env.SLACK_WEBHOOK_URL, env.SMTP_URL, env.APP_URL]).toEqual([undefined, undefined, undefined]);
    expect(parseEnv({ ...valid, SLACK_WEBHOOK_URL: "", APP_URL: " " }).SLACK_WEBHOOK_URL).toBeUndefined();
    expect(() => parseEnv({ ...valid, SLACK_WEBHOOK_URL: "http://hooks.slack.com/x" })).toThrow(/SLACK_WEBHOOK_URL/);
    expect(() => parseEnv({ ...valid, SMTP_URL: "https://mail.example.com" })).toThrow(/SMTP_URL/);
    expect(() => parseEnv({ ...valid, APP_URL: "javascript:alert(1)" })).toThrow(/APP_URL/);
    expect(parseEnv({ ...valid, SMTP_URL: "smtps://u:p@mail.example.com:465" }).SMTP_URL).toBe("smtps://u:p@mail.example.com:465");
    expect(() => parseEnv({ ...valid, X_MONTHLY_CAP_USD: "-1" })).toThrow(/X_MONTHLY_CAP_USD/);
  });
});
