import { REFUSE_CUE } from "./classifyAuthority.js";
import { runIntentInterpretation } from "./llm/operations/intentInterpretation.js";
import { selectConfiguredProviderFromEnv } from "./llm/providerSelection.js";
import type { IntentInterpretationOutput, LlmProvider } from "./llm/types.js";
import { detectArtifactCreationRequest, parseIntentDegraded } from "./parseIntent.js";
import type { EloraStructuredIntent } from "./types.js";

export interface ResolveEloraRouteInput {
  tenantId: string;
  content: string;
  /** ADR 0008 §6: bounded thread context, when the caller has assembled one. Omit for a fresh thread. */
  threadContext?: string;
  invocationKey: string;
  attemptNumber?: number;
  /** ADR 0008: threaded through to the degraded-mode fallback's own conservative-default override -- see parseIntentDegraded's ParseIntentDegradedOptions doc comment. */
  isSystemInitiated?: boolean;
}

export interface ResolveEloraRouteResult {
  intent: EloraStructuredIntent;
  /**
   * Reuses the same MODEL | DETERMINISTIC_FALLBACK vocabulary
   * executeModelOperation.ts / PR #41's responseSource plumbing already
   * established. Every non-model outcome -- the artifact-pattern bypass,
   * no provider configured, and a failed/timed-out interpretation call --
   * is DETERMINISTIC_FALLBACK; only a genuine, successful model route
   * proposal is MODEL.
   */
  classificationSource: "MODEL" | "DETERMINISTIC_FALLBACK";
  /** Set only when a real model call was attempted (succeeded or failed with a real STARTED row) -- null on every deterministic path, including the artifact bypass and missing-provider degraded mode. */
  modelInvocationId: string | null;
}

function toStructuredIntent(content: string, modelOutput: IntentInterpretationOutput): EloraStructuredIntent {
  return {
    route: modelOutput.route,
    interpretedIntent: modelOutput.interpretedIntent,
    confidence: modelOutput.confidence,
    taskDomain: modelOutput.taskDomain,
    requestedCapabilities: modelOutput.requestedCapabilities,
    proposedDelegationTarget: modelOutput.proposedDelegationTarget,
    requiresDurableWork: modelOutput.requiresDurableWork,
    proposedToolNeeds: modelOutput.proposedToolNeeds,
    externalSideEffect: modelOutput.externalSideEffect,
    requires_clarification: modelOutput.requiresClarification,
    clarifyingQuestion: modelOutput.clarifyingQuestion,
    // Legacy WorkOrder-pipeline fields -- never populated by the model
    // path (only the two deterministic bypasses set these meaningfully).
    task_type: "unknown",
    summary: content.slice(0, 200),
  };
}

/**
 * ELORA.md §19 / ADR 0008 §2: deterministic code, not the model, has the
 * final say on safety-critical routing. A hard refusal cue always wins
 * over whatever route the model proposed -- the same asymmetric,
 * conservative-only-override precedence classifyAuthority.ts already
 * established for this exact regex (REFUSE_CUE). This function only ever
 * narrows toward "refuse"; it never overrides a model-proposed "refuse"
 * back to something else -- over-refusal isn't a safety violation the way
 * under-refusal is.
 */
function applyDeterministicRouteOverrides(content: string, intent: EloraStructuredIntent): EloraStructuredIntent {
  if (REFUSE_CUE.test(content) && intent.route !== "refuse") {
    return { ...intent, route: "refuse" };
  }
  return intent;
}

/**
 * ADR 0008 §2/§3: the routing policy that replaces parseIntent.ts's old
 * role as the sole, unconditional intent classifier. Model proposes a
 * route (runIntentInterpretation), deterministic code decides the final
 * one (applyDeterministicRouteOverrides) -- same model-proposes/code-decides
 * split classifyAuthority.ts already established for authority outcomes,
 * now extended to routing.
 *
 * Three deterministic (non-model) exits, in precedence order:
 * 1. The explicit local-Markdown-artifact pattern -- bypasses the model
 *    entirely, model available or not, so the existing artifact-creation
 *    WorkOrder/tool pipeline keeps working completely unchanged.
 * 2. No model provider configured/available -- ADR 0008 §3 degraded mode.
 * 3. The interpretation call itself fails or times out -- also §3 degraded
 *    mode, same conservative fallback as case 2.
 *
 * Deliberately does not create or require a CognitiveRun (cognitiveRunId:
 * null on the model call, when one is made) -- this runs before the
 * caller has decided whether this turn even gets a CognitiveRun (WorkOrder-
 * bound routes never get one, per PR 4 §8's existing invariant), mirroring
 * how query-embedding calls elsewhere in this codebase are also legitimately
 * unattached to any cognitive run.
 */
export async function resolveEloraRoute(input: ResolveEloraRouteInput): Promise<ResolveEloraRouteResult> {
  const degradedOptions = { isSystemInitiated: input.isSystemInitiated };

  const artifactMatch = detectArtifactCreationRequest(input.content);
  if (artifactMatch) {
    return {
      intent: parseIntentDegraded(input.content, degradedOptions),
      classificationSource: "DETERMINISTIC_FALLBACK",
      modelInvocationId: null,
    };
  }

  let provider: LlmProvider;
  try {
    provider = selectConfiguredProviderFromEnv();
  } catch {
    return {
      intent: parseIntentDegraded(input.content, degradedOptions),
      classificationSource: "DETERMINISTIC_FALLBACK",
      modelInvocationId: null,
    };
  }

  const result = await runIntentInterpretation(
    { content: input.content, threadContext: input.threadContext },
    {
      tenantId: input.tenantId,
      cognitiveRunId: null,
      provider,
      invocationKey: input.invocationKey,
      attemptNumber: input.attemptNumber,
    },
  );

  if (!result.ok) {
    return {
      intent: parseIntentDegraded(input.content, degradedOptions),
      classificationSource: "DETERMINISTIC_FALLBACK",
      modelInvocationId: result.invocationId ?? null,
    };
  }

  const intent = applyDeterministicRouteOverrides(input.content, toStructuredIntent(input.content, result.value));
  return {
    intent,
    classificationSource: "MODEL",
    modelInvocationId: result.invocationId,
  };
}
