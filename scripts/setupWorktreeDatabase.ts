import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Multiple concurrent git worktrees share one Postgres instance -- Docker
// Compose binds fixed host ports (5432/6379), so only the worktree that
// starts its stack first can bind them, and every other worktree points
// its own .env at those already-running containers instead. That's fine
// for Redis: it's ephemeral, lock keys are scoped by per-test
// randomly-generated tenant/trigger ids, and there's no schema or
// migration state to bleed across worktrees. It is NOT fine for Postgres:
// pnpm db:migrate run from a worktree on a newer branch would apply its
// migrations to the SAME database another worktree's tests run against,
// even if that worktree is on an older branch that knows nothing about
// the new schema. This script does not touch Docker Compose, ports, or
// containers, and does not add any Redis isolation -- it gives each
// non-main worktree its own database inside the shared Postgres instance,
// which closes the migration-bleed risk directly.

const BOOTSTRAP_HOST = "localhost";
const BOOTSTRAP_PORT = 5432;
const BOOTSTRAP_USER = "postgres_bootstrap";
const BOOTSTRAP_PASSWORD = "postgres_bootstrap";
const DEFAULT_DATABASE = "vireon_core";
const APP_ROLE = "vireon";
const MAX_SUFFIX_LENGTH = 40;

// Local-dev-only bootstrap credentials, hardcoded the same way
// docker-compose.yml itself hardcodes them -- this script never runs
// against a real deployment. It intentionally does not import
// src/db/pool.ts: that pool connects as the non-superuser `vireon` app
// role (docker/init/01-bootstrap-app-role.sql), which cannot create
// databases.
function bootstrapConnectionString(database: string): string {
  return `postgres://${BOOTSTRAP_USER}:${BOOTSTRAP_PASSWORD}@${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}/${database}`;
}

// Branch names routinely contain characters (like /) that are not valid
// unquoted Postgres identifier characters. 63-byte Postgres identifier
// limit; 40 chars of sanitized branch name leaves comfortable headroom
// under the "vireon_core_" prefix.
function deriveDatabaseName(branch: string): string {
  const sanitized = branch
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SUFFIX_LENGTH);
  return `vireon_core_${sanitized}`;
}

/** Returns true if the database was newly created, false if it already existed. */
async function ensureDatabaseExists(dbName: string): Promise<boolean> {
  const client = new Client({ connectionString: bootstrapConnectionString(DEFAULT_DATABASE) });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (existing.rows.length > 0) {
      return false;
    }
    // CREATE DATABASE cannot execute inside a transaction block -- this is
    // a single standalone statement on its own connection, not wrapped in
    // any BEGIN/COMMIT.
    await client.query(`CREATE DATABASE "${dbName}" OWNER ${APP_ROLE}`);
    return true;
  } finally {
    await client.end();
  }
}

// Extensions and schema grants are per-database in Postgres, so this runs
// even for an already-existing database from a prior invocation -- a new
// database starts with none of what vireon_core's own
// docker/init/01-bootstrap-app-role.sql already set up for it. Every
// statement here is idempotent, safe to repeat on every run.
async function prepareDatabase(dbName: string): Promise<void> {
  const client = new Client({ connectionString: bootstrapConnectionString(dbName) });
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query(`GRANT ALL ON SCHEMA public TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}

// Same targeted line-replacement approach as seedDevIdentity.ts's
// writeEnvVars: regex-match the existing DATABASE_URL line and replace
// only it, never blind-overwrite the file. Copies .env.example to .env
// first if .env doesn't exist yet, same as every other script in this
// repo that expects a local .env.
function writeDatabaseUrl(dbName: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(__dirname, "..", ".env");
  const envExamplePath = path.join(__dirname, "..", ".env.example");

  if (!existsSync(envPath)) {
    copyFileSync(envExamplePath, envPath);
  }

  // Split on \r?\n and strip any trailing \r -- this repo's .env/.env.example
  // are checked out with CRLF line endings on Windows, and JS regex without
  // the `s`/`m` flags treats \r as a line terminator: `.` won't match it and
  // `$` won't match before it, so an unstripped trailing \r silently breaks
  // the match below.
  const existingLines = readFileSync(envPath, "utf8").split(/\r?\n/);
  let newDatabaseUrl: string | null = null;
  const nextLines = existingLines.map((line) => {
    const match = /^DATABASE_URL=(.*)$/.exec(line);
    if (!match) return line;
    const url = new URL(match[1]!);
    url.pathname = `/${dbName}`;
    newDatabaseUrl = url.toString();
    return `DATABASE_URL=${newDatabaseUrl}`;
  });

  if (!newDatabaseUrl) {
    throw new Error("setupWorktreeDatabase: no DATABASE_URL line found in .env to update");
  }

  writeFileSync(envPath, nextLines.join("\n"));
  return newDatabaseUrl;
}

async function run(): Promise<void> {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();

  // Always safe to run unconditionally at the start of any session --
  // main uses the shared default database, no per-worktree isolation
  // needed there, so nothing below this line runs for that case.
  if (branch === "main") {
    console.log("On main -- using the shared default vireon_core database. No changes made.");
    return;
  }

  const dbName = deriveDatabaseName(branch);
  const created = await ensureDatabaseExists(dbName);
  await prepareDatabase(dbName);
  const databaseUrl = writeDatabaseUrl(dbName);

  console.log(`Branch: ${branch}`);
  console.log(`${created ? "Created" : "Reusing existing"} database: ${dbName}`);
  console.log(`.env DATABASE_URL updated to: ${databaseUrl}`);
  console.log("This database is empty and extension-ready -- run `pnpm db:migrate` next to apply schema.");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
