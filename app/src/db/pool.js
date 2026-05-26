// src/db/pool.js
//
// PostgreSQL connection pool and transaction helper.
// The pool is created lazily on the first call to getPool() and reused for
// the lifetime of the process. All storage modules consume this shared pool.
import pg from "pg";
import config from "../app/config.js";
import { StorageError } from "../app/errors.js";

const { Pool } = pg;

// Singleton Pool instance; null until the first call to getPool().
let pool = null;

// Converts the PGSSLMODE-style config string to the ssl option accepted by pg.
// 'disable'   – no SSL
// 'require'   – SSL with full certificate verification
// 'no-verify' – SSL without certificate verification (useful for self-signed certs)
function getSslConfig() {
  switch (config.pgSslMode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: true };
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      return false;
  }
}

// Returns the shared Pool instance, creating it on the first call.
// Throws StorageError if DATABASE_URL is not configured.
// The pool attaches an error listener that logs idle-client errors without
// crashing the process (errors outside a request chain cannot be thrown).
export function getPool() {
  if (pool) {
    return pool;
  }

  if (!config.databaseUrl) {
    throw new StorageError("DATABASE_URL is not configured");
  }

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: config.pgIdleTimeoutMs,
    connectionTimeoutMillis: config.pgConnectionTimeoutMs,
    statement_timeout: config.pgStatementTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs,
    ssl: getSslConfig(),
    application_name: "forms-service"
  });

  pool.on("error", (error) => {
    // Log unexpected errors on idle pool clients centrally.
    // We intentionally do not throw here because this event fires outside
    // the normal request chain and would crash the process.
    console.error("[pg-pool-error]", error);
  });

  return pool;
}

// Borrows a client from the pool, runs a simple SELECT 1, and releases it.
// Used by initStorage() to verify database connectivity at startup.
// Throws StorageError if the connection cannot be established.
export async function initDb() {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
  } catch (error) {
    throw new StorageError("Database connectivity check failed", {
      cause: error.message
    });
  } finally {
    client.release();
  }
}

// Executes work(client) inside a BEGIN / COMMIT transaction block.
// Automatically rolls back if work throws, then re-throws the original error.
// The client is always released back to the pool in the finally block.
export async function withTransaction(work) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors; the original error is what matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

// Drains and closes the connection pool. Called during graceful server shutdown.
// Clears the singleton so a new pool can be created if the process continues.
export async function closeDb() {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end();
}