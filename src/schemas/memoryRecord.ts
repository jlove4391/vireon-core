import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

// Phase 6G: the first Zod schema for memory_records -- no code path has
// ever created one of these rows before promoteMemoryCandidate(). PR 5
// dropped the legacy bare `embedding` column (migrations/0016) -- it was
// never populated by any code path -- in favor of the separate
// memory_embeddings table (memoryEmbedding.ts), since an embedding has its
// own lifecycle independent of the content it's derived from.
//
// current_version_id is nullable at the schema level, not because a real
// promoted record can legitimately lack one (promoteMemoryCandidate.ts
// always sets it atomically with the first version row), but because
// pre-PR-5 test fixtures and other direct-SQL seed helpers across this
// codebase insert memory_records rows without ever creating a version row
// at all -- those rows are real, are not going through the versioning path,
// and must not be rejected by this schema.
export const memoryRecordSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  source_candidate_id: uuidSchema.nullable().default(null),
  content: z.string().min(1),
  record_type: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  current_version_id: uuidSchema.nullable().default(null),
  deleted_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
