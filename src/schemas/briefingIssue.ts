import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

// Schema-complete (matches migrations/0012's CHECK), service-incomplete --
// issueBriefing() only ever produces ISSUED. See the migration's own doc
// comment for why UPDATED/CLOSED/FAILED are not reachable in this phase.
export const BRIEFING_ISSUE_STATUSES = ["ASSEMBLING", "ISSUED", "UPDATED", "CLOSED", "FAILED"] as const;
export const briefingIssueStatusSchema = z.enum(BRIEFING_ISSUE_STATUSES);
export type BriefingIssueStatus = z.infer<typeof briefingIssueStatusSchema>;

// lane taxonomy: five map 1:1 onto DIRECTIVE_TYPES (decision/focus/action/
// blocker/watch); 'completed' and 'evidence' are this phase's own addition
// for the non-Directive candidate sources (WorkOrders/ActionReceipts land
// in 'completed', MemoryCandidates in 'evidence') -- see
// collectCandidates.ts's own doc comment for the full lane-mapping
// rationale, since the transcribed spec names prose sections, not a lane
// enum.
export const BRIEFING_ENTRY_LANES = ["decision", "focus", "action", "blocker", "watch", "completed", "evidence"] as const;
export const briefingEntryLaneSchema = z.enum(BRIEFING_ENTRY_LANES);
export type BriefingEntryLane = z.infer<typeof briefingEntryLaneSchema>;

export const BRIEFING_ENTRY_STATUSES = ["active", "removed"] as const;
export const briefingEntryStatusSchema = z.enum(BRIEFING_ENTRY_STATUSES);
export type BriefingEntryStatus = z.infer<typeof briefingEntryStatusSchema>;

export const briefingIssueSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  briefing_type: z.string().min(1),
  local_issue_date: z.string().min(1), // YYYY-MM-DD (Postgres `date`, returned as a string)
  timezone: z.string().min(1),
  status: briefingIssueStatusSchema,
  issued_by_actor_id: uuidSchema,
  source_message_id: uuidSchema.nullable().default(null),
  source_work_order_id: uuidSchema.nullable().default(null),
  first_move_directive_id: uuidSchema.nullable().default(null),
  prose_artifact_id: uuidSchema.nullable().default(null),
  idempotency_key: z.string().min(1),
  generated_at: z.string().datetime().nullable().default(null),
  published_at: z.string().datetime().nullable().default(null),
  closed_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
});
export type BriefingIssue = z.infer<typeof briefingIssueSchema>;

export const briefingIssueEntrySchema = z
  .object({
    id: uuidSchema,
    tenant_id: uuidSchema,
    briefing_issue_id: uuidSchema,
    directive_id: uuidSchema.nullable().default(null),
    directive_revision_id: uuidSchema.nullable().default(null),
    work_order_id: uuidSchema.nullable().default(null),
    action_receipt_id: uuidSchema.nullable().default(null),
    memory_candidate_id: uuidSchema.nullable().default(null),
    lane: briefingEntryLaneSchema,
    rank: z.number().int().positive(),
    entry_status: briefingEntryStatusSchema,
    new_to_issue: z.boolean(),
    carried_from_issue_id: uuidSchema.nullable().default(null),
    age_days_snapshot: z.number().int().nullable().default(null),
    carry_count_snapshot: z.number().int().nullable().default(null),
    defer_count_snapshot: z.number().int().nullable().default(null),
    escalation_level_snapshot: z.number().int().nullable().default(null),
    inclusion_reason: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .refine(
    (row) => {
      const sourceCount = [row.directive_id, row.work_order_id, row.action_receipt_id, row.memory_candidate_id].filter(
        (v) => v !== null,
      ).length;
      return sourceCount === 1;
    },
    { message: "briefing_issue_entries must have exactly one candidate-source reference" },
  );
export type BriefingIssueEntry = z.infer<typeof briefingIssueEntrySchema>;
