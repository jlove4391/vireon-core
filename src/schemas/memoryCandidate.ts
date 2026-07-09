import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";
import { memoryCandidateReviewStatusSchema } from "../shared/runtimeTypes.js";

export const memoryCandidateSchema = z
  .object({
    id: uuidSchema,
    tenant_id: uuidSchema,
    source_message_id: uuidSchema.nullable().default(null),
    source_receipt_id: uuidSchema.nullable().default(null),
    source_work_order_id: uuidSchema.nullable().default(null),
    candidate_content: z.string().min(1),
    candidate_type: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
    scope: z.string().nullable().default(null),
    review_status: memoryCandidateReviewStatusSchema.default("proposed"),
    reason_for_creation: z.string().nullable().default(null),
    promoted_memory_record_id: uuidSchema.nullable().default(null),
    created_at: z.string().datetime(),
  })
  .refine(
    (candidate) =>
      candidate.source_message_id !== null ||
      candidate.source_receipt_id !== null ||
      candidate.source_work_order_id !== null,
    { message: "memory candidate must reference a source message, receipt, or work order" },
  );

export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
