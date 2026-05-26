// src/app/config.js
//
// Reads, validates, and freezes all configuration from environment variables.
// Throws ValidationError at startup if any required value is missing or invalid,
// so misconfiguration is caught immediately rather than at runtime.
import path from "node:path";
import { ValidationError } from "./errors.js";

const VALID_STORAGE_DRIVERS = new Set(["fs", "pg"]);
const VALID_PG_SSL_MODES = new Set(["disable", "require", "no-verify"]);

// Returns the raw string value of an environment variable, or fallback if it
// is absent or empty. All other readers delegate to this function.
function readString(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value);
}

// Parses an environment variable as a base-10 integer.
// Throws ValidationError if the value is present but cannot be parsed.
function readInt(name, fallback) {
  const raw = readString(name, null);
  if (raw === null) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new ValidationError(`Environment variable ${name} must be an integer`);
  }

  return value;
}

// Parses an environment variable as a boolean.
// Accepted truthy values:  1, true, yes, on
// Accepted falsy values:   0, false, no, off
// Throws ValidationError for any other non-empty value.
function readBoolean(name, fallback = false) {
  const raw = readString(name, null);
  if (raw === null) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new ValidationError(`Environment variable ${name} must be a boolean`);
}

// Validate STORAGE_DRIVER early so the error message is actionable.
const storageDriver = readString("STORAGE_DRIVER", "fs");
if (!VALID_STORAGE_DRIVERS.has(storageDriver)) {
  throw new ValidationError(
    `STORAGE_DRIVER must be one of: ${Array.from(VALID_STORAGE_DRIVERS).join(", ")}`
  );
}

// Validate PG_SSL_MODE early so the error message is actionable.
const pgSslMode = readString("PG_SSL_MODE", "disable");
if (!VALID_PG_SSL_MODES.has(pgSslMode)) {
  throw new ValidationError(
    `PG_SSL_MODE must be one of: ${Array.from(VALID_PG_SSL_MODES).join(", ")}`
  );
}

// Frozen config object – all values are resolved once at module load time.
const config = Object.freeze({
  // General
  nodeEnv: readString("NODE_ENV", "development"),
  port: readInt("PORT", 3000),

  // Storage driver: 'fs' (flat JSON file) or 'pg' (PostgreSQL)
  storageDriver,

  // Flat-file storage settings (used when STORAGE_DRIVER=fs)
  dataDir: path.resolve(process.cwd(), readString("DATA_DIR", "./data")),
  fsDbFileName: readString("FS_DB_FILE_NAME", "forms-db.json"),

  // PostgreSQL settings (used when STORAGE_DRIVER=pg)
  databaseUrl: readString("DATABASE_URL", null),
  pgPoolMax: readInt("PG_POOL_MAX", 10),
  pgConnectionTimeoutMs: readInt("PG_CONNECTION_TIMEOUT_MS", 5000),
  pgIdleTimeoutMs: readInt("PG_IDLE_TIMEOUT_MS", 10000),
  pgStatementTimeoutMs: readInt("PG_STATEMENT_TIMEOUT_MS", 10000),
  pgQueryTimeoutMs: readInt("PG_QUERY_TIMEOUT_MS", 10000),
  pgSslMode,

  // Set to true when the server runs behind a reverse proxy (e.g. nginx).
  // Required for Express to trust the X-Forwarded-For header.
  trustProxy: readBoolean("TRUST_PROXY", false),

  // Allowed CORS origin. When null, the CORS middleware is not applied.
  corsOrigin: readString("CORS_ORIGIN", null),

  // Admin credentials. The password is stored as a bcrypt hash.
  // Both values are required – the server will not start without them.
  adminBasicAuthUser: readString("ADMIN_BASIC_AUTH_USER", null),
  adminBasicAuthPassHash: readString("ADMIN_BASIC_AUTH_PASS_HASH", null)
});

// DATABASE_URL is mandatory when using the PostgreSQL driver.
if (config.storageDriver === "pg" && !config.databaseUrl) {
  throw new ValidationError(
    "DATABASE_URL is required when STORAGE_DRIVER=pg"
  );
}

// Fail fast if admin credentials are missing rather than allowing the server
// to start in a state where login would always fail.
if (!config.adminBasicAuthUser) {
  throw new ValidationError("ADMIN_BASIC_AUTH_USER must be set");
}
if (!config.adminBasicAuthPassHash) {
  throw new ValidationError("ADMIN_BASIC_AUTH_PASS_HASH must be set");
}

export default config;