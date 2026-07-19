import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryRecordSchema, type MemoryRecord } from "../../schemas/memoryRecord.js";
import { CandidateNotApprovedError, MemoryCandidateNotFoundError } from "./errors.js";

export interface PromoteMemoryCandidateInput {
  tenantId: string;
  candidateId: string;
  actorId: string;
}

/**
 * Requires the candidate's current review_status to be "approved" --
 * CandidateNotApprovedError otherwise. This naturally prevents
 * double-promotion too, since a promoted candidate is no longer in
 * "approved" status (it moves to "promoted"). In one transaction: insert
 * the new memory_records row, then mark the candidate promoted -- both
 * writes succeed or neither does. actorId is a real, required parameter,
 * same documented-not-enforced Sovereign-only note as reviewMemoryCandidate.ts.
 */
export async function promoteMemoryCandidate(input: PromoteMemoryCandidateInput): Promise<MemoryRecord> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const existing = await client.query(
      "SELECT * FROM memory_candidates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [input.candidateId, input.tenantId],
    );
    const candidateRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (!candidateRow) {
      throw new MemoryCandidateNotFoundError(input.candidateId);
    }
    if (candidateRow.review_status !== "approved") {
      throw new CandidateNotApprovedError(input.candidateId, candidateRow.review_status as string);
    }

    const now = new Date().toISOString();
    const parsedRecord = memoryRecordSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      source_candidate_id: input.candidateId,
      content: candidateRow.candidate_content,
      // record_type derived from the candidate's own candidate_type where
      // sensible -- both are free-text categorization fields with no enum
      // constraint on either side, so a direct 1:1 mapping is honest.
      record_type: candidateRow.candidate_type,
      scope: candidateRow.scope,
      created_at: now,
    });

    await client.query(
      `INSERT INTO memory_records (id, tenant_id, source_candidate_id, content, record_type, scope, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        parsedRecord.id,
        parsedRecord.tenant_id,
        parsedRecord.source_candidate_id,
        parsedRecord.content,
        parsedRecord.record_type,
        parsedRecord.scope,
        parsedRecord.created_at,
      ],
    );

    await client.query(
      `UPDATE memory_candidates SET promoted_memory_record_id = $1, review_status = 'promoted' WHERE id = $2 AND tenant_id = $3`,
      [parsedRecord.id, input.candidateId, input.tenantId],
    );

    return parsedRecord;
  });
}
