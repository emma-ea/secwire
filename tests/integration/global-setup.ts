/**
 * Creates (if needed) and migrates the integration-test database, and lets
 * pg-boss install its schema there. Requires the dev Postgres to be running:
 *   docker compose up -d db
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { PgBoss } from "pg-boss";
import { QUEUE_DEFINITIONS } from "../../src/ingest/boss";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://secwire:secwire@localhost:5432/secwire_test";
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(dbName)) {
    throw new Error(`Refusing to use "${dbName}" for integration tests: the name must contain "test".`);
  }

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Integration tests need Postgres (docker compose up -d db): ${(err as Error).message}`);
  }
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  const pool = new Pool({ connectionString: url });
  await migrate(drizzle({ client: pool, casing: "snake_case" }), {
    migrationsFolder: path.resolve(__dirname, "../../src/db/migrations"),
  });
  await pool.end();

  const boss = new PgBoss({ connectionString: url, schedule: false, supervise: false });
  await boss.start();
  for (const [name, options] of Object.entries(QUEUE_DEFINITIONS)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
  }
  await boss.stop({ graceful: false });
}
