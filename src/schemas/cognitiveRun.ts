import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";
import { CognitiveRunStatusSchema } from "../cognition/cognitiveRunState.js";

// Open semantic vocabulary, closed lexical format -- the full taxonomy of
// cognitive operation kinds isn't known until later cognitive-plane PRs
// land. Mirrors migrations/0013_cognitive_run_contract.sql's
// chk_cognitive_runs_objective_kind_format CHECK constraint exactly.
export const CognitiveObjectiveKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const cognitiveRunSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  thread_id: uuidSchema.nullable().default(null),
  message_id: uuidSchema.nullable().default(null),
  initiated_by_actor_id: uuidSchema.nullable().default(null),
  objective_kind: CognitiveObjectiveKindSchema,
  status: CognitiveRunStatusSchema.default("PENDING"),
  idempotency_key: z.string().min(1),
  started_at: z.string().datetime().nullable().default(null),
  ended_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type CognitiveRun = z.infer<typeof cognitiveRunSchema>;
