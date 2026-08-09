import { ELORA_PERSONA } from "@vireon/persona-config";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { runResponseSynthesis } from "../elora/llm/operations/responseSynthesis.js";
import { readProviderKindFromEnv, selectLlmProvider } from "../elora/llm/providerSelection.js";
import type { LlmProvider, LlmResponseContext } from "../elora/llm/types.js";
import type { RetrievedMemoryRecord } from "../elora/retrieveRelevantMemory.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { setCorrelationAttributes, withSpan } from "../telemetry/correlation.js";
import { createCognitiveRun } from "./createCognitiveRun.js";
import type { CognitiveRun } from "../schemas/cognitiveRun.js";
import { transitionCognitiveRun } from "./transitionCognitiveRun.js";

const TRACER_NAME = "cognition";

// Section 5.3: this coordinator's sole objective_kind. No WorkOrder is ever
// created for this path -- work_order_id stays null throughout.
const OBJECTIVE_KIND = "informational_response";

const RESPONSE_SYNTHESIS_OPERATION_KIND = "response_synthesis";
const RESPONSE_SYNTHESIS_OPERATION_VERSION = "1";

/**
 * Section 5.11: the absolute, no-raw-error safety net. Used only when the
 * coordinator cannot return a substantiated synthesized response -- distinct
 * from response_synthesis's own deterministic fallback (see
 * produceDeterministicInformationalAnswer below), which is a real,
 * memory-grounded answer attached to a real invocation and leads to
 * COMPLETED. This text leads to FAILED. Not extracted into a shared
 * constant with the pre-existing identical literal in
 * ingestUserMessage.ts/synthesizeIngestionResponse.ts -- no such constant
 * exists yet, and introducing one is a broader refactor than this PR's scope.
 */
const ABSOLUTE_FALLBACK_RESPONSE_TEXT = "I need more information to proceed with this request.";

export interface RunInformationalCognitiveRunInput {
  tenantId: string;
  threadId: string;
  messageId: string;
  initiatedByActorId: string;
  userMessageContent: string;
  retrievedMemory: RetrievedMemoryRecord[];
}

export interface InformationalCognitiveRunResult {
  cognitiveRunId: string;
  modelInvocationId: string | null;
  responseText: string;
  finalStatus: "COMPLETED" | "FAILED";
  /**
   * Reuses executeModelOperation.ts's own "MODEL" | "DETERMINISTIC_FALLBACK"
   * vocabulary (src/elora/llm/executeModelOperation.ts) rather than
   * inventing new casing/terms -- this is that same distinction, just
   * finally propagated out of the coordinator instead of staying internal.
   * "UNSUBSTANTIATED" is the new third case this field adds: no real
   * answer was produced at all, only the absolute placeholder.
   */
  responseSource: "MODEL" | "DETERMINISTIC_FALLBACK" | "UNSUBSTANTIATED";
}

/**
 * Deterministic, template-based answer -- no model call, no pretending a
 * model produced it (same discipline as produceDirectAnswer.ts). This is
 * the `deterministicFallback` runResponseSynthesis() attaches to a real,
 * terminal model invocation when the provider call itself fails or times
 * out (§4.2) -- it must therefore already be a genuine, honest direct
 * answer grounded only in what's actually known (the user's own message and
 * retrieved memory), never an invented fact and never the "I need more
 * information" placeholder, which belongs solely to the FAILED path.
 */
function produceDeterministicInformationalAnswer(userMessageContent: string, retrievedMemory: RetrievedMemoryRecord[]): string {
  if (retrievedMemory.length === 0) {
    return `Here's what I can share based on your message: "${userMessageContent.slice(0, 200)}." I don't have additional prior context on record for this one.`;
  }
  const snippet = retrievedMemory[0]!.content.slice(0, 200);
  return `Based on what I have on record: ${snippet}`;
}

function selectConfiguredProvider(): LlmProvider {
  const providerKind = readProviderKindFromEnv();
  return selectLlmProvider(providerKind, {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
  });
}

async function findLatestTerminalModelInvocationId(tenantId: string, cognitiveRunId: string): Promise<string | null> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM model_invocations
       WHERE tenant_id = $1 AND cognitive_run_id = $2 AND status IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT')
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, cognitiveRunId],
    );
    return result.rows[0]?.id ?? null;
  });
}

