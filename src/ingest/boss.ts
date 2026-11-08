import { PgBoss } from "pg-boss";
import { getEnv } from "../env";

/**
 * pg-boss client setup (SPEC §7.1). Phase 0 only needs the worker instance;
 * Phase 1 adds queue names/policies and a send-only instance for the web app.
 *
 * pg-boss creates and migrates its own `pgboss` schema on start(), so the
 * database user needs CREATE privilege on the database.
 */
export function createWorkerBoss(): PgBoss {
  const boss = new PgBoss({
    connectionString: getEnv().DATABASE_URL,
    application_name: "secwire-worker",
    max: 5,
  });
  boss.on("error", (err) => {
    console.error("[pg-boss] error:", err);
  });
  return boss;
}
