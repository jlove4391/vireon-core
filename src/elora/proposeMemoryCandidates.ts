import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { memoryCandidateSchema, type MemoryCandidate } from "../schemas/memoryCandidate.js";
import { EloraMemoryCandidateError } from "./errors.js";
import type { EloraAuthorityClassification, EloraStructuredIntent } from "./types.js";

export interface ProposeMemoryCandidatesInput {
  tenantId: string;
  workOrderId: string;
  intent: EloraStructuredIntent;
  authority: EloraAuthorityClassification;
}

/**
 * Branch-specific per §8: proposes a candidate on READY_TO_ACT,
 * capability_missing, and setup_required (stable, low-noise, genuinely
 * recurring patterns worth accumulating). Proposes nothing on escalate
 * (too request-specific to generalize) or refuse (refused-request content
 * must never flow into anything that could later surface in a
 * user-facing retrieved-memory answer).
 *
 * Writes directly to memory_candidates, independent of the state machine
 * -- transitionWorkOrder()'s only memory-candidate write path is gated
 * behind RECEIPT_WRITTEN -> MEMORY_CANDIDATES_CREATED, unreachable in
 * Phase 3. source_work_order_id alone satisfies memoryCandidateSchema's
 * source requirement.
 */
export async function proposeMemoryCandidates(input: ProposeMemoryCandidatesInput): Promise<MemoryCandidate[]> {
  const shouldPropose =
    input.authority.outcome === "act" ||
    input.authority.outcome === "act_and_report" ||
    input.authority.outcome === "capability_missing" ||
    input.authority.outcome === "setup_required";

  if (!shouldPropose) {
    return [];
  }

  const { candidateContent, candidateType, reasonForCreation } = buildCandidateContent(input);

  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const parsedCandidate = memoryCandidateSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      source_message_id: null,
      source_receipt_id: null,
      source_work_order_id: input.workOrderId,
      candidate_content: candidateContent,
      candidate_type: candidateType,
      confidence: input.intent.confidence,
      scope: "project",
      reason_for_creation: reasonForCreation,
      promoted_memory_record_id: null,
      created_at: now,
    });

    try {
      await client.query(
        `INSERT INTO memory_candidates
           (id, tenant_id, source_message_id, source_receipt_id, source_work_order_id,
            candidate_content, candidate_type, confidence, scope, review_status,
            reason_for_creation, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          parsedCandidate.id,
          parsedCandidate.tenant_id,
          parsedCandidate.source_message_id,
          parsedCandidate.source_receipt_id,
          parsedCandidate.source_work_order_id,
          parsedCandidate.candidate_content,
          parsedCandidate.candidate_type,
          parsedCandidate.confidence,
          parsedCandidate.scope,
          parsedCandidate.review_status,
          parsedCandidate.reason_for_creation,
          parsedCandidate.created_at,
        ],
      );
    } catch (error) {
      throw new EloraMemoryCandidateError(error instanceof Error ? error.message : String(error));
    }

    return [parsedCandidate];
  });
}

function buildCandidateContent(input: ProposeMemoryCandidatesInput): {
  candidateContent: string;
  candidateType: string;
  reasonForCreation: string;
} {
  switch (input.authority.outcome) {
    case "capability_missing":
      return {
        candidateContent: `User requested a capability the runtime structurally lacks: ${input.intent.summary}`,
        candidateType: "capability_gap",
        reasonForCreation: "Recurring capability-missing pattern worth accumulating (§8).",
      };
    case "setup_required":
      return {
        candidateContent: `Implementation task lacked a project scope: ${input.intent.summary}`,
        candidateType: "setup_gap",
        reasonForCreation: "Recurring task-type/workspace-missing-project pattern worth accumulating (§8).",
      };
    default:
      return {
        candidateContent: `ELORA completed an ingestion request: ${input.intent.summary}`,
        candidateType: "observation",
        reasonForCreation: "Derived from a successfully answered ELORA ingestion request.",
      };
  }
}
