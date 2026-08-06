import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import type { EmbeddingProvider } from "../llm/embeddingProvider.js";
import { createConfiguredEmbeddingProvider } from "../llm/embeddingProvider.js";
import type { ModelOperationErrorKind } from "../llm/errors.js";
import { runEmbedding } from "../llm/operations/embedding.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import { MemoryRecordAlreadyDeletedError, MemoryRecordVersionIsDeletionMarkerError, MemoryRecordVersionNotFoundError } from "./errors.js";
import { writeMemoryEmbedding } from "./writeMemoryEmbedding.js";

export interface EmbedMemoryRecordVersionInput {
  tenantId: string;
  memoryRecordVersionId: string;
  /** Test seam -- defaults to createConfiguredEmbeddingProvider() (real OpenAI, requires OPENAI_API_KEY). */
  provider?: EmbeddingProvider;
  /** A deliberate re-embed with the same logical configuration uses a higher attempt number, creating a new physical invocation row rather than colliding with the prior one. Defaults to 1. */
  attemptNumber?: number;
  timeoutMs?: number;
}

export type EmbedMemoryRecordVersionResult =
  | {
      ok: true;
      modelInvocationId: string;
      memoryEmbeddingId: string;
      memoryRecordVersionId: string;
      dimensions: number;
      modelProvider: string;
      modelName: string;
      modelVersion: string;
    }
  | {
      ok: false;
      modelInvocationId: string | null;
      error: { kind: ModelOperationErrorKind; retryable: boolean };
    };

/** Reject conditions checked up front, before ever spending a provider call on content we'd refuse to persist an embedding for anyway. */
async function loadEligibleVersionContent(tenantId: string, memoryRecordVersionId: string): Promise<string> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      `SELECT mrv.content, mrv.is_deletion_marker, mr.deleted_at
       FROM memory_record_versions mrv
       JOIN memory_records mr ON mr.id = mrv.memory_record_id AND mr.tenant_id = mrv.tenant_id
       WHERE mrv.id = $1 AND mrv.tenant_id = $2`,
      [memoryRecordVersionId, tenantId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new MemoryRecordVersionNotFoundError(memoryRecordVersionId);
    }
    // Ordering matches writeMemoryEmbedding.ts's own reasoning: a
    // deletion-marker row's parent is always deleted too, so checking
    // is_deletion_marker first keeps both errors independently reachable.
    if (row.is_deletion_marker) {
      throw new MemoryRecordVersionIsDeletionMarkerError(memoryRecordVersionId);
    }
    if (row.deleted_at) {
      throw new MemoryRecordAlreadyDeletedError(memoryRecordVersionId);
    }
    return row.content as string;
  });
}

/**
 * PR 6 §11: the explicit coordinator connecting the seventh model operation
 * (runEmbedding) to durable storage (writeMemoryEmbedding). Deliberately
 * not wired into candidate promotion or memory supersession automatically
 * -- no OpenAI request belongs inside either of those database transactions,
 * and automatic queueing/backfill is out of scope for this PR (§11.3). A
 * memory version with no embedding remains fully eligible for FTS
 * retrieval; this coordinator is called explicitly, on demand.
 */
export async function embedMemoryRecordVersion(
  input: EmbedMemoryRecordVersionInput,
): Promise<EmbedMemoryRecordVersionResult> {
  const content = await loadEligibleVersionContent(input.tenantId, input.memoryRecordVersionId);

  const provider = input.provider ?? createConfiguredEmbeddingProvider();
  const attemptNumber = input.attemptNumber ?? 1;

  // Stable across a deliberate re-embed with the identical logical
  // configuration (same version, same provider/model/dimensions) --
  // attemptNumber is the caller's explicit signal that this is a genuinely
  // new physical attempt, not a retried duplicate of the same one.
  const invocationKey = buildIdempotencyKey([
    input.tenantId,
    input.memoryRecordVersionId,
    "embedding",
    provider.providerId,
    provider.modelId,
    String(provider.dimensions),
  ]);

  const result = await runEmbedding(
    { text: content, purpose: "memory_document", dimensions: provider.dimensions },
    {
      tenantId: input.tenantId,
      // §7.4/§11: no cognitive run exists for a standalone embed call --
      // null is the honest value, not a placeholder.
      cognitiveRunId: null,
      provider,
      invocationKey,
      attemptNumber,
      timeoutMs: input.timeoutMs,
    },
  );

  if (!result.ok) {
    // No embedding row is written on failure -- the failed model invocation
    // itself is the honest, complete record of the attempt.
    return { ok: false, modelInvocationId: result.invocationId ?? null, error: result.error };
  }

  const written = await writeMemoryEmbedding({
    tenantId: input.tenantId,
    memoryRecordVersionId: input.memoryRecordVersionId,
    embedding: result.value.embedding,
    modelProvider: provider.providerId,
    modelName: provider.modelId,
    // The resolved model the provider actually reports back, not merely
    // what was requested -- same provider-correlation discipline PR 3
    // established for chat operations.
    modelVersion: result.value.model,
  });

  return {
    ok: true,
    modelInvocationId: result.invocationId,
    memoryEmbeddingId: written.id,
    memoryRecordVersionId: input.memoryRecordVersionId,
    dimensions: written.dimensions,
    modelProvider: written.model_provider,
    modelName: written.model_name,
    modelVersion: written.model_version,
  };
}
