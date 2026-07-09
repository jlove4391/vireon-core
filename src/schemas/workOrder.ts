import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const workOrderSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  workspace_id: uuidSchema.nullable().default(null),
  project_id: uuidSchema.nullable().default(null),
  thread_id: uuidSchema.nullable().default(null),
  message_id: uuidSchema.nullable().default(null),
  owner_actor_id: uuidSchema.nullable().default(null),
  task_type: z.string().min(1),
  interpreted_intent: z.string().nullable().default(null),
  status: z.string().min(1).default("pending"),
  idempotency_key: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type WorkOrder = z.infer<typeof workOrderSchema>;
