import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import { CritiqueInputSchema, CritiqueOutputSchema, type CritiqueInput, type CritiqueOutput } from "../types.js";

export { CritiqueInputSchema, CritiqueOutputSchema };
export type { CritiqueInput, CritiqueOutput };

/**
 * PR 2: proves the mechanism only -- no live caller. No fallback: a
 * malformed critique must never be silently replaced with a fabricated
 * verdict.
 */
export async function runCritique(
  input: CritiqueInput,
  options: RunOperationOptions,
): Promise<ModelOperationResult<CritiqueOutput>> {
  const validatedInput = CritiqueInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "critique",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input: validatedInput,
    outputSchema: CritiqueOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.critique(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
