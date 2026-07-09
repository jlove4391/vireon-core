import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";
import { authorityOutcomeSchema } from "../shared/runtimeTypes.js";

export const authorityDecisionSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  schema_version: z.number().int().positive().default(1),
  outcome: authorityOutcomeSchema,
  // Required, not defaulted -- ELORA.md 10.2: this flag must be deliberately
  // set by deterministic CORE code, never silently defaulted or inferred
  // from raw model output.
  requires_human_gatekeeper: z.boolean(),
  reason: z.string().nullable().default(null),
  risk_level: z.string().nullable().default(null),
  deciding_actor_id: uuidSchema.nullable().default(null),
  work_order_id: uuidSchema.nullable().default(null),
  run_id: uuidSchema.nullable().default(null),
  tool_invocation_id: uuidSchema.nullable().default(null),
  required_setup: z.string().nullable().default(null),
  created_at: z.string().datetime(),
});

export type AuthorityDecision = z.infer<typeof authorityDecisionSchema>;
