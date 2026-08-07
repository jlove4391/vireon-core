import { withTenantTransaction } from "../../db/withTenantTransaction.js";

/**
 * Diagnostic-only, not invoked automatically on any retrieval hot path. The
 * root-cause fix (createMemoryRecordWithVersion.ts as the single write path
 * for both production promotion and test seeding) should make this
 * permanently zero going forward; this exists so that guarantee can be
 * actively checked -- from a diagnostics command or an occasional
 * consistency sweep -- rather than only discoverable by noticing
 * retrieveHybridMemory() silently returning fewer results than expected,
 * since its current_version_id IS NOT NULL requirement makes any such row
 * structurally invisible to hybrid retrieval.
 */
export async function countUnversionedActiveMemoryRecords(tenantId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM memory_records WHERE tenant_id = $1 AND deleted_at IS NULL AND current_version_id IS NULL`,
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  });
}
