import { withTenantTransaction } from "../db/withTenantTransaction.js";

export interface RetrieveRelevantMemoryInput {
  tenantId: string;
  queryText: string;
  limit?: number;
}

export interface RetrievedMemoryRecord {
  id: string;
  content: string;
  recordType: string | null;
  scope: string | null;
}

const STOPWORD_MIN_LENGTH = 4;

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= STOPWORD_MIN_LENGTH);
  return Array.from(new Set(words));
}

/**
 * Deterministic text-match retrieval against memory_records -- no
 * embeddings, no pgvector query, even though the embedding column exists
 * (Phase 3 §6/§13). Scoping note: memory_records (migration 0001) carries
 * only tenant_id, not workspace_id/project_id, so hard scoping is
 * tenant-only; there is no schema-level way to narrow further without a
 * migration, which is out of scope here.
 */
export async function retrieveRelevantMemory(input: RetrieveRelevantMemoryInput): Promise<RetrievedMemoryRecord[]> {
  const limit = input.limit ?? 5;
  const tokens = tokenize(input.queryText);
  if (tokens.length === 0) {
    return [];
  }

  return withTenantTransaction(input.tenantId, async (client) => {
    const conditions = tokens.map((_, index) => `content ILIKE $${index + 2}`).join(" OR ");
    const limitParamIndex = tokens.length + 2;
    const params: (string | number)[] = [input.tenantId, ...tokens.map((token) => `%${token}%`), limit];

    const result = await client.query(
      `SELECT id, content, record_type, scope FROM memory_records
       WHERE tenant_id = $1 AND (${conditions})
       ORDER BY created_at DESC
       LIMIT $${limitParamIndex}`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      recordType: row.record_type as string | null,
      scope: row.scope as string | null,
    }));
  });
}
