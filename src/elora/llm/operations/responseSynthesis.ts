import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import { ResponseSynthesisOutputSchema, type LlmResponseContext, type ResponseSynthesisOutput } from "../types.js";

export { ResponseSynthesisOutputSchema };
export type { ResponseSynthesisOutput };

export interface RunResponseSynthesisOptions extends RunOperationOptions {
  /**
   * The only operation with a legitimate production fallback (locked
   * decision). Callers pass in the same deterministic template text
   * generateEloraResponse.ts's own callers already compute today
   * (produceDirectAnswer.ts / synthesizeIngestionResponse.ts / etc.) --
   * this does not duplicate that logic, only reuses its output.
   */
  deterministicFallback: string;
}

/**
 * Adapts, rather than replaces, the existing Phase 6F generateResponse
 * path (src/elora/llm/anthropicProvider.ts, src/elora/generateEloraResponse.ts)
 * -- this is NOT what ingestUserMessage.ts calls. It exists so response
 * synthesis also gets model_invocations evidence and an OTel span through
 * the same shared executor every other operation goes through, proving
 * the mechanism without redirecting the live pipeline (locked decision).
 * generateEloraResponse.ts itself is unmodified and remains the sole live
 * caller of provider.generateResponse().
 */
export async function runResponseSynthesis(
  input: LlmResponseContext,
  options: RunResponseSynthesisOptions,
): Promise<ModelOperationResult<ResponseSynthesisOutput>> {
  const result = await executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "response_synthesis",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    contentPolicy: options.contentPolicy,
    provider: options.provider,
    input,
    outputSchema: ResponseSynthesisOutputSchema,
    callProvider: async (provider, providerInput, timeoutMs) => ({
      output: { responseText: await provider.generateResponse(providerInput, timeoutMs) },
      // generateResponse itself is unmodified and reports no usage --
      // see LlmProvider's own doc comment in types.ts. A documented
      // limitation of adapting a pre-existing method, not a gap unique to
      // this operation.
      usage: {},
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });

  if (result.ok || result.invocationId === undefined) {
    // Either already succeeded, or failed so early (the STARTED row
    // itself never got created) that there's no real evidence to attach a
    // synthesized fallback result to -- pass the failure through
    // unchanged rather than fabricating an invocationId.
    return result;
  }

  // source is always explicitly labeled DETERMINISTIC_FALLBACK here --
  // never indistinguishable from a real MODEL result, per the locked
  // decision that fallback output must never be ambiguous to a downstream
  // caller.
  return {
    ok: true,
    value: { responseText: options.deterministicFallback },
    source: "DETERMINISTIC_FALLBACK",
    invocationId: result.invocationId,
  };
}
