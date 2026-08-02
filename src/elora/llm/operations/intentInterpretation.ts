import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import {
  IntentInterpretationInputSchema,
  IntentInterpretationOutputSchema,
  type IntentInterpretationInput,
  type IntentInterpretationOutput,
} from "../types.js";

export { IntentInterpretationInputSchema, IntentInterpretationOutputSchema };
export type { IntentInterpretationInput, IntentInterpretationOutput };

/**
 * PR 2: proves the mechanism only -- no live caller wires this into
 * ingestUserMessage.ts or anywhere else. parseIntent.ts (src/elora/parseIntent.ts)
 * remains the sole, unmodified, deterministic intent parser for every live
 * request; this is a second, still-uncalled path, not a replacement.
 */
export async function runIntentInterpretation(
  input: IntentInterpretationInput,
  options: RunOperationOptions,
): Promise<ModelOperationResult<IntentInterpretationOutput>> {
  const validatedInput = IntentInterpretationInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "intent_interpretation",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    provider: options.provider,
    input: validatedInput,
    outputSchema: IntentInterpretationOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.interpretIntent(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
