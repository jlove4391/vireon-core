import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryRecordSchema, type MemoryRecord } from "../../schemas/memoryRecord.js";
import { memoryRecordVersionSchema } from "../../schemas/memoryRecordVersion.js";
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
 * point the record at that version, then mark the candidate promoted --
 * every write succeeds or none does. actorId is a real, required parameter,
 * same documented-not-enforced Sovereign-only note as reviewMemoryCandidate.ts.
 *
 * Insertion order is load-bearing, not incidental: memory_records.id and
 * memory_record_versions.id are mutually referenced (current_version_id ->
 * versions.id; versions.memory_record_id -> records.id), and neither FK in
 * this codebase is DEFERRABLE. The record is inserted first with
 * current_version_id left NULL (the column is nullable for exactly this
 * bootstrap reason), then the version row (which can now legally reference
 * the record's real id), then a final UPDATE points the record at it -- all
 * three statements share this function's one transaction, so a failure at
 * any step rolls back all of them, same atomicity guarantee as before, just
 * one more step to get there.
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
    const recordId = randomUUID();
    const versionId = randomUUID();

    const parsedVersion = memoryRecordVersionSchema.parse({
      id: versionId,
      tenant_id: input.tenantId,
      memory_record_id: recordId,
      version_number: 1,
      content: candidateRow.candidate_content,
      change_reason: PROMOTION_CHANGE_REASON,
      is_deletion_marker: false,
      created_at: now,
    });

    const parsedRecord = memoryRecordSchema.parse({
      id: recordId,
      tenant_id: input.tenantId,
      source_candidate_id: input.candidateId,
      content: candidateRow.candidate_content,
      // record_type derived from the candidate's own candidate_type where
      // sensible -- both are free-text categorization fields with no enum
      // constraint on either side, so a direct 1:1 mapping is honest.
      record_type: candidateRow.candidate_type,
      scope: candidateRow.scope,
      current_version_id: versionId,
      deleted_at: null,
      created_at: now,
    });

    await client.query(
      `INSERT INTO memory_records (id, tenant_id, source_candidate_id, content, record_type, scope, current_version_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)`,
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
      `INSERT INTO memory_record_versions (id, tenant_id, memory_record_id, version_number, content, change_reason, is_deletion_marker, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        parsedVersion.id,
        parsedVersion.tenant_id,
        parsedVersion.memory_record_id,
        parsedVersion.version_number,
        parsedVersion.content,
        parsedVersion.change_reason,
        parsedVersion.is_deletion_marker,
        parsedVersion.created_at,
      ],
    );

    await client.query(`UPDATE memory_records SET current_version_id = $1 WHERE id = $2 AND tenant_id = $3`, [
      versionId,
      parsedRecord.id,
      input.tenantId,
    ]);

    await client.query(
      `UPDATE memory_candidates SET promoted_memory_record_id = $1, review_status = 'promoted' WHERE id = $2 AND tenant_id = $3`,
      [parsedRecord.id, input.candidateId, input.tenantId],
    );

    return parsedRecord;
  });
}
