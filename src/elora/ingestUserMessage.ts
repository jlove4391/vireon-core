import { randomUUID } from "node:crypto";
import { ELORA_PERSONA, type PersonaConfig } from "@vireon/persona-config";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { createWorkOrder, type CreateWorkOrderResult } from "../state/createWorkOrder.js";
import { transitionWorkOrder, type TransitionWorkOrderInput } from "../state/transitionWorkOrder.js";
import {
  AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS,
  WorkOrderStatusSchema,
  type WorkOrderStatus,
} from "../state/workOrderState.js";
import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import { isToolRegistered } from "../tools/registry.js";
import { registerCoreTools } from "../tools/index.js";
import { setCorrelationAttributes, withSpan } from "../telemetry/correlation.js";
import { dispatchTool } from "./dispatchTool.js";
import { EloraPersonaActorNotFoundError } from "./errors.js";
import { generateEloraResponse } from "./generateEloraResponse.js";
import { normalizeIngress } from "./normalizeIngress.js";
import { persistMessage } from "./persistMessage.js";
import { parseIntent } from "./parseIntent.js";
import { proposeMemoryCandidates } from "./proposeMemoryCandidates.js";
import { resolveAuthorityWithHierarchy } from "./resolveAuthorityWithHierarchy.js";
import { resolveContext } from "./resolveContext.js";
import { retrieveRelevantMemory, type RetrievedMemoryRecord } from "./retrieveRelevantMemory.js";
import { runToolExecution } from "./runToolExecution.js";
import { synthesizeIngestionResponse } from "./synthesizeIngestionResponse.js";
import { AUTHORITY_OUTCOME_TO_REASON_CODE, type EloraIngestionResult, type EloraIngressInput, type EloraStructuredIntent } from "./types.js";
import { writeBlockedReceipt } from "./writeBlockedReceipt.js";
import { writeEloraReceipt } from "./writeEloraReceipt.js";

const TRACER_NAME = "elora.ingestion";

/**
 * Prep Pass (Persona Identity Consolidation): generalized from the former
 * ELORA-hardcoded resolveEloraPersonaActorId(). Resolves any PersonaConfig's
 * corresponding actors row via the real, declared join key --
 * persona.actorName -- instead of a literal name match. (tenant_id,
 * actor_name) is enforced tenant-unique at the database level by
 * migrations/0008_actor_name_uniqueness.sql, not merely true by
 * seedPersonaRoster.ts's convention, so the prior query's additional
 * `hierarchy_tier = 'executive'` condition is dropped here rather than
 * hardcoded into a function meant to work for any persona tier.
 *
 * Dropping that condition is intentional generalization, not a dropped
 * safety check: it was necessary so non-executive-tier personas (Inner
 * Circle, Outer Circle, Special Envoy) can resolve at all -- a literal
 * `hierarchy_tier = 'executive'` filter would make this function permanently
 * Elora-only, defeating the point of generalizing it. The uniqueness
 * constraint above is what actually keeps this safe, not the dropped tier
 * check, which was never a uniqueness guarantee to begin with.
 *
 * Phase 6C §6: only ELORA has a live ingestion pipeline today, so the
 * hierarchy walk's starting actor is still only ever called with her
 * persona today -- a stated, known limitation, not a silent gap. This is
 * fully generic from resolveAuthorityWithHierarchy.ts's point of view (it
 * just receives an actor id); the persona-specific lookup lives here, at
 * the call site, and only runs lazily when a walk is actually about to
 * happen (an ordinary, non-floor-protected escalate) -- not on every
 * request.
 */
export async function resolvePersonaActorId(input: { tenantId: string; persona: PersonaConfig }): Promise<string> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM actors WHERE tenant_id = $1 AND actor_name = $2",
      [input.tenantId, input.persona.actorName],
    );
    const row = result.rows[0];
    if (!row) {
      throw new EloraPersonaActorNotFoundError(input.tenantId, input.persona.actorName);
    }
    return row.id;
  });
}

// Static, in-process tool registry (§5) -- registered once at module load,
// before any call to ingestUserMessage() can execute.
registerCoreTools();