/**
 * Section 6: createCognitiveRun() insert-or-fetches, so a duplicate call
 * (retry, concurrent duplicate submission) can hand back a CognitiveRun
 * that is already RUNNING or terminal. Blindly re-running PENDING -> RUNNING
 * would throw; blindly re-invoking the provider would duplicate external
 * work. This is the bounded, honest v1 handling: inspect what's already
 * known, never re-execute, never mutate a run this call didn't originate.
 *
 * Deferred limitation (documented, not a gap to silently paper over): the
 * original synthesized response text is not reconstructable from
 * model_invocations alone -- that table stores fingerprints and metadata,
 * not full response content (§3 completion-consistency schema; no
 * response-content column exists). A replayed call therefore returns the
 * absolute placeholder rather than the original answer, while still
 * reporting the real, already-known cognitiveRunId/modelInvocationId and an
 * honest finalStatus derived from the run's actual persisted status.
 */
async function loadExistingRunOutcome(tenantId: string, cognitiveRun: CognitiveRun): Promise<InformationalCognitiveRunResult> {
  const modelInvocationId = await findLatestTerminalModelInvocationId(tenantId, cognitiveRun.id);
  return {
    cognitiveRunId: cognitiveRun.id,
    modelInvocationId,
    responseText: ABSOLUTE_FALLBACK_RESPONSE_TEXT,
    finalStatus: cognitiveRun.status === "COMPLETED" ? "COMPLETED" : "FAILED",
    // Honest, not a fix: the text returned here is always the placeholder
    // (see this function's own doc comment on why), regardless of whether
    // the original attempt actually produced a real answer -- so it's
    // never MODEL/DETERMINISTIC_FALLBACK, even on a COMPLETED reload.
    responseSource: "UNSUBSTANTIATED",
  };
}

/**
 * Best-effort RUNNING -> FAILED transition plus a caller-supplied response
 * result. "Best-effort" because the run may no longer be in a state that
 * can reach FAILED (e.g. a genuinely unexpected concurrent mutation) --
 * §13.8/§14 require the user-facing outcome to stay safe either way, never
 * that this secondary transition itself must succeed. Never throws.
 *
 * responseText/responseSource default to the absolute placeholder /
 * "UNSUBSTANTIATED" for genuinely unexpected failures, but ADR 0008 §7/§3
 * callers (a known, anticipated provider-configuration failure) pass the
 * honest deterministic answer and "DETERMINISTIC_FALLBACK" instead -- see
 * the provider-selection catch below for why.
 */
async function failRun(
  input: RunInformationalCognitiveRunInput,
  cognitiveRunId: string,
  reason: string,
  modelInvocationId: string | null,
  responseText: string = ABSOLUTE_FALLBACK_RESPONSE_TEXT,
  responseSource: InformationalCognitiveRunResult["responseSource"] = "UNSUBSTANTIATED",
): Promise<InformationalCognitiveRunResult> {
  try {
    await transitionCognitiveRun({
      tenantId: input.tenantId,
      cognitiveRunId,
      nextStatus: "FAILED",
      actorId: input.initiatedByActorId,
      reason,
      metadata: modelInvocationId ? { modelInvocationId } : {},
    });
  } catch {
    // The run may already be past RUNNING (e.g. terminal via a concurrent
    // path) -- the FAILED transition attempt is best-effort bookkeeping,
    // never load-bearing for the response returned to the user.
  }
  return {
    cognitiveRunId,
    modelInvocationId,
    responseText,
    finalStatus: "FAILED",
    responseSource,
  };
}

const FAILED_REASON = "Informational response synthesis could not be completed with a substantiating model invocation.";

/**
 * PR 4 / Section 20: the first production caller connecting ELORA
 * informational ingestion, cognitive_runs, model_invocations, response
 * synthesis, provider selection, and retrieved memory grounding into a
 * single durable cognitive run. Only ever invoked for the `informational`
 * intent branch (see ingestUserMessage.ts) -- never creates a WorkOrder,
 * never touches the WorkOrder lifecycle, never calls the model-backed
 * intent-interpretation operation (the deterministic parser has already
 * classified the message before this runs).
 *
 * Sequence: createCognitiveRun -> PENDING -> RUNNING -> select configured
 * provider -> runResponseSynthesis -> COMPLETED or FAILED. COMPLETED is only
 * reachable through transitionCognitiveRun.ts's own completion
 * substantiation gate (cognitiveRunState.ts / transitionCognitiveRun.ts
 * §4.1) -- this coordinator never bypasses that gate, it only supplies the
 * real model invocation the gate requires.
 */
