import { z, type ZodSchema } from "zod";
import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import { RerankingInputSchema, RerankingOutputSchema, type RerankingInput, type RerankingOutput } from "../types.js";

export { RerankingInputSchema, RerankingOutputSchema };
export type { RerankingInput, RerankingOutput };

/**
 * Deliberately retrieval-agnostic contract (locked decision): no vector
 * similarity scores, no database identifiers beyond the opaque `id` the
 * caller provided, no embedding-model metadata, no memory-tier
 * assumptions. Those decisions belong to PR 6 (hybrid retrieval).
 *
 * Builds an input-aware output schema: rankedCandidates must reference
 * only candidate ids actually supplied in this call's input, with no
 * duplicates. That validation genuinely depends on the specific input, so
 * it can't live in a static schema the way the other five operations'
 * output schemas do -- this is exactly what
 * ExecuteModelOperationConfig.outputSchema's function form exists for.
 */
export function buildRerankingOutputSchema(input: RerankingInput): ZodSchema<RerankingOutput> {
  const validIds = new Set(input.candidates.map((candidate) => candidate.id));

  return RerankingOutputSchema.superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [index, ranked] of data.rankedCandidates.entries()) {
      if (!validIds.has(ranked.candidateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rankedCandidates[${index}].candidateId "${ranked.candidateId}" is not one of the candidate ids supplied in this call's input`,
          path: ["rankedCandidates", index, "candidateId"],
        });
      }
      if (seen.has(ranked.candidateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rankedCandidates[${index}].candidateId "${ranked.candidateId}" is a duplicate`,
          path: ["rankedCandidates", index, "candidateId"],
        });
      }
      seen.add(ranked.candidateId);
    }
  });
}

/**
 * PR 2: proves the mechanism only -- no live caller. No fallback: a
 * malformed ranking must never be replaced with a fabricated order.
 */
export async function runReranking(
  input: RerankingInput,
  options: RunOperationOptions,
): Promise<ModelOperationResult<RerankingOutput>> {
  const validatedInput = RerankingInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "reranking",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input: validatedInput,
    outputSchema: buildRerankingOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.rerank(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
