import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { getEnv } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// Survive Next.js dev HMR without leaking pools.
const globalForDb = globalThis as unknown as {
  __secwirePool?: Pool;
  __secwireDb?: Db;
};

export function getPool(): Pool {
  if (!globalForDb.__secwirePool) {
    const pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
    // An idle client erroring (e.g. DB restart) must not crash the process.
    pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
    globalForDb.__secwirePool = pool;
  }
  return globalForDb.__secwirePool;
}

export function getDb(): Db {
  globalForDb.__secwireDb ??= drizzle({
    client: getPool(),
    schema,
    casing: "snake_case",
  });
  return globalForDb.__secwireDb;
}

export async function closeDb(): Promise<void> {
  const pool = globalForDb.__secwirePool;
  globalForDb.__secwirePool = undefined;
  globalForDb.__secwireDb = undefined;
  await pool?.end();
}

export { schema };

/** Minimal query surface shared by Pool and PoolClient (raw SQL modules use this). */
export type Queryable = Pick<PoolClient, "query">;

/**
 * Runs `fn` in a transaction on a dedicated pool client. Used by the SQL-heavy
 * modules (clustering, story refresh) that pass JS arrays as Postgres arrays.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
