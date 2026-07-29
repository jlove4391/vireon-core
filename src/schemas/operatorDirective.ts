import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const DIRECTIVE_TYPES = ["decision", "focus", "action", "blocker", "watch"] as const;
export const directiveTypeSchema = z.enum(DIRECTIVE_TYPES);
export type DirectiveType = z.infer<typeof directiveTypeSchema>;

export const DIRECTIVE_STATES = [
  "PROPOSED",
  "OPEN",
  "IN_PROGRESS",
  "DEFERRED",
  "COMPLETED",
  "DISMISSED",
  "EXPIRED",
  "SUPERSEDED",
] as const;
export const directiveStateSchema = z.enum(DIRECTIVE_STATES);
export type DirectiveState = z.infer<typeof directiveStateSchema>;

export const operatorDirectiveSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  directive_type: directiveTypeSchema,
  state: directiveStateSchema,
  dedupe_key: z.string().min(1),
  cycle_number: z.number().int().nullable().default(null),
  issuing_actor_id: uuidSchema,
  owning_actor_id: uuidSchema,
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  accepted_at: z.string().datetime().nullable().default(null),
  started_at: z.string().datetime().nullable().default(null),
  completed_at: z.string().datetime().nullable().default(null),
  deferred_at: z.string().datetime().nullable().default(null),
  dismissed_at: z.string().datetime().nullable().default(null),
  expires_at: z.string().datetime().nullable().default(null),
  due_at: z.string().datetime().nullable().default(null),
  window_start_at: z.string().datetime().nullable().default(null),
  window_end_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type OperatorDirective = z.infer<typeof operatorDirectiveSchema>;

export const operatorDirectiveRevisionSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  directive_id: uuidSchema,
  revision_number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().nullable().default(null),
  why_now: z.string().nullable().default(null),
  priority: z.string().nullable().default(null),
  proposed_owner_actor_id: uuidSchema.nullable().default(null),
  due_at: z.string().datetime().nullable().default(null),
  window_start_at: z.string().datetime().nullable().default(null),
  window_end_at: z.string().datetime().nullable().default(null),
  expires_at: z.string().datetime().nullable().default(null),
  content_hash: z.string().min(1),
  change_reason: z.string().nullable().default(null),
  created_by_actor_id: uuidSchema,
  created_at: z.string().datetime(),
});
export type OperatorDirectiveRevision = z.infer<typeof operatorDirectiveRevisionSchema>;

export const operatorDirectiveTransitionSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  directive_id: uuidSchema,
  from_state: directiveStateSchema.nullable(),
  to_state: directiveStateSchema,
  actor_id: uuidSchema.nullable().default(null),
  transition_type: z.string().min(1).default("state_change"),
  reason: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
});
export type OperatorDirectiveTransition = z.infer<typeof operatorDirectiveTransitionSchema>;

export const operatorDirectiveProvenanceSchema = z
  .object({
    id: uuidSchema,
    tenant_id: uuidSchema,
    directive_id: uuidSchema,
    message_id: uuidSchema.nullable().default(null),
    work_order_id: uuidSchema.nullable().default(null),
    run_id: uuidSchema.nullable().default(null),
    authority_decision_id: uuidSchema.nullable().default(null),
    tool_invocation_id: uuidSchema.nullable().default(null),
    action_receipt_id: uuidSchema.nullable().default(null),
    artifact_id: uuidSchema.nullable().default(null),
    memory_candidate_id: uuidSchema.nullable().default(null),
    memory_record_id: uuidSchema.nullable().default(null),
    provider: z.string().nullable().default(null),
    external_identifier: z.string().nullable().default(null),
    external_locator: z.string().nullable().default(null),
    label: z.string().nullable().default(null),
    observed_at: z.string().datetime().nullable().default(null),
    content_hash: z.string().nullable().default(null),
    metadata: z.record(z.unknown()).default({}),
    created_at: z.string().datetime(),
  })
  .refine(
    (row) => {
      const internalCount = [
        row.message_id,
        row.work_order_id,
        row.run_id,
        row.authority_decision_id,
        row.tool_invocation_id,
        row.action_receipt_id,
        row.artifact_id,
        row.memory_candidate_id,
        row.memory_record_id,
      ].filter((v) => v !== null).length;
      const externalSet = row.provider !== null;
      return internalCount + (externalSet ? 1 : 0) === 1;
    },
    { message: "operator_directive_provenance must have exactly one source form (one internal reference, or the external provider form)" },
  );
export type OperatorDirectiveProvenance = z.infer<typeof operatorDirectiveProvenanceSchema>;

export const operatorDirectiveSuppressionSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  dedupe_key: z.string().min(1),
  reason: z.string().min(1),
  suppressed_by_actor_id: uuidSchema,
  suppressed_until: z.string().datetime(),
  created_at: z.string().datetime(),
});
export type OperatorDirectiveSuppression = z.infer<typeof operatorDirectiveSuppressionSchema>;
