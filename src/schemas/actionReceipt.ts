import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";
import { authorityOutcomeSchema } from "../shared/runtimeTypes.js";

// Shared base -- core-runtime.md 8.2. Holds only fields that are genuinely
// universal across every receipt type. Variant-specific fields live in
// `payload` per the JSONB boundary in 6.5.
const receiptBaseSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  schema_version: z.number().int().positive(),
  actor_id: z.string().min(1),
  acting_system: z.string().min(1),
  created_at: z.string().datetime(),
  parent_receipt_id: uuidSchema.nullable(),
  supersedes_receipt_id: uuidSchema.nullable(),
  correction_receipt_id: uuidSchema.nullable(),
});

const workOrderCreatedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("work_order_created"),
  payload: z.object({
    work_order_id: uuidSchema,
    task_type: z.string().min(1),
    summary: z.string().optional(),
  }),
});

const authorityDecidedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("authority_decided"),
  payload: z.object({
    authority_decision_id: uuidSchema,
    outcome: authorityOutcomeSchema,
    requires_human_gatekeeper: z.boolean(),
  }),
});

const stateTransitionedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("state_transitioned"),
  payload: z.object({
    entity_type: z.string().min(1),
    entity_id: uuidSchema,
    from_state: z.string().min(1),
    to_state: z.string().min(1),
  }),
});

const toolInvokedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("tool_invoked"),
  payload: z.object({
    tool_invocation_id: uuidSchema,
    tool_identifier: z.string().min(1),
    status: z.string().min(1),
  }),
});

// Phase 6D: work_order_id is the child WorkOrder created by the delegation
// (matches work_order_created's own convention of referencing the entity
// that was just created); parent_work_order_id and delegation_mode are
// additive so the receipt documents the full link, not just who was
// involved. reason is a human-readable note -- genuinely useful to read,
// not just the four IDs.
const agentDelegatedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("agent_delegated"),
  payload: z.object({
    parent_actor_id: z.string().min(1),
    child_actor_id: z.string().min(1),
    work_order_id: uuidSchema,
    parent_work_order_id: uuidSchema,
    delegation_mode: z.enum(["supervised", "peer"]),
    reason: z.string().min(1),
  }),
});

const artifactCreatedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("artifact_created"),
  payload: z.object({
    artifact_id: uuidSchema,
    artifact_type: z.string().min(1),
  }),
});

const memoryCandidateCreatedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("memory_candidate_created"),
  payload: z.object({
    memory_candidate_id: uuidSchema,
    candidate_type: z.string().optional(),
  }),
});

const runFailedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("run_failed"),
  payload: z.object({
    run_id: uuidSchema,
    failure_type: z.string().min(1),
    failure_message: z.string().min(1),
  }),
});

const runCompletedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("run_completed"),
  payload: z.object({
    run_id: uuidSchema,
    summary: z.string().optional(),
  }),
});

const receiptCorrectedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("receipt_corrected"),
  payload: z.object({
    corrected_receipt_id: uuidSchema,
    reason: z.string().min(1),
  }),
});

const receiptSupersededReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("receipt_superseded"),
  payload: z.object({
    superseded_receipt_id: uuidSchema,
    reason: z.string().min(1),
  }),
});

// Phase 3 -- ELORA's conversational ingestion action. Represents produced
// work output (a direct answer), not execution -- must not be confused with
// run_completed (no Run exists in Phase 3). Written directly by
// src/elora/writeEloraReceipt.ts, independent of transitionWorkOrder()'s own
// gated receipt-writing (which only fires on execution-phase transitions
// Phase 3 never reaches).
const eloraIngestionCompletedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("elora_ingestion_completed"),
  payload: z.object({
    work_order_id: uuidSchema,
    response_summary: z.string().min(1),
    retrieved_memory_ids: z.array(uuidSchema),
  }),
});

// Phase 4 -- covers all four blocked authority branches (escalate,
// setup_required, capability_missing, refuse) uniformly. Reusing
// elora_ingestion_completed would be semantically wrong (nothing was
// completed on a blocked request); four separate new types would be
// unnecessary taxonomy sprawl, since the specific reason is already fully
// captured one join away via the linked AuthorityDecision.outcome
// (action_receipts.authority_decision_id). Written directly by
// src/elora/writeBlockedReceipt.ts, same direct-call pattern as
// writeEloraReceipt.ts.
const eloraRequestBlockedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("elora_request_blocked"),
  payload: z.object({
    work_order_id: uuidSchema,
    response_summary: z.string().min(1),
  }),
});

// Phase 6I -- trigger creation is a direct structured service call
// (src/elora/triggers/createScheduledTrigger.ts), not a WorkOrder round
// trip, so this receipt's payload references the created row directly
// rather than a work_order_id (contrast with artifact_created, which is
// always WorkOrder-shaped). Written only on the authorized (act /
// act_and_report) path -- a blocked authority outcome never creates a
// scheduled_triggers row, so it never reaches this receipt either.
const triggerCreatedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("trigger_created"),
  payload: z.object({
    scheduled_trigger_id: uuidSchema,
    owning_actor_id: z.string().min(1),
    schedule_kind: z.string().min(1),
    outcome: authorityOutcomeSchema,
  }),
});

// Phase 6J -- written whenever the poller finds a trigger due but declines
// to fire it: either the firing-time ownership guard rejected the
// created_by_actor_id/owning_actor_id pair, or the Elora-only restriction
// rejected a non-Elora owner. Nothing is created on this branch (no
// WorkOrder, no AuthorityDecision -- this is a rejection that happens
// before ingestUserMessage() is ever called), so work_order_id and
// authority_decision_id both stay null on the shared base. Keyed by
// (tenant_id, trigger_id, occurrence_timestamp, "trigger_fire_skipped") so
// a trigger that stays stuck/blocked across many poll cycles produces
// exactly one receipt per occurrence, not one per poll cycle.
const triggerFireSkippedReceiptSchema = receiptBaseSchema.extend({
  receipt_type: z.literal("trigger_fire_skipped"),
  payload: z.object({
    scheduled_trigger_id: uuidSchema,
    owning_actor_id: z.string().min(1),
    created_by_actor_id: z.string().min(1),
    reason: z.enum(["ownership_unauthorized", "owner_not_elora"]),
    occurrence_timestamp: z.string().datetime(),
  }),
});

export const actionReceiptSchema = z.discriminatedUnion("receipt_type", [
  workOrderCreatedReceiptSchema,
  authorityDecidedReceiptSchema,
  stateTransitionedReceiptSchema,
  toolInvokedReceiptSchema,
  agentDelegatedReceiptSchema,
  artifactCreatedReceiptSchema,
  memoryCandidateCreatedReceiptSchema,
  runFailedReceiptSchema,
  runCompletedReceiptSchema,
  receiptCorrectedReceiptSchema,
  receiptSupersededReceiptSchema,
  eloraIngestionCompletedReceiptSchema,
  eloraRequestBlockedReceiptSchema,
  triggerCreatedReceiptSchema,
  triggerFireSkippedReceiptSchema,
]);

export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
