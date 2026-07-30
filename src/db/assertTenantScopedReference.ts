import type { PoolClient } from "pg";

/**
 * Confirmed empirically (not assumed): a plain `uuid REFERENCES x(id)` FK
 * does NOT block a tenant-A transaction from referencing a real row that
 * belongs to tenant B -- Postgres FK constraint checks run independent of
 * row-level security. RLS governs what a tenant-scoped query can see; it
 * does not govern what an FK constraint validates on write. This is the
 * write-time check that closes that gap: every internal reference a
 * caller can influence must be confirmed to belong to the acting tenant
 * before it is persisted, not left to ride on "RLS + tenant-scoped
 * queries" alone.
 *
 * Domain-neutral core shared across every domain that accepts a
 * caller-influenced internal reference (directives, state/WorkOrder,
 * ELORA triggers, ...) -- one query shape, reused, not reimplemented per
 * domain. Each domain supplies its own `onNotFound` so the thrown error
 * stays in that domain's own error taxonomy.
 *
 * `table` must always be a fixed, hardcoded string literal from the
 * caller's own call site -- never derived from external input -- since it
 * is interpolated directly into the query.
 */
export async function assertTenantScopedReference(
  client: PoolClient,
  table: string,
  id: string,
  tenantId: string,
  onNotFound: () => Error,
): Promise<void> {
  const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (result.rows.length === 0) {
    throw onNotFound();
  }
}
