import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

// Phase 6G: the first Zod schema for memory_records -- no code path has
// ever created one of these rows before promoteMemoryCandidate().
// `embedding` is intentionally absent: pgvector-ready, but the embedding
// pipeline/vector search remains deferred (core-runtime.md 6.4/9.5), same
// as it's been since Phase 1.
export const memoryRecordSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  source_candidate_id: uuidSchema.nullable().default(null),
  content: z.string().min(1),
  record_type: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  created_at: z.string().datetime(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
