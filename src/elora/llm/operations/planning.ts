import {
  DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  executeModelOperation,
  type ModelOperationResult,
  type RunOperationOptions,
} from "../executeModelOperation.js";
import { PlanningInputSchema, PlanningOutputSchema, type PlanningInput, type PlanningOutput } from "../types.js";

export { PlanningInputSchema, PlanningOutputSchema };
export type { PlanningInput, PlanningOutput };

/**
 * PR 2: proves the mechanism only -- no live caller. A malformed planning
 * response must never silently become a fabricated plan (locked decision),
 * so unlike responseSynthesis.ts, this operation has no fallback: a
 * failure is returned as ok:false, never masked.
 */
export async function runPlanning(
  input: PlanningInput,
  options: RunOperationOptions,
): Promise<ModelOperationResult<PlanningOutput>> {
  const validatedInput = PlanningInputSchema.parse(input);
  return executeModelOperation({
    tenantId: options.tenantId,
    cognitiveRunId: options.cognitiveRunId,
    operationKind: "planning",
    invocationKey: options.invocationKey,
    attemptNumber: options.attemptNumber,
    provider: options.provider,
    input: validatedInput,
    outputSchema: PlanningOutputSchema,
    callProvider: (provider, providerInput, timeoutMs) => provider.plan(providerInput, timeoutMs),
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_OPERATION_TIMEOUT_MS,
  });
}
