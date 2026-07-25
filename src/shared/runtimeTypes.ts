import { z } from "zod";

// Supported authority outcomes -- core-runtime.md 7.1, ADR 0001, AGENTS.md.
export const authorityOutcomeSchema = z.enum([
  "act",
  "act_and_report",
  "escalate",
  "setup_required",
  "capability_missing",
  "refuse",
]);
export type AuthorityOutcome = z.infer<typeof authorityOutcomeSchema>;

// Stable receipt_type vocabulary -- core-runtime.md 8.3.
export const RECEIPT_TYPES = [
  "work_order_created",
  "authority_decided",
  "state_transitioned",
  "tool_invoked",
  "agent_delegated",
  "artifact_created",
  "memory_candidate_created",
  "run_failed",
  "run_completed",
  "receipt_corrected",
  "receipt_superseded",
  "elora_ingestion_completed",
  "elora_request_blocked",
  "trigger_created",
] as const;

export const receiptTypeSchema = z.enum(RECEIPT_TYPES);
export type ReceiptType = z.infer<typeof receiptTypeSchema>;

// Memory candidate review states -- core-runtime.md 9.3.
export const memoryCandidateReviewStatusSchema = z.enum([
  "proposed",
  "needs_review",
  "approved",
  "rejected",
  "consolidated",
  "superseded",
  "promoted",
]);
export type MemoryCandidateReviewStatus = z.infer<typeof memoryCandidateReviewStatusSchema>;