export async function runInformationalCognitiveRun(
  input: RunInformationalCognitiveRunInput,
): Promise<InformationalCognitiveRunResult> {
  return withSpan(
    TRACER_NAME,
    "cognition.informational_run",
    {
      "vireon.tenant.id": input.tenantId,
      "vireon.thread.id": input.threadId,
      "vireon.message.id": input.messageId,
    },
    async (span) => {
      const { cognitiveRun } = await createCognitiveRun({
        tenantId: input.tenantId,
        threadId: input.threadId,
        messageId: input.messageId,
        initiatedByActorId: input.initiatedByActorId,
        objectiveKind: OBJECTIVE_KIND,
      });
      setCorrelationAttributes(span, { cognitiveRunId: cognitiveRun.id });

      if (cognitiveRun.status !== "PENDING") {
        return loadExistingRunOutcome(input.tenantId, cognitiveRun);
      }

      try {
        await transitionCognitiveRun({
          tenantId: input.tenantId,
          cognitiveRunId: cognitiveRun.id,
          nextStatus: "RUNNING",
          actorId: input.initiatedByActorId,
          reason: "Beginning informational response synthesis.",
        });
      } catch {
        // Never reached RUNNING -- PENDING has no outgoing edge to FAILED,
        // so there is nothing further to transition. The absolute
        // placeholder is still the correct, honest response.
        return {
          cognitiveRunId: cognitiveRun.id,
          modelInvocationId: null,
          responseText: ABSOLUTE_FALLBACK_RESPONSE_TEXT,
          finalStatus: "FAILED",
          responseSource: "UNSUBSTANTIATED",
        };
      }

      // ADR 0008 §7/§3: provider selection is split into its own try/catch,
      // separate from the "truly unexpected" catch-all below. A missing or
      // misconfigured provider (e.g. MODEL_PROVIDER set but its API key
      // unset) is a known, anticipated condition -- .env.example documents
      // it as the intended graceful-degradation case ("if unset, ELORA
      // falls back to the deterministic template response for every
      // branch") -- not a genuinely unexpected coordinator failure. No
      // model_invocations row is possible here (no provider object ever
      // existed to attempt a call with), so transitionCognitiveRun.ts's
      // completion substantiation gate (§4.1) still correctly keeps this
      // run FAILED rather than COMPLETED; what changes is the response
      // text the user actually sees. Per the degraded-routing contract
      // (§3), this returns a real, honest, deterministic conversational
      // answer -- never the generic "I need more information" placeholder,
      // which reads exactly like ELORA soliciting clarification to build a
      // WorkOrder, and never a WorkOrder, tool call, or delegation either.
      let provider: LlmProvider;
      try {
        provider = selectConfiguredProvider();
      } catch {
        return failRun(
          input,
          cognitiveRun.id,
          "Model provider is not configured or unavailable; degraded to the deterministic informational answer.",
          null,
          produceDeterministicInformationalAnswer(input.userMessageContent, input.retrievedMemory),
          "DETERMINISTIC_FALLBACK",
        );
      }

      try {
        const context: LlmResponseContext = {
          persona: ELORA_PERSONA,
          userMessageContent: input.userMessageContent,
          taskType: "informational",
          reason: "This is a direct informational request; no WorkOrder or authority decision applies.",
          retrievedMemorySnippets: input.retrievedMemory.map((record) => record.content.slice(0, 200)),
        };

        const invocationKey = buildIdempotencyKey([
          input.tenantId,
          cognitiveRun.id,
          RESPONSE_SYNTHESIS_OPERATION_KIND,
          RESPONSE_SYNTHESIS_OPERATION_VERSION,
        ]);
        const deterministicFallback = produceDeterministicInformationalAnswer(input.userMessageContent, input.retrievedMemory);

        const result = await runResponseSynthesis(context, {
          tenantId: input.tenantId,
          cognitiveRunId: cognitiveRun.id,
          provider,
          invocationKey,
          deterministicFallback,
        });

        if (!result.ok) {
          return failRun(input, cognitiveRun.id, FAILED_REASON, result.invocationId ?? null);
        }

        try {
          await transitionCognitiveRun({
            tenantId: input.tenantId,
            cognitiveRunId: cognitiveRun.id,
            nextStatus: "COMPLETED",
            actorId: input.initiatedByActorId,
            reason: "Informational response synthesis completed with a substantiating model invocation.",
            metadata: { modelInvocationId: result.invocationId, responseSource: result.source },
          });
        } catch {
          return failRun(input, cognitiveRun.id, FAILED_REASON, result.invocationId);
        }

        setCorrelationAttributes(span, { cognitiveRunId: cognitiveRun.id });
        span.setAttribute("vireon.model_invocation.id", result.invocationId);
        return {
          cognitiveRunId: cognitiveRun.id,
          modelInvocationId: result.invocationId,
          responseText: result.value.responseText,
          finalStatus: "COMPLETED",
          responseSource: result.source,
        };
      } catch {
        // Truly unexpected only, now that provider selection has its own
        // catch above: a coordinator-level exception outside
        // executeModelOperation.ts's own { ok: false } error boundary.
        // Never leaked to the caller as a raw exception -- always the safe
        // placeholder plus a best-effort FAILED transition.
        return failRun(input, cognitiveRun.id, FAILED_REASON, null);
      }
    },
  );
}
