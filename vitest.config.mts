import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

/** Integration tests use their own database so they never touch dev data. */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://secwire:secwire@localhost:5432/secwire_test";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared database: run files one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: {
            NODE_ENV: "test",
            DATABASE_URL: TEST_DATABASE_URL,
            TEST_DATABASE_URL,
            ADMIN_PASSWORD: "integration-test-password",
            SESSION_SECRET: "integration-test-session-secret-0123456789",
            INGEST_API_TOKEN: "integration-test-ingest-token",
            FETCH_USER_AGENT: "SecWire/test",
            KEV_ITEM_LOOKBACK_DAYS: "14",
            WORKER_SCHEDULES_ENABLED: "true",
          },
        },
      },
    ],
  },
});
