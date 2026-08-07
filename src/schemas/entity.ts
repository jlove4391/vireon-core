import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

// PR 8: deliberately no closed entity_type vocabulary -- no stable canonical
// entity taxonomy exists yet, so entity_type stays free text at both the DB
// (migrations/0018) and schema layer, same posture claims.ts takes for
// `sensitivity`.
export const entitySchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  entity_type: z.string().min(1),
  canonical_name: z.string().min(1),
  created_at: z.string().datetime(),
});

export type Entity = z.infer<typeof entitySchema>;
