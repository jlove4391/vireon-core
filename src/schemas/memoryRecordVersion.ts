import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

/**
 * PR 5: the companion versions table for memory_records (migrations/0016),
 * the same "identity row + versions/transitions companion table" pattern
 * already proven by work_order_state_transitions, operator_directive_revisions,
 * and cognitive_run_transitions. A memory record's identity is durable;
 * supersession creates a new version under the same memory_record_id rather
 * than a new record (the directive-revision pattern, not the
 * receipt-supersession pattern).
 *
 * `content` stays required (non-nullable, matching the column's own NOT
 * NULL) even on a deletion-marker row -- deletion clears it to a tombstone
 * marker string rather than storing NULL, so the fact that a deletion
 * happened stays honestly recorded without exposing what was deleted.
 */
export const memoryRecordVersionSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  memory_record_id: uuidSchema,
  version_number: z.number().int().positive(),
  content: z.string(),
  change_reason: z.string().min(1),
  is_deletion_marker: z.boolean().default(false),
  created_at: z.string().datetime(),
});

export type MemoryRecordVersion = z.infer<typeof memoryRecordVersionSchema>;
