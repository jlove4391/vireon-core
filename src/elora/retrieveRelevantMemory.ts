import { withTenantTransaction } from "../db/withTenantTransaction.js";

export interface RetrieveRelevantMemoryInput {
  tenantId: string;
  queryText: string;
  limit?: number;
  /**
   * 6H: the requesting persona's PersonaConfig.domain (@vireon/persona-config).
   * Omit, or pass null/undefined/empty string, for a persona with no domain
   * (Elora today -- executive-tier, sees the full unweighted pool per 6H's
   * hard requirement). When present, ranks scope-matching records first;
   * never narrows the WHERE clause -- domain affects ranking only, never
   * access. The absent/falsy case is handled by constructing a different
   * ORDER BY clause in TypeScript, not by relying on SQL NULL comparison
   * semantics, so it reproduces today's query byte-for-byte rather than
   * merely behaving equivalently.
   */
  requestingPersonaDomain?: string | null;
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
 *
 * 6H: requestingPersonaDomain adds ranking-only domain weighting on top of
 * this same deterministic, embedding-free query -- still no vector search,
 * still no new schema, still tenant-only hard scoping. See that field's
 * own doc comment for the access-vs-ranking guarantee.
 */
export async function retrieveRelevantMemory(input: RetrieveRelevantMemoryInput): Promise<RetrievedMemoryRecord[]> {
  const limit = input.limit ?? 5;
  const tokens = tokenize(input.queryText);
  if (tokens.length === 0) {
    return [];
  }

  return withTenantTransaction(input.tenantId, async (client) => {
    const conditions = tokens.map((_, index) => `content ILIKE $${index + 2}`).join(" OR ");
    const params: (string | number)[] = [input.tenantId, ...tokens.map((token) => `%${token}%`)];

    // Domain-weighted ranking (6H §5.1): a boost term, prepended only when
    // a domain is actually supplied. Absent/null/empty reproduces the
    // pre-6H query exactly -- no clause added, not a no-op clause added.
    //
    // PR #19 review fix: `scope = $N` is SQL three-valued logic, so a
    // null-scope row evaluates to NULL, not false. Postgres's default NULL
    // ordering for DESC is NULLS FIRST -- meaning a null-scope row would
    // rank ahead of even a genuine domain match, the opposite of intended.
    // COALESCE(..., false) normalizes NULL to false before the sort, so a
    // null-scope row behaves exactly like a non-matching-scope row (ranked
    // after real matches, interleaved with other non-matches by recency),
    // not as its own incorrectly-privileged third tier.
    let orderBy = "created_at DESC";
    if (input.requestingPersonaDomain) {
      params.push(input.requestingPersonaDomain);
      orderBy = `COALESCE(scope = $${params.length}, false) DESC, created_at DESC`;
    }

    params.push(limit);
    const limitParamIndex = params.length;

    const result = await client.query(
      `SELECT id, content, record_type, scope FROM memory_records
       WHERE tenant_id = $1 AND (${conditions})
       ORDER BY ${orderBy}
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
