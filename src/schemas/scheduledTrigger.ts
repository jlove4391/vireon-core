import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

export const scheduledTriggerStatusSchema = z.enum(["active", "paused", "revoked"]);
export type ScheduledTriggerStatus = z.infer<typeof scheduledTriggerStatusSchema>;

export const scheduleKindSchema = z.enum(["cron", "interval", "one_off"]);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

export const scheduledTriggerSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  workspace_id: uuidSchema.nullable().default(null),
  project_id: uuidSchema.nullable().default(null),
  owning_actor_id: uuidSchema,
  created_by_actor_id: uuidSchema,
  authority_decision_id: uuidSchema,
  status: scheduledTriggerStatusSchema.default("active"),
  schedule_kind: scheduleKindSchema,
  schedule_expression: z.string().min(1),
  timezone: z.string().nullable().default(null),
  synthetic_message_content: z.string().min(1),
  trigger_category: z.string().nullable().default(null),
  next_fire_at: z.string().datetime().nullable().default(null),
  last_fired_at: z.string().datetime().nullable().default(null),
  last_fired_work_order_id: uuidSchema.nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ScheduledTrigger = z.infer<typeof scheduledTriggerSchema>;
