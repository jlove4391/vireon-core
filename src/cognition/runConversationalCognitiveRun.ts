import { ELORA_PERSONA } from "@vireon/persona-config";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { runResponseSynthesis } from "../elora/llm/operations/responseSynthesis.js";
import { selectConfiguredProviderFromEnv } from "../elora/llm/providerSelection.js";
import type { LlmProvider, LlmResponseContext } from "../elora/llm/types.js";
import type { RetrievedMemoryRecord } from "../elora/retrieveRelevantMemory.js";
import type { EloraStructuredIntent } from "../elora/types.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { setCorrelationAttributes, withSpan } from "../telemetry/correlation.js";
import { createCognitiveRun } from "./createCognitiveRun.js";
import type { CognitiveRun } from "../schemas/cognitiveRun.js";
import { transitionCognitiveRun } from "./transitionCognitiveRun.js";

const TRACER_NAME = "cognition";

// ADR 0008 Realignment A: one objective_kind for every route this
// coordinator handles -- the route itself (intent.route) is the finer-grained
// signal, carried in transition metadata and in the response, not encoded
// into a family of parallel objective_kind strings. (tenant_id, thread_id,
// message_id, initiated_by_actor_id, objective_kind) already uniquely
// identifies "the one conversational turn for this message" regardless of
// which route it resolved to.
const OBJECTIVE_KIND = "conversational_turn";

const RESPONSE_SYNTHESIS_OPERATION_KIND = "response_synthesis";
const RESPONSE_SYNTHESIS_OPERATION_VERSION = "1";

/**
 * Section 5.11: the absolute, no-raw-error safety net. Used only when the
 * coordinator cannot return a substantiated synthesized response -- distinct
 * from response_synthesis's own deterministic fallback (see
 * produceDeterministicRouteAnswer below), which is a real, grounded answer
 * attached to a real invocation and leads to COMPLETED. This text leads to
 * FAILED. Not extracted into a shared constant with the pre-existing
 * identical literal in ingestUserMessage.ts/synthesizeIngestionResponse.ts --
 * no such constant exists yet, and introducing one is a broader refactor
 * than this PR's scope.
 */
const ABSOLUTE_FALLBACK_RESPONSE_TEXT = "I need more information to proceed with this request.";

export interface RunConversationalCognitiveRunInput {
  tenantId: string;
  threadId: string;
  messageId: string;
  initiatedByActorId: string;
  userMessageContent: string;
  retrievedMemory: RetrievedMemoryRecord[];
  /** The already-resolved route + interpretation (resolveEloraRoute.ts) -- this coordinator narrates it, it does not itself decide routing. */
  intent: EloraStructuredIntent;
  /** ADR 0008 §6: bounded recent-thread/memory context (assembleThreadContext.ts), when assembled. */
  threadContext?: string;
}

