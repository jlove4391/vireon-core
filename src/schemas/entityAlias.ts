import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const entityAliasSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  entity_id: uuidSchema,
  alias: z.string().min(1),
  created_at: z.string().datetime(),
});

export type EntityAlias = z.infer<typeof entityAliasSchema>;
