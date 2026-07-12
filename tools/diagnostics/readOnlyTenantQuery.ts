import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool.js";

export interface ReadOnlyTenantQueryOptions {
  /** Omit only for the `tenants` command -- see workOrderState/ADR 0001 Decision 6. */
  tenantId?: string;
}

/**
 * Structural read-only isolation for the diagnostics console, mirroring
 * ELORA.md 13's read-only tool isolation pattern. Deliberately not a reuse
 * of withTenantTransaction: `SET TRANSACTION READ ONLY` makes the no-write
 * guarantee structural -- Postgres itself rejects any write attempted
 * inside the callback -- rather than "this caller happened to only write
 * SELECTs." The transaction is rolled back unconditionally, even after a
 * successful read, so the connection never carries a live handle capable of
 * committing a write.
 *
 * Runs through the same non-superuser `vireon` role and the same
 * `SELECT set_config('vireon.current_tenant_id', $1, true)` pattern the
 * application uses -- no RLS bypass, no superuser, no cross-tenant view.
 */
export async function readOnlyTenantQuery<T>(
  callback: (client: PoolClient) => Promise<T>,
  options: ReadOnlyTenantQueryOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    if (options.tenantId) {
      await client.query("SELECT set_config('vireon.current_tenant_id', $1, true)", [options.tenantId]);
    }
    const result = await callback(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