export interface ConversationalCognitiveRunResult {
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
 * ADR 0008 §2/§4: every route this coordinator handles gets a real,
 * in-character, honest response through the same response_synthesis model
 * call -- "honest acknowledgment" for delegate/durable_work/
 * consequential_action/setup_required is not a structurally separate,
 * template-only path from ordinary conversation. It differs only in what
 * `reason` tells the model to say (recognize the request, explain plainly
 * why it isn't actionable yet, never pretend a WorkOrder or side effect
 * happened). refuse gets the same treatment -- a real, in-character refusal,
 * not a canned string, while still never creating a WorkOrder or taking
 * any action.
 */
function describeRouteForModel(intent: EloraStructuredIntent): { taskType: string; reason: string } {
  switch (intent.route) {
    case "converse":
    case "direct_answer":
    case "tool_assisted":
      return {
        taskType: "conversational",
        reason: "This is a direct conversational request; no WorkOrder or authority decision applies. Respond naturally and helpfully, in character.",
      };
    case "clarify":
      return {
        taskType: "conversational",
        reason: intent.clarifyingQuestion
          ? `This request is ambiguous. Ask the user for clarification, specifically: ${intent.clarifyingQuestion}`
          : "This request is ambiguous. Ask the user a clarifying question rather than guessing.",
      };
    case "capability_missing":
      return {
        taskType: "conversational",
        reason: "This request needs a capability the runtime does not yet have. Explain honestly what's missing, without pretending anything was done.",
      };
    case "delegate":
      return {
        taskType: "conversational",
        reason: `This request describes work for ${intent.proposedDelegationTarget ?? "another specialist"}. Recognize that plainly, explain that handing work off isn't wired up yet, and that this has been noted -- never claim a WorkOrder or handoff happened.`,
      };
    case "durable_work":
      return {
        taskType: "conversational",
        reason: "This request describes durable, multi-step work. Recognize that plainly, explain that tracked task creation isn't wired up yet, and that this has been noted -- never claim a WorkOrder was created.",
      };
    // Known, temporary gap (explicitly called out, not quietly accepted as
    // "handled"): unlike refuse, consequential_action gets honest
    // acknowledgment only here -- no AuthorityDecision/ActionReceipt is
    // written for it, on purpose, for now. Realignment A ships zero new
    // tools (ADR 0008 §5 scope), so there is no registered capability this
    // route could actually invoke yet; an AuthorityDecision/ActionReceipt
    // for an action the runtime has no way to execute would be a receipt
    // for nothing. This route gets the same governed direct-write treatment
    // refuse now has (writeRefusalRecord.ts) once Realignment C's tool
    // gateway exists to actually back it -- not before.
    case "consequential_action":
      return {
        taskType: "conversational",
        reason: "This request would involve a real external side effect. Recognize that plainly, explain that taking real actions isn't wired up yet through this conversational path -- never claim the action happened.",
      };
    case "setup_required":
      return {
        taskType: "conversational",
        reason: "This request needs configuration or setup that isn't available yet. Explain honestly what's missing.",
      };
    case "refuse":
      return {
        taskType: "conversational",
        reason: "This request should be refused. Explain briefly and firmly why you can't help with this, without being preachy or judgmental.",
      };
  }
}

/**
 * Deterministic, template-based answer -- no model call, no pretending a
 * model produced it (same discipline as produceDirectAnswer.ts). This is
 * the `deterministicFallback` runResponseSynthesis() attaches to a real,
 * terminal model invocation when the provider call itself fails or times
 * out (§4.2); it is also what ADR 0008 §3's degraded-routing catch (in
 * ingestUserMessage.ts, when provider selection itself fails) uses
 * directly. Route-aware so the fallback text is honest about *what* wasn't
 * actionable, not a generic placeholder -- never the "I need more
 * information" placeholder, which belongs solely to the FAILED/no-evidence path.
 */
export function produceDeterministicRouteAnswer(intent: EloraStructuredIntent, retrievedMemory: RetrievedMemoryRecord[]): string {
  const memorySuffix =
    retrievedMemory.length > 0 ? ` Building on what I recall from prior context: ${retrievedMemory[0]!.content.slice(0, 160)}` : "";

  switch (intent.route) {
    case "delegate":
      return `This looks like work for ${intent.proposedDelegationTarget ?? "a specialist"}, but I'm not yet able to hand off work through this path -- that capability is still being built. I've noted your request: "${intent.interpretedIntent}".${memorySuffix}`;
    case "durable_work":
      return `This looks like durable, multi-step work: "${intent.interpretedIntent}". I'm not yet able to create a tracked task for it through this conversational path -- that capability is still being built.${memorySuffix}`;
    // Known, temporary gap -- see describeRouteForModel's consequential_action
    // case above for why this stays acknowledgment-only (no AuthorityDecision/
    // ActionReceipt) rather than getting refuse's governed direct-write treatment.
    case "consequential_action":
      return `This would involve a real external action: "${intent.interpretedIntent}". I'm not yet able to take actions with real side effects through this conversational path -- that capability is still being built.${memorySuffix}`;
    case "setup_required":
      return `I can't proceed yet -- this needs configuration that isn't available: "${intent.interpretedIntent}".${memorySuffix}`;
    case "capability_missing":
      return `I don't have the capability to do this yet: "${intent.interpretedIntent}". I've noted it for visibility.${memorySuffix}`;
    case "refuse":
      return "I'm not able to help with this request.";
    case "clarify":
      return intent.clarifyingQuestion ?? `Could you say more about "${intent.interpretedIntent}"? I want to make sure I understand before responding.`;
    default:
      if (retrievedMemory.length === 0) {
        return `Here's what I can share based on your message: "${intent.interpretedIntent}." I don't have additional prior context on record for this one.`;
      }
      return `Based on what I have on record: ${retrievedMemory[0]!.content.slice(0, 200)}`;
  }
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
async function loadExistingRunOutcome(tenantId: string, cognitiveRun: CognitiveRun): Promise<ConversationalCognitiveRunResult> {
  const modelInvocationId = await findLatestTerminalModelInvocationId(tenantId, cognitiveRun.id);
  return {
    cognitiveRunId: cognitiveRun.id,
    modelInvocationId,
    responseText: ABSOLUTE_FALLBACK_RESPONSE_TEXT,
    finalStatus: cognitiveRun.status === "COMPLETED" ? "COMPLETED" : "FAILED",
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
 * "UNSUBSTANTIATED" for genuinely unexpected failures, but ADR 0008 §3
 * callers (a known, anticipated provider-configuration failure) pass the
 * honest deterministic answer and "DETERMINISTIC_FALLBACK" instead.
 */
async function failRun(
  tenantId: string,
  initiatedByActorId: string,
  cognitiveRunId: string,
  reason: string,
  modelInvocationId: string | null,
  responseText: string = ABSOLUTE_FALLBACK_RESPONSE_TEXT,
  responseSource: ConversationalCognitiveRunResult["responseSource"] = "UNSUBSTANTIATED",
): Promise<ConversationalCognitiveRunResult> {
  try {
    await transitionCognitiveRun({
      tenantId,
      cognitiveRunId,
      nextStatus: "FAILED",
      actorId: initiatedByActorId,
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

const FAILED_REASON = "Conversational response synthesis could not be completed with a substantiating model invocation.";

/**
 * PR 4 / ADR 0008 Realignment A: generalized from runInformationalCognitiveRun.ts
 * (PR 4's original informational-only coordinator) to handle every route
 * that reaches the conversational path -- ordinary conversation, direct
 * answers, clarification, capability_missing, tool_assisted-as-direct_answer,
 * and honest acknowledgment for delegate/durable_work/consequential_action/
 * setup_required/refuse. Still never creates a WorkOrder, still never
 * touches the WorkOrder lifecycle, still never calls the model-backed
 * intent-interpretation operation itself (that already happened in
 * resolveEloraRoute.ts before this runs -- this coordinator only narrates
 * an already-resolved route).
 *
 * Sequence: createCognitiveRun -> PENDING -> RUNNING -> select configured
 * provider -> runResponseSynthesis -> COMPLETED or FAILED. COMPLETED is only
 * reachable through transitionCognitiveRun.ts's own completion
 * substantiation gate (cognitiveRunState.ts / transitionCognitiveRun.ts
 * §4.1) -- this coordinator never bypasses that gate, it only supplies the
 * real model invocation the gate requires.
 */
export async function runConversationalCognitiveRun(
  input: RunConversationalCognitiveRunInput,
): Promise<ConversationalCognitiveRunResult> {
  return withSpan(
    TRACER_NAME,
    "cognition.conversational_run",
    {
      "vireon.tenant.id": input.tenantId,
      "vireon.thread.id": input.threadId,
      "vireon.message.id": input.messageId,
      "vireon.elora_route": input.intent.route,
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
          reason: `Beginning conversational response synthesis for route "${input.intent.route}".`,
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
      // it as the intended graceful-degradation case -- not a genuinely
      // unexpected coordinator failure. No model_invocations row is
      // possible here (no provider object ever existed to attempt a call
      // with), so transitionCognitiveRun.ts's completion substantiation
      // gate (§4.1) still correctly keeps this run FAILED rather than
      // COMPLETED; what changes is the response text the user actually
      // sees. Per the degraded-routing contract (§3), this returns a real,
      // honest, route-aware conversational answer -- never the generic "I
      // need more information" placeholder, and never a WorkOrder, tool
      // call, or delegation either.
      let provider: LlmProvider;
      try {
        provider = selectConfiguredProviderFromEnv();
      } catch {
        return failRun(
          input.tenantId,
          input.initiatedByActorId,
          cognitiveRun.id,
          "Model provider is not configured or unavailable; degraded to the deterministic route answer.",
          null,
          produceDeterministicRouteAnswer(input.intent, input.retrievedMemory),
          "DETERMINISTIC_FALLBACK",
        );
      }

      try {
        const { taskType, reason } = describeRouteForModel(input.intent);
        const context: LlmResponseContext = {
          persona: ELORA_PERSONA,
          userMessageContent: input.threadContext
            ? `${input.threadContext}\n\nCurrent message:\n${input.userMessageContent}`
            : input.userMessageContent,
          taskType,
          reason,
          retrievedMemorySnippets: input.retrievedMemory.map((record) => record.content.slice(0, 200)),
        };

        const invocationKey = buildIdempotencyKey([
          input.tenantId,
          cognitiveRun.id,
          RESPONSE_SYNTHESIS_OPERATION_KIND,
          RESPONSE_SYNTHESIS_OPERATION_VERSION,
        ]);
        const deterministicFallback = produceDeterministicRouteAnswer(input.intent, input.retrievedMemory);

        const result = await runResponseSynthesis(context, {
          tenantId: input.tenantId,
          cognitiveRunId: cognitiveRun.id,
          provider,
          invocationKey,
          deterministicFallback,
        });

        if (!result.ok) {
          return failRun(input.tenantId, input.initiatedByActorId, cognitiveRun.id, FAILED_REASON, result.invocationId ?? null);
        }

        try {
          await transitionCognitiveRun({
            tenantId: input.tenantId,
            cognitiveRunId: cognitiveRun.id,
            nextStatus: "COMPLETED",
            actorId: input.initiatedByActorId,
            reason: "Conversational response synthesis completed with a substantiating model invocation.",
            metadata: { modelInvocationId: result.invocationId, responseSource: result.source, route: input.intent.route },
          });
        } catch {
          return failRun(input.tenantId, input.initiatedByActorId, cognitiveRun.id, FAILED_REASON, result.invocationId);
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
        return failRun(input.tenantId, input.initiatedByActorId, cognitiveRun.id, FAILED_REASON, null);
      }
    },
  );
}
