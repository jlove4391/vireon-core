import type { PoolClient } from "pg";
import { DirectiveReferenceNotFoundError } from "./errors.js";

/**
 * Confirmed empirically (not assumed): a plain `uuid REFERENCES x(id)` FK
 * does NOT block a tenant-A transaction from referencing a real row that
 * belongs to tenant B -- Postgres FK constraint checks run independent of
 * row-level security. Option B (Phase A fork resolution) deliberately
 * chose plain FKs over composite tenant-safe ones for
 * operator_directive_provenance, reasoning "tenant safety rides on RLS +
 * tenant-scoped queries" -- but that reasoning only holds for READS (a
 * tenant's own queries only ever see its own rows); it does not hold for
 * WRITES, where nothing was stopping a caller from storing a foreign
 * tenant's real id in a reference column. This helper is what actually
 * makes "tenant safety rides on tenant-scoped queries" true: every
 * reference this domain accepts is checked against this exact query
 * shape before being written, closing the write-time gap without
 * reopening the composite-FK-vs-plain-FK schema question Option B
 * already settled.
 *
 * `table` must always be a fixed, hardcoded string literal from this
 * domain's own call sites -- never derived from caller input -- since it
 * is interpolated directly into the query.
 */
export async function assertTenantScopedReference(
  client: PoolClient,
  table: string,
  id: string,
  tenantId: string,
  field: string,
): Promise<void> {
  const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (result.rows.length === 0) {
    throw new DirectiveReferenceNotFoundError(field, id);
  }
}
