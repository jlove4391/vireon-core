import { readOnlyTenantQuery } from "./readOnlyTenantQuery.js";

export interface TenantRow {
  id: string;
  name: string;
  created_at: string;
}

export interface WorkOrderSummaryRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * All tenants. No `--tenant` scope: `tenants` is the boundary itself and
 * carries no RLS policy (Phase 1) -- this is the one command with nowhere
 * to scope against, and the entry point for finding a tenant id to use
 * everywhere else.
 */
export async function listTenants(): Promise<TenantRow[]> {
  return readOnlyTenantQuery(async (client) => {
    const result = await client.query("SELECT id, name, created_at FROM tenants ORDER BY created_at DESC");
    return result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      created_at: toIso(row.created_at as string | Date),
    }));
  });
}

/** Recent WorkOrders for a tenant -- the discovery step for a work_order_id. */
export async function listWorkOrdersForTenant(tenantId: string, limit = 20): Promise<WorkOrderSummaryRow[]> {
  return readOnlyTenantQuery(
    async (client) => {
      const result = await client.query(
        "SELECT id, status, created_at, updated_at FROM work_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2",
        [tenantId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        status: row.status as string,
        created_at: toIso(row.created_at as string | Date),
        updated_at: toIso(row.updated_at as string | Date),
      }));
    },
    { tenantId },
  );
}
