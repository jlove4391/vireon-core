import { z } from "zod";

// Phase 6E: the stable UI-facing contract for POST /api/elora/messages.
// This package exports Zod schemas and their inferred types only -- it
// must never import from src/elora/ or any other backend-internal module.
// The enums below are OWNED by this package, deliberately duplicated from
// (not re-exported from) src/shared/runtimeTypes.ts / src/state/workOrderState.ts
// / src/elora/types.ts -- confirmed against those files at implementation
// time, not copied from an earlier planning draft. If an internal enum
// grows later, the backend transform function
// (src/http/contracts/eloraMessageResponse.ts) reconciles the divergence;
// this contract's enum does not have to grow in lockstep.

export const eloraResponseTypeSchema = z.enum([
  "direct_answer",
  "escalation_required",
  "setup_required",
  "capability_missing",
  "refused",
  "clarification_required",
  "execution_failed",
]);
export type EloraResponseType = z.infer<typeof eloraResponseTypeSchema>;

export const authorityOutcomeSchema = z.enum([
  "act",
  "act_and_report",
  "escalate",
  "setup_required",
  "capability_missing",
  "refuse",
]);
export type AuthorityOutcome = z.infer<typeof authorityOutcomeSchema>;

export const workOrderStatusSchema = z.enum([
  "RECEIVED",
  "INTENT_PARSED",
  "AUTHORITY_CLASSIFIED",
  "READY_TO_ACT",
  "AWAITING_AUTHORIZATION",
  "SETUP_REQUIRED",
  "CAPABILITY_MISSING",
  "REFUSED",
  "EXECUTING",
  "VALIDATING",
  "RECEIPT_WRITTEN",
  "MEMORY_CANDIDATES_CREATED",
  "COMPLETED",
  "FAILED",
]);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

// A deliberately flattened, narrower DTO -- not a redacted copy of the
// backend's internal EloraIngestionResult. See AUTHORITY_AND_DELEGATION.md-
// style reasoning captured in the Phase 6E handoff: tenantId,
// authorityDecisionId, transitionPath, and the raw intent object are all
// deliberately excluded (not an oversight -- see the Phase 6E completion
// report for why).
//
// 6H §5.3: retrievedMemoryCount is added here, additively -- a bare count,
// the "minimum safe" retrieval metadata decided in 6H's Phase A proposal.
// retrievedMemoryIds (raw internal memory_records UUIDs) is deliberately
// still excluded: no frontend consumer exists for it (6H's own non-goals
// exclude a memory review UI), and it would expose internal row identifiers
// and retrieval-ranking internals for no current purpose. Add it later,
// additively, only when something on the frontend actually needs it.
export const EloraMessageResponseSchema = z.object({
  schemaVersion: z.literal("1"),

  threadId: z.string().uuid(),
  messageId: z.string().uuid(),
  isDuplicateMessage: z.boolean(),

  responseType: eloraResponseTypeSchema,
  responseText: z.string(),

  workOrderId: z.string().uuid().nullable(),
  authorityOutcome: authorityOutcomeSchema.nullable(),
  finalWorkOrderStatus: workOrderStatusSchema.nullable(),

  actionReceiptId: z.string().uuid().nullable(),
  blockedReceiptId: z.string().uuid().nullable(),
  toolInvocationId: z.string().uuid().nullable(),
  artifactId: z.string().uuid().nullable(),
  /**
   * Flattened from the backend's internal intent.artifactRequest?.filename
   * -- the raw intent object never crosses the boundary. See the backend
   * transform function for exactly where this value comes from.
   */
  artifactFilename: z.string().nullable(),

  memoryCandidateIds: z.array(z.string().uuid()),
  retrievedMemoryCount: z.number().int().nonnegative(),
});
export type EloraMessageResponse = z.infer<typeof EloraMessageResponseSchema>;

// Request contract -- moved here from eloraMessages.ts (Phase 6A) for
// symmetry, so both directions of the contract are genuinely shared, not
// just the response side.
export const SendEloraMessageRequestSchema = z.object({
  threadId: z.string().uuid().optional(),
  content: z.string().trim().min(1, "content must not be empty"),
  clientRequestId: z.string().trim().min(1, "clientRequestId must not be empty"),
});
export type SendEloraMessageRequest = z.infer<typeof SendEloraMessageRequestSchema>;
