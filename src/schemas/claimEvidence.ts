import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const CLAIM_EVIDENCE_SOURCE_KINDS = [
  "message",
  "work_order",
  "authority_decision",
  "action_receipt",
  "directive",
  "briefing_issue",
  "trigger",
  "memory_record",
] as const;

export type ClaimEvidenceSourceKind = (typeof CLAIM_EVIDENCE_SOURCE_KINDS)[number];

export const claimEvidenceSourceKindSchema = z.enum(CLAIM_EVIDENCE_SOURCE_KINDS);

/** Matches the `claim_evidence` table exactly (migrations/0018) -- one typed FK per source kind, all others null. */
export const claimEvidenceSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  claim_id: uuidSchema,
  source_kind: claimEvidenceSourceKindSchema,
  message_id: uuidSchema.nullable().default(null),
  work_order_id: uuidSchema.nullable().default(null),
  authority_decision_id: uuidSchema.nullable().default(null),
  action_receipt_id: uuidSchema.nullable().default(null),
  directive_id: uuidSchema.nullable().default(null),
  briefing_issue_id: uuidSchema.nullable().default(null),
  trigger_id: uuidSchema.nullable().default(null),
  memory_record_id: uuidSchema.nullable().default(null),
  created_at: z.string().datetime(),
});

export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;
