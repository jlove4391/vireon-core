import type { PoolClient } from "pg";
import { pool } from "./pool.js";

/**
 * Enforces the deterministic tenant-scoped transaction sequence required by
 * ADR 0001 / core-runtime.md 14.2 / AGENTS.md: checkout isolated client,
 * BEGIN, set transaction-scoped tenant context, run the callback, COMMIT on
 * success / ROLLBACK on failure, release in `finally`.
 *
 * No tenant-scoped SQL should run outside this helper.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('vireon.current_tenant_id', $1, true)", [tenantId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
