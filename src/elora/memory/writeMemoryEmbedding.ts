import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryEmbeddingSchema, type MemoryEmbedding } from "../../schemas/memoryEmbedding.js";
import { MemoryRecordAlreadyDeletedError, MemoryRecordVersionIsDeletionMarkerError, MemoryRecordVersionNotFoundError } from "./errors.js";
import { parseVector, serializeVector } from "./vectorSerialization.js";

export interface WriteMemoryEmbeddingInput {
  tenantId: string;
  memoryRecordVersionId: string;
  embedding: number[];
  modelProvider: string;
  modelName: string;
  modelVersion: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * PR 6 §10: writes a new ACTIVE embedding for a memory_record_versions row
 * and atomically supersedes whatever was previously ACTIVE for that same
 * version -- never an in-place overwrite. `status`, `supersededByEmbeddingId`,
 * `dimensions`, and `sourceContentHash` are deliberately not accepted as
 * input: all four are computed internally from the locked version row and
 * the embedding itself, so a caller cannot lie about what was actually
 * embedded or manufacture a fake supersession chain.
 *
 * Concurrency (§10.3): the version row is locked FOR UPDATE before anything
 * else. Two concurrent calls for the same memoryRecordVersionId serialize on
 * that lock -- the second call only proceeds once the first has committed,
 * at which point it correctly supersedes the first call's newly-active row.
 * Exactly one ACTIVE row survives regardless of call ordering.
 */
async function runWriteMemoryEmbedding(
  input: WriteMemoryEmbeddingInput,
  options: { injectFailureAfterInsertBeforeSupersede: boolean },
): Promise<MemoryEmbedding> {
  // Validates non-empty/finite and produces the pgvector wire text up
  // front -- fails before ever opening a transaction if the vector itself
  // is malformed.
  const serializedVector = serializeVector(input.embedding);

  return withTenantTransaction(input.tenantId, async (client) => {
    const versionResult = await client.query(
      `SELECT mrv.id, mrv.content, mrv.is_deletion_marker, mr.deleted_at
       FROM memory_record_versions mrv
       JOIN memory_records mr ON mr.id = mrv.memory_record_id AND mr.tenant_id = mrv.tenant_id
       WHERE mrv.id = $1 AND mrv.tenant_id = $2
       FOR UPDATE OF mrv`,
      [input.memoryRecordVersionId, input.tenantId],
    );
    const versionRow = versionResult.rows[0] as Record<string, unknown> | undefined;
    if (!versionRow) {
      throw new MemoryRecordVersionNotFoundError(input.memoryRecordVersionId);
    }
    // is_deletion_marker is checked before deleted_at (not merely in
    // some arbitrary order): a deletion-marker version's parent is
    // *always* deleted too (deleteMemoryRecord.ts sets both atomically),
    // so checking deleted_at first would make this specific error
    // permanently unreachable for the one row it's meant to describe.
    // With this order, the marker row gets the precise
    // IsDeletionMarkerError, and every *other* version of a deleted
    // record (already-scrubbed but non-marker rows) still gets
    // AlreadyDeletedError -- both branches independently reachable.
    if (versionRow.is_deletion_marker) {
      throw new MemoryRecordVersionIsDeletionMarkerError(input.memoryRecordVersionId);
    }
    if (versionRow.deleted_at) {
      throw new MemoryRecordAlreadyDeletedError(input.memoryRecordVersionId);
    }

    const dimensions = input.embedding.length;
    const sourceContentHash = createHash("sha256").update(versionRow.content as string).digest("hex");
    const newEmbeddingId = randomUUID();
    const now = new Date().toISOString();

    // Insert the new row first -- the old rows' superseded_by_embedding_id
    // FK reference below requires this row to already exist.
    await client.query(
      `INSERT INTO memory_embeddings
         (id, tenant_id, memory_record_version_id, embedding, model_provider, model_name, model_version,
          dimensions, source_content_hash, status, created_at)
       VALUES ($1,$2,$3,$4::vector,$5,$6,$7,$8,$9,'ACTIVE',$10)`,
      [
        newEmbeddingId,
        input.tenantId,
        input.memoryRecordVersionId,
        serializedVector,
        input.modelProvider,
        input.modelName,
        input.modelVersion,
        dimensions,
        sourceContentHash,
        now,
      ],
    );

    if (options.injectFailureAfterInsertBeforeSupersede) {
      throw new Error("writeMemoryEmbedding: test-only failure injection after insert, before supersede");
    }

    // `id <> $1` excludes the row just inserted above -- without it, this
    // UPDATE's own WHERE status = 'ACTIVE' would immediately supersede the
    // brand new row against itself.
    await client.query(
      `UPDATE memory_embeddings
       SET status = 'SUPERSEDED', superseded_by_embedding_id = $1
       WHERE tenant_id = $2 AND memory_record_version_id = $3 AND status = 'ACTIVE' AND id <> $1`,
      [newEmbeddingId, input.tenantId, input.memoryRecordVersionId],
    );

    const inserted = await client.query(
      "SELECT * FROM memory_embeddings WHERE id = $1 AND tenant_id = $2",
      [newEmbeddingId, input.tenantId],
    );
    const row = inserted.rows[0] as Record<string, unknown>;

    return memoryEmbeddingSchema.parse({
      id: row.id,
      tenant_id: row.tenant_id,
      memory_record_version_id: row.memory_record_version_id,
      embedding: parseVector(row.embedding),
      model_provider: row.model_provider,
      model_name: row.model_name,
      model_version: row.model_version,
      dimensions: row.dimensions,
      source_content_hash: row.source_content_hash,
      status: row.status,
      superseded_by_embedding_id: row.superseded_by_embedding_id,
      created_at: toIso(row.created_at as string | Date),
    });
  });
}

/** Production entry point. Never accepts failure-injection input. */
export async function writeMemoryEmbedding(input: WriteMemoryEmbeddingInput): Promise<MemoryEmbedding> {
  return runWriteMemoryEmbedding(input, { injectFailureAfterInsertBeforeSupersede: false });
}

/**
 * PR 6 §28: test-only atomicity seam, mirroring
 * transitionCognitiveRunForTest's exact pattern -- forces a rollback after
 * the new ACTIVE row is inserted but before the prior ACTIVE row(s) are
 * superseded, to prove no partial state (two ACTIVE rows, or an orphaned
 * new row with nothing superseded) survives a mid-write failure. Rejected
 * outside test context so this is not a reachable production code path.
 */
export async function writeMemoryEmbeddingForTest(input: WriteMemoryEmbeddingInput): Promise<MemoryEmbedding> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("writeMemoryEmbeddingForTest may only be called with NODE_ENV=test");
  }
  return runWriteMemoryEmbedding(input, { injectFailureAfterInsertBeforeSupersede: true });
}