const BLOCKED_STATUSES: readonly WorkOrderStatus[] = [
  "AWAITING_AUTHORIZATION",
  "SETUP_REQUIRED",
  "CAPABILITY_MISSING",
  "REFUSED",
];

/**
 * PR 0: thin wrapper around transitionWorkOrder() that puts each transition
 * in its own bounded span carrying the WorkOrder correlation id and the
 * target status. Every ingestUserMessage() call site below goes through
 * this instead of calling transitionWorkOrder() directly, so no transition
 * in the pipeline is left untraced.
 */
async function instrumentedTransition(
  tenantId: string,
  input: TransitionWorkOrderInput,
): ReturnType<typeof transitionWorkOrder> {
  return withSpan(
    TRACER_NAME,
    "elora.work_order_transition",
    { "vireon.tenant.id": tenantId, "vireon.work_order.id": input.workOrderId, "vireon.work_order.status_to": input.nextStatus },
    async (span) => {
      const result = await transitionWorkOrder(input);
      setCorrelationAttributes(span, { authorityDecisionId: result.authorityDecision?.id, receiptId: result.actionReceipt?.id });
      return result;
    },
  );
}

/**
 * A duplicate submission's createWorkOrder() call correctly insert-or-fetches
 * the pre-existing WorkOrder rather than creating a second one -- but that
 * WorkOrder is no longer at RECEIVED, so blindly re-running the transition
 * sequence from INTENT_PARSED would throw InvalidWorkOrderTransitionError.
 * When the fetched WorkOrder is already past RECEIVED, this reconstructs the
 * result from what was already recorded during the original ingestion,
 * instead of writing anything new. Phase 5 §12: extended with tool_invocations
 * / artifacts queries so a replayed artifact-creation request returns the
 * original durable references rather than re-invoking the gateway.
 */
async function loadAlreadyProcessedResult(
  tenantId: string,
  workOrder: CreateWorkOrderResult["workOrder"],
  intent: EloraStructuredIntent,
  retrievedMemory: RetrievedMemoryRecord[],
  persisted: { threadId: string; messageId: string; isDuplicate: boolean },
): Promise<EloraIngestionResult> {
  return withSpan(
    TRACER_NAME,
    "elora.load_already_processed_result",
    { "vireon.tenant.id": tenantId, "vireon.work_order.id": workOrder.id },
    () =>
      withTenantTransaction(tenantId, async (client) => {
        const transitionsResult = await client.query(
          "SELECT to_status FROM work_order_state_transitions WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC",
          [tenantId, workOrder.id],
        );
        const transitionPath = transitionsResult.rows.map((row) => WorkOrderStatusSchema.parse(row.to_status));

        let authorityOutcome: AuthorityOutcome | null = null;
        if (workOrder.authority_decision_id) {
          const authorityResult = await client.query("SELECT outcome FROM authority_decisions WHERE id = $1", [
            workOrder.authority_decision_id,
          ]);
          authorityOutcome = (authorityResult.rows[0]?.outcome as AuthorityOutcome | undefined) ?? null;
        }

        const receiptResult = await client.query(
          "SELECT id, receipt_type FROM action_receipts WHERE tenant_id = $1 AND work_order_id = $2 AND receipt_type IN ('elora_ingestion_completed', 'elora_request_blocked')",
          [tenantId, workOrder.id],
        );
        const completedReceipt = receiptResult.rows.find((row) => row.receipt_type === "elora_ingestion_completed");
        const blockedReceipt = receiptResult.rows.find((row) => row.receipt_type === "elora_request_blocked");

        const candidatesResult = await client.query(
          "SELECT id FROM memory_candidates WHERE tenant_id = $1 AND source_work_order_id = $2 ORDER BY created_at ASC",
          [tenantId, workOrder.id],
        );

        // Phase 5 §12: reconstruct the tool invocation / artifact references for
        // a replayed execution path, tenant-scoped, same pattern as the other
        // reconstructed fields above.
        const invocationResult = await client.query(
          "SELECT id FROM tool_invocations WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT 1",
          [tenantId, workOrder.id],
        );
        const artifactResult = await client.query(
          "SELECT id FROM artifacts WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT 1",
          [tenantId, workOrder.id],
        );

        const finalStatus = WorkOrderStatusSchema.parse(workOrder.status);
        const reconstructedOutcome = authorityOutcome ?? "act_and_report";
        const { responseType, responseText } = synthesizeIngestionResponse({
          finalWorkOrderStatus: finalStatus,
          intent,
          authority: {
            outcome: reconstructedOutcome,
            requires_human_gatekeeper: false,
            reason: "Reconstructed from a previously processed, idempotent duplicate submission.",
            reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE[reconstructedOutcome],
            risk_level: "low",
            required_setup: null,
            floorProtected: false,
          },
          retrievedMemory,
        });

        return {
          tenantId,
          threadId: persisted.threadId,
          messageId: persisted.messageId,
          isDuplicateMessage: persisted.isDuplicate,
          intent,
          retrievedMemoryCount: retrievedMemory.length,
          retrievedMemoryIds: retrievedMemory.map((record) => record.id),
          workOrderId: workOrder.id,
          authorityDecisionId: workOrder.authority_decision_id,
          authorityOutcome,
          finalWorkOrderStatus: finalStatus,
          transitionPath,
          responseType,
          responseText,
          actionReceiptId: (completedReceipt?.id as string | undefined) ?? null,
          blockedReceiptId: (blockedReceipt?.id as string | undefined) ?? null,
          toolInvocationId: (invocationResult.rows[0]?.id as string | undefined) ?? null,
          artifactId: (artifactResult.rows[0]?.id as string | undefined) ?? null,
          memoryCandidateIds: candidatesResult.rows.map((row) => row.id as string),
        };
      }),
  );
}

