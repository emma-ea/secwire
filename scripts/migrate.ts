/**
 * Applies Drizzle migrations from src/db/migrations. Uses the runtime migrator
 * rather than drizzle-kit so it can run in a production image without dev deps.
 */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "../src/db/client";

async function main() {
  const migrationsFolder = path.resolve(__dirname, "../src/db/migrations");
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(getDb(), { migrationsFolder });
  console.log("[migrate] done");
}

main()
  .catch((err: unknown) => {
    console.error("[migrate] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
