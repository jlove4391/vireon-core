import { z } from "zod";
import { uuidSchema } from "../shared/ids.js";

/**
 * PR 5: schema for the embedding lifecycle table (migrations/0016) only --
 * no embedding-generation API is called anywhere in this PR, and no write
 * path exists for this table yet. Real embedding generation, and the
 * pgvector wire-format serialization/deserialization that comes with it,
 * are PR 6/7's job (hybrid retrieval). This schema exists now so that work
 * has a stable, already-reviewed shape to build against.
 *
 * References a specific memory_record_versions row, not memory_records
 * directly: an embedding is derived from one version's content, and if that
 * content is later superseded, an old embedding must not silently appear to
 * describe the record's current state.
 *
 * `embedding` is typed as the logical numeric-vector shape a future caller
 * will actually work with in TypeScript -- not pgvector's raw wire
 * representation (a bracketed string like "[0.1,0.2,...]" as returned by
 * node-postgres without a registered type parser). Marshalling between the
 * two is deferred to whichever PR first writes a real row here.
 */
export const memoryEmbeddingSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  memory_record_version_id: uuidSchema,
  embedding: z.array(z.number()),
  model_provider: z.string().min(1),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
  dimensions: z.number().int().positive(),
  source_content_hash: z.string().min(1),
  status: z.enum(["ACTIVE", "SUPERSEDED"]).default("ACTIVE"),
  superseded_by_embedding_id: uuidSchema.nullable().default(null),
  created_at: z.string().datetime(),
});

export type MemoryEmbedding = z.infer<typeof memoryEmbeddingSchema>;