/**
 * ELORA v1 ingestion orchestrator -- the Phase 3 entrypoint. Moves a raw
 * natural-language request through: normalize -> resolve context -> persist
 * Message -> retrieve memory -> parse intent -> (create WorkOrder when
 * task-worthy) -> RECEIVED -> INTENT_PARSED -> AUTHORITY_CLASSIFIED ->
 * branch. No model calls anywhere in this pipeline.
 *
 * Phase 5 §8/§10: when the parsed intent deterministically dispatches to a
 * registered tool (currently only explicit local-Markdown-artifact
 * requests), the READY_TO_ACT branch follows the native Phase 2
 * EXECUTING -> VALIDATING -> RECEIPT_WRITTEN -> COMPLETED execution
 * sequence (runToolExecution.ts) instead of writeEloraReceipt.ts. Every
 * other request keeps the exact Phase 3/4 behavior, unmodified.
 *
 * PR 0: the whole call is wrapped in a root span (elora.ingest_user_message)
 * carrying tenant/thread/message correlation ids as soon as each becomes
 * known, with bounded child spans around each pipeline step (see
 * src/telemetry/correlation.ts). Telemetry is best-effort and must never
 * affect behavior -- see that module's docs; this function's control flow
 * and return values are unchanged from the pre-PR-0 version, only wrapped.
 */
