import { readOnlyTenantQuery } from "./readOnlyTenantQuery.js";

export interface MemoryCandidateSummaryRow {
  id: string;
  review_status: string;
  scope: string | null;
  candidate_type: string | null;
  candidate_content: string;
  created_at: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export interface ListMemoryCandidatesOptions {
  status?: string;
  scope?: string;
  limit?: number;
}

/** Read-only discovery command -- the way to actually find a candidate id to review/promote, since nothing else surfaces this data. */
export async function listMemoryCandidates(
  tenantId: string,
  options: ListMemoryCandidatesOptions = {},
): Promise<MemoryCandidateSummaryRow[]> {
  return readOnlyTenantQuery(
    async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: (string | number)[] = [tenantId];

      if (options.status) {
        params.push(options.status);
        conditions.push(`review_status = $${params.length}`);
      }
      if (options.scope) {
        params.push(options.scope);
        conditions.push(`scope = $${params.length}`);
      }

      const limit = options.limit ?? 20;
      params.push(limit);

      const result = await client.query(
        `SELECT id, review_status, scope, candidate_type, candidate_content, created_at
         FROM memory_candidates
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      );

      return result.rows.map((row) => ({
        id: row.id as string,
        review_status: row.review_status as string,
        scope: row.scope as string | null,
        candidate_type: row.candidate_type as string | null,
        candidate_content: row.candidate_content as string,
        created_at: toIso(row.created_at as string | Date),
      }));
    },
    { tenantId },
  );
}
