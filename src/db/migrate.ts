import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/** Applies migration files from `migrations/` in deterministic (filename) order. */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const alreadyApplied = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedFilenames = new Set(alreadyApplied.rows.map((row) => row.filename));

    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of migrationFiles) {
      if (appliedFilenames.has(filename)) {
        continue;
      }

      const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");

      console.log(`Applying migration: ${filename}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  migrate()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      process.exitCode = 1;
      await pool.end();
    });
}
