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
 * PR 2 / ADR 0008 Realignment A: the schema now targets the route
 * taxonomy (src/elora/types.ts's ELORA_ROUTES) instead of the retired
 * ELORA_INTENT_TYPES/ELORA_TASK_TYPES vocabulary. Still no live caller in
 * this PR -- resolveEloraRoute.ts (the model-proposes/code-decides routing
 * policy, ingestUserMessage.ts's future caller) is a separate, later slice.
 * parseIntent.ts is repurposed in this same PR into the degraded-mode
 * fallback classifier (ADR 0008 §3), used only when this operation is
 * unavailable or fails -- not the primary classifier it used to be.
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
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input: validatedInput,
    outputSchema: IntentInterpretationOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.interpretIntent(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
