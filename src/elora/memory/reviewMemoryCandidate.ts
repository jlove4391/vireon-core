import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryCandidateSchema, type MemoryCandidate } from "../../schemas/memoryCandidate.js";
import { InvalidCandidateReviewStateError, MemoryCandidateNotFoundError } from "./errors.js";

export interface ReviewMemoryCandidateInput {
  tenantId: string;
  candidateId: string;
  actorId: string;
  decision: "approved" | "rejected";
  note?: string | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Requires the candidate's current review_status to be "proposed" -- the
 * only value anything writes today. One review only: this phase does not
 * support re-review, so calling this twice on the same candidate is a
 * state-precondition failure (InvalidCandidateReviewStateError), not a
 * no-op. actorId is a real, required parameter -- documented, not
 * enforced, that only the Sovereign should invoke this today, same
 * "documented invariant, not yet enforced at this layer" pattern 6B
 * established for standing-rule confirmation.
 */
export async function reviewMemoryCandidate(input: ReviewMemoryCandidateInput): Promise<MemoryCandidate> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const existing = await client.query(
      "SELECT * FROM memory_candidates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [input.candidateId, input.tenantId],
    );
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new MemoryCandidateNotFoundError(input.candidateId);
    }
    if (row.review_status !== "proposed") {
      throw new InvalidCandidateReviewStateError(input.candidateId, row.review_status as string);
    }

    const now = new Date().toISOString();
    const updated = await client.query(
      `UPDATE memory_candidates
       SET review_status = $1, reviewed_by_actor_id = $2, reviewed_at = $3, review_note = $4
       WHERE id = $5 AND tenant_id = $6
       RETURNING *`,
      [input.decision, input.actorId, now, input.note ?? null, input.candidateId, input.tenantId],
    );
    const updatedRow = updated.rows[0] as Record<string, unknown>;

    return memoryCandidateSchema.parse({
      id: updatedRow.id,
      tenant_id: updatedRow.tenant_id,
      source_message_id: updatedRow.source_message_id,
      source_receipt_id: updatedRow.source_receipt_id,
      source_work_order_id: updatedRow.source_work_order_id,
      candidate_content: updatedRow.candidate_content,
      candidate_type: updatedRow.candidate_type,
      confidence: updatedRow.confidence === null ? null : Number(updatedRow.confidence),
      scope: updatedRow.scope,
      review_status: updatedRow.review_status,
      reason_for_creation: updatedRow.reason_for_creation,
      promoted_memory_record_id: updatedRow.promoted_memory_record_id,
      created_at: toIso(updatedRow.created_at as string | Date),
      reviewed_by_actor_id: updatedRow.reviewed_by_actor_id,
      reviewed_at: toIso(updatedRow.reviewed_at as string | Date),
      review_note: updatedRow.review_note,
    });
  });
}
