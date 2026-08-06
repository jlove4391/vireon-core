import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import type { MemoryRecord } from "../../schemas/memoryRecord.js";
import { createMemoryRecordWithVersion } from "./createMemoryRecordWithVersion.js";
import { CandidateNotApprovedError, MemoryCandidateNotFoundError } from "./errors.js";

export interface PromoteMemoryCandidateInput {
  tenantId: string;
  candidateId: string;
  actorId: string;
}

/** PR 5: the fixed change_reason recorded on every promotion's version-1 row. */
const PROMOTION_CHANGE_REASON = "Promoted from an approved memory candidate.";

/**
 * Requires the candidate's current review_status to be "approved" --
 * CandidateNotApprovedError otherwise. This naturally prevents
 * double-promotion too, since a promoted candidate is no longer in
 * "approved" status (it moves to "promoted"). In one transaction: insert
 * the new memory_records row, insert its first memory_record_versions row,
 * point the record at that version (all three via createMemoryRecordWithVersion.ts,
 * the shared core also used by tests/shared/seedMemoryRecord.ts), then mark
 * the candidate promoted -- every write succeeds or none does. actorId is a
 * real, required parameter, same documented-not-enforced Sovereign-only note
 * as reviewMemoryCandidate.ts.
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

    const parsedRecord = await createMemoryRecordWithVersion(client, {
      tenantId: input.tenantId,
      content: candidateRow.candidate_content as string,
      // record_type derived from the candidate's own candidate_type where
      // sensible -- both are free-text categorization fields with no enum
      // constraint on either side, so a direct 1:1 mapping is honest.
      recordType: candidateRow.candidate_type as string | null,
      scope: candidateRow.scope as string | null,
      sourceCandidateId: input.candidateId,
      changeReason: PROMOTION_CHANGE_REASON,
    });

    await client.query(
      `UPDATE memory_candidates SET promoted_memory_record_id = $1, review_status = 'promoted' WHERE id = $2 AND tenant_id = $3`,
      [parsedRecord.id, input.candidateId, input.tenantId],
    );

    return parsedRecord;
  });
}
