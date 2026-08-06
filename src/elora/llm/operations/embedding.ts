import { z, type ZodSchema } from "zod";
import type { EmbeddingProvider } from "../embeddingProvider.js";
import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ContentPolicyConfig,
  type ModelOperationResult,
} from "../executeModelOperation.js";
import { EmbeddingInputSchema, EmbeddingOutputSchema, type EmbeddingInput, type EmbeddingOutput } from "../types.js";

export { EmbeddingInputSchema, EmbeddingOutputSchema };
export type { EmbeddingInput, EmbeddingOutput };

/**
 * Shaped like the existing six operations' RunOperationOptions, but keyed
 * to EmbeddingProvider instead of LlmProvider -- a separate interface, not
 * a widened RunOperationOptions, so the six existing operation files (and
 * every test that types against RunOperationOptions/LlmProvider) need zero
 * changes.
 */
export interface RunEmbeddingOptions {
  tenantId: string;
  /**
   * PR 6 §7.4: query embedding happens during memory retrieval, before PR
   * 4's coordinator creates the informational cognitive run -- null is the
   * honest value on that path, not a placeholder. Never create a fake
   * cognitive run solely to populate this field.
   */
  cognitiveRunId?: string | null;
  provider: EmbeddingProvider;
  invocationKey: string;
  attemptNumber?: number;
  timeoutMs?: number;
  contentPolicy?: ContentPolicyConfig;
}

/**
 * Builds an input-aware output schema: embedding.length and
 * output.dimensions must both equal the requested input.dimensions. This
 * genuinely depends on the specific input, so it can't live in a static
 * schema -- the same reasoning reranking.ts's buildRerankingOutputSchema
 * already established for this executor's function-of-input outputSchema
 * form (ExecuteModelOperationConfig.outputSchema).
 */
export function buildEmbeddingOutputSchema(input: EmbeddingInput): ZodSchema<EmbeddingOutput> {
  return EmbeddingOutputSchema.superRefine((data, ctx) => {
    if (data.embedding.length !== input.dimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `embedding has ${data.embedding.length} dimensions, expected ${input.dimensions}`,
        path: ["embedding"],
      });
    }
    if (data.dimensions !== input.dimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `output.dimensions is ${data.dimensions}, expected ${input.dimensions}`,
        path: ["dimensions"],
      });
    }
  });
}

/**
 * PR 6's seventh model operation. Unlike response_synthesis, embedding has
 * no deterministic vector fallback -- a failed provider call remains an
 * honest failed model invocation, never silently replaced with a
 * fabricated vector. Callers needing degraded behavior (retrieveHybridMemory.ts
 * falling back to FTS-only) implement that at their own layer by inspecting
 * this function's ordinary { ok: false } result, not by this function
 * pretending to succeed.
 */
export async function runEmbedding(
  input: EmbeddingInput,
  options: RunEmbeddingOptions,
): Promise<ModelOperationResult<EmbeddingOutput>> {
  const validatedInput = EmbeddingInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "embedding",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input: validatedInput,
    outputSchema: buildEmbeddingOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.embed(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