export async function ingestUserMessage(input: EloraIngressInput): Promise<EloraIngestionResult> {
  return withSpan(TRACER_NAME, "elora.ingest_user_message", {}, async (rootSpan) => {
    const normalized = normalizeIngress(input);
    const context = await resolveContext(normalized);
    setCorrelationAttributes(rootSpan, { tenantId: context.tenantId });

    const persisted = await withSpan(
      TRACER_NAME,
      "elora.persist_message",
      { "vireon.tenant.id": context.tenantId },
      async (span) => {
        const result = await persistMessage({
          context,
          content: normalized.content,
          sourceSurface: normalized.sourceSurface,
          sourceCorrelationId: normalized.sourceCorrelationId,
        });
        setCorrelationAttributes(span, { threadId: result.threadId, messageId: result.messageId });
        span.setAttribute("vireon.message.is_duplicate", result.isDuplicate);
        return result;
      },
    );
    setCorrelationAttributes(rootSpan, { threadId: persisted.threadId, messageId: persisted.messageId });

    const retrievedMemory = await withSpan(
      TRACER_NAME,
      "elora.retrieve_memory",
      { "vireon.tenant.id": context.tenantId, "vireon.thread.id": persisted.threadId },
      async (span) => {
        const result = await retrieveRelevantMemory({
          tenantId: context.tenantId,
          queryText: persisted.content,
          // 6H §5.2: Elora's domain is null (executive-tier, full unweighted
          // pool) -- retrieveRelevantMemory() turns that into no ranking clause
          // at all, so this call is unaffected by 6H's addition, structurally,
          // not by a special case here.
          requestingPersonaDomain: ELORA_PERSONA.domain,
        });
        span.setAttribute("vireon.memory_candidate.retrieved_count", result.length);
        return result;
      },
    );

    const intent = parseIntent(persisted.content);

    if (intent.intent_type !== "work_order_candidate") {
      return {
        tenantId: context.tenantId,
        threadId: persisted.threadId,
        messageId: persisted.messageId,
        isDuplicateMessage: persisted.isDuplicate,
        intent,
        retrievedMemoryCount: retrievedMemory.length,
        retrievedMemoryIds: retrievedMemory.map((record) => record.id),
        workOrderId: null,
        authorityDecisionId: null,
        authorityOutcome: null,
        finalWorkOrderStatus: null,
        transitionPath: [],
        responseType: "clarification_required",
        responseText: "I need more information to proceed with this request.",
        actionReceiptId: null,
        blockedReceiptId: null,
        toolInvocationId: null,
        artifactId: null,
        memoryCandidateIds: [],
      };
    }

    // Deterministic, code-defined dispatch (§10) -- computed once, before
    // authority classification, so the §8.3 defensive registry check below
    // can override the outcome to capability_missing *before* the
    // AUTHORITY_CLASSIFIED -> branch transition, rather than after
    // READY_TO_ACT (where CAPABILITY_MISSING is not a reachable transition
    // target -- READY_TO_ACT only leads to EXECUTING or FAILED).
    const dispatched = dispatchTool(intent);

    const { workOrder } = await withSpan(
      TRACER_NAME,
      "elora.work_order_create",
      { "vireon.tenant.id": context.tenantId, "vireon.thread.id": persisted.threadId },
      async (span) => {
        const result = await createWorkOrder({
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          projectId: context.projectId,
          threadId: persisted.threadId,
          messageId: persisted.messageId,
          actorId: context.actorId,
          taskType: intent.task_type,
          interpretedIntent: intent.summary,
        });
        setCorrelationAttributes(span, { workOrderId: result.workOrder.id });
        span.setAttribute("vireon.work_order.status", result.workOrder.status);
        return result;
      },
    );
    setCorrelationAttributes(rootSpan, { workOrderId: workOrder.id });

    if (workOrder.status !== "RECEIVED") {
      return loadAlreadyProcessedResult(context.tenantId, workOrder, intent, retrievedMemory, persisted);
    }

    const transitionPath: WorkOrderStatus[] = [workOrder.status];

    const intentParsed = await instrumentedTransition(context.tenantId, {
      tenantId: context.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: context.actorId,
      reason: "Structured task parse completed",
    });
    transitionPath.push(intentParsed.workOrder.status);

    let authority = await withSpan(
      TRACER_NAME,
      "elora.authority_resolution",
      { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id },
      async (span) => {
        const result = await resolveAuthorityWithHierarchy({
          tenantId: context.tenantId,
          content: persisted.content,
          taskType: intent.task_type,
          resolvedProjectId: context.projectId,
          resolveStartingActorId: () => resolvePersonaActorId({ tenantId: context.tenantId, persona: ELORA_PERSONA }),
        });
        span.setAttribute("vireon.authority_decision.outcome", result.outcome);
        span.setAttribute("vireon.authority_decision.risk_level", result.risk_level ?? "unknown");
        return result;
      },
    );

    // §8.3: should be structurally impossible given the closed dispatch set
    // in dispatchTool.ts, but handled defensively -- if the dispatcher
    // resolved to a tool name that isn't actually registered, route through
    // the existing capability_missing authority branch instead of ever
    // reaching READY_TO_ACT with nothing to execute.
    if (dispatched && !isToolRegistered(dispatched.toolName)) {
      authority = {
        outcome: "capability_missing",
        requires_human_gatekeeper: false,
        reason: `Dispatched tool "${dispatched.toolName}" is not registered.`,
        reasonCode: AUTHORITY_OUTCOME_TO_REASON_CODE.capability_missing,
        risk_level: "low",
        required_setup: null,
        floorProtected: false,
        resolvedViaStandingRuleId: null,
      };
    }

    const authorityClassified = await instrumentedTransition(context.tenantId, {
      tenantId: context.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: context.actorId,
      reason: "Authority classification completed",
      authorityDecision: {
        outcome: authority.outcome,
        requiresHumanGatekeeper: authority.requires_human_gatekeeper,
        reason: authority.reason,
        riskLevel: authority.risk_level,
        requiredSetup: authority.required_setup,
        resolvedViaStandingRuleId: authority.resolvedViaStandingRuleId,
      },
    });
    transitionPath.push(authorityClassified.workOrder.status);

    const authorityDecisionId = authorityClassified.authorityDecision!.id;
    const branchStatus = AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS[authority.outcome];

    const branched = await instrumentedTransition(context.tenantId, {
      tenantId: context.tenantId,
      workOrderId: workOrder.id,
      nextStatus: branchStatus,
      actorId: context.actorId,
      reason: `Authority outcome "${authority.outcome}" routed to ${branchStatus}`,
    });
    transitionPath.push(branched.workOrder.status);

    let finalWorkOrderStatus: WorkOrderStatus = branched.workOrder.status;
    let responseType: EloraIngestionResult["responseType"];
    let responseText: string;
    let actionReceiptId: string | null = null;
    let blockedReceiptId: string | null = null;
    let toolInvocationId: string | null = null;
    let artifactId: string | null = null;
    let memoryCandidateIds: string[] = [];

    if (branched.workOrder.status === "READY_TO_ACT" && dispatched) {
      const executionResult = await withSpan(
        TRACER_NAME,
        "elora.tool_execution",
        { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id, "vireon.tool.name": dispatched.toolName },
        async (span) => {
          const result = await runToolExecution({
            tenantId: context.tenantId,
            workOrderId: workOrder.id,
            actorId: context.actorId,
            authorityDecisionId,
            workspaceId: context.workspaceId,
            projectId: context.projectId,
            threadId: persisted.threadId,
            sourceMessageId: persisted.messageId,
            correlationId: normalized.sourceCorrelationId ?? randomUUID(),
            dispatched,
            intent,
            authority,
          });
          // No `vireon.artifact.id` exists in the locked namespaced
          // correlation attribute set -- toolInvocationId is the one that
          // applies here.
          setCorrelationAttributes(span, { toolInvocationId: result.toolInvocationId });
          span.setAttribute("vireon.work_order.final_status", result.finalStatus);
          return result;
        },
      );

      finalWorkOrderStatus = executionResult.finalStatus;
      // runToolExecution's own transitionPath starts fresh at EXECUTING --
      // READY_TO_ACT was already pushed above, so this is a pure append.
      transitionPath.push(...executionResult.transitionPath);
      toolInvocationId = executionResult.toolInvocationId;
      artifactId = executionResult.artifactId;
      responseType = executionResult.finalStatus === "COMPLETED" ? "direct_answer" : "execution_failed";
      memoryCandidateIds = executionResult.memoryCandidateIds;

      // Phase 6F §5.1: called only after runToolExecution() has already
      // finalized the branch status (EXECUTING -> VALIDATING -> RECEIPT_WRITTEN
      // -> COMPLETED, or -> FAILED) -- the LLM narrates an already-decided
      // outcome, never something still in progress. executionResult.responseText
      // (runToolExecution.ts's own unmodified template) is the deterministic
      // fallback, not deleted, just no longer always the final answer.
      responseText = await withSpan(
        TRACER_NAME,
        "elora.generate_response",
        { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id },
        () =>
          generateEloraResponse({
            deterministicFallback: executionResult.responseText,
            context: {
              persona: ELORA_PERSONA,
              userMessageContent: persisted.content,
              taskType: intent.task_type,
              authorityOutcome: authority.outcome,
              reason: authority.reason,
              finalWorkOrderStatus: executionResult.finalStatus,
              toolResult:
                executionResult.finalStatus === "COMPLETED"
                  ? { toolName: dispatched.toolName, artifactFilename: intent.artifactRequest?.filename }
                  : null,
              retrievedMemorySnippets: retrievedMemory.map((record) => record.content.slice(0, 200)),
            },
          }),
      );
    } else {
      const synthesized = synthesizeIngestionResponse({
        finalWorkOrderStatus: branched.workOrder.status,
        intent,
        authority,
        retrievedMemory,
      });
      responseType = synthesized.responseType;

      // Phase 6F §5.1: called only after the AUTHORITY_CLASSIFIED -> {branch}
      // transition above has already completed -- branched.workOrder.status
      // is an already-decided fact to narrate, never something in progress.
      // synthesized.responseText (synthesizeIngestionResponse.ts's own
      // unmodified templates, covering READY_TO_ACT via produceDirectAnswer.ts
      // and the four blocked branches via its own inline text) is the
      // deterministic fallback.
      responseText = await withSpan(
        TRACER_NAME,
        "elora.generate_response",
        { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id },
        () =>
          generateEloraResponse({
            deterministicFallback: synthesized.responseText,
            context: {
              persona: ELORA_PERSONA,
              userMessageContent: persisted.content,
              taskType: intent.task_type,
              authorityOutcome: authority.outcome,
              reason: authority.reason,
              finalWorkOrderStatus: branched.workOrder.status,
              toolResult: null,
              retrievedMemorySnippets: retrievedMemory.map((record) => record.content.slice(0, 200)),
            },
          }),
      );

      if (branched.workOrder.status === "READY_TO_ACT") {
        const receipt = await withSpan(
          TRACER_NAME,
          "elora.receipt_write",
          { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id, "vireon.receipt.blocked": false },
          async (span) => {
            const result = await writeEloraReceipt({
              tenantId: context.tenantId,
              workOrderId: workOrder.id,
              authorityDecisionId,
              actorId: context.actorId,
              responseText,
              retrievedMemoryIds: retrievedMemory.map((record) => record.id),
            });
            setCorrelationAttributes(span, { receiptId: result.id });
            return result;
          },
        );
        actionReceiptId = receipt.id;
      } else if (BLOCKED_STATUSES.includes(branched.workOrder.status)) {
        const receipt = await withSpan(
          TRACER_NAME,
          "elora.receipt_write",
          { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id, "vireon.receipt.blocked": true },
          async (span) => {
            const result = await writeBlockedReceipt({
              tenantId: context.tenantId,
              workOrderId: workOrder.id,
              authorityDecisionId,
              actorId: context.actorId,
              responseText,
            });
            setCorrelationAttributes(span, { receiptId: result.id });
            return result;
          },
        );
        blockedReceiptId = receipt.id;
      }

      const memoryCandidates = await withSpan(
        TRACER_NAME,
        "elora.propose_memory_candidates",
        { "vireon.tenant.id": context.tenantId, "vireon.work_order.id": workOrder.id },
        async (span) => {
          const result = await proposeMemoryCandidates({
            tenantId: context.tenantId,
            workOrderId: workOrder.id,
            intent,
            authority,
          });
          span.setAttribute("vireon.memory_candidate.proposed_count", result.length);
          return result;
        },
      );
      memoryCandidateIds = memoryCandidates.map((candidate) => candidate.id);
    }

    return {
      tenantId: context.tenantId,
      threadId: persisted.threadId,
      messageId: persisted.messageId,
      isDuplicateMessage: persisted.isDuplicate,
      intent,
      retrievedMemoryCount: retrievedMemory.length,
      retrievedMemoryIds: retrievedMemory.map((record) => record.id),
      workOrderId: workOrder.id,
      authorityDecisionId,
      authorityOutcome: authority.outcome,
      finalWorkOrderStatus,
      transitionPath,
      responseType,
      responseText,
      actionReceiptId,
      blockedReceiptId,
      toolInvocationId,
      artifactId,
      memoryCandidateIds,
    };
  });
}
