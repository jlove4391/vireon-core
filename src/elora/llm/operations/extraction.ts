import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import { ExtractionInputSchema, ExtractionOutputSchema, type ExtractionInput, type ExtractionOutput } from "../types.js";

export { ExtractionInputSchema, ExtractionOutputSchema };
export type { ExtractionInput, ExtractionOutput };

/**
 * PR 2: proves the mechanism only -- no live caller. No fallback: a
 * malformed extraction result must never be replaced with guessed values
 * -- that would be exactly the "fake capability" this project avoids
 * everywhere else, just relocated into a new subsystem.
 */
export async function runExtraction(
  input: ExtractionInput,
  options: RunOperationOptions,
): Promise<ModelOperationResult<ExtractionOutput>> {
  const validatedInput = ExtractionInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "extraction",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input: validatedInput,
    outputSchema: ExtractionOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.extract(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
