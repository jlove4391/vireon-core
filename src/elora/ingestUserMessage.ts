import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { createWorkOrder, type CreateWorkOrderResult } from "../state/createWorkOrder.js";
import { transitionWorkOrder } from "../state/transitionWorkOrder.js";
import {
  AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS,
  WorkOrderStatusSchema,
  type WorkOrderStatus,
} from "../state/workOrderState.js";
import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import { classifyAuthority } from "./classifyAuthority.js";
import { normalizeIngress } from "./normalizeIngress.js";
import { persistMessage } from "./persistMessage.js";
import { parseIntent } from "./parseIntent.js";
import { proposeMemoryCandidates } from "./proposeMemoryCandidates.js";
import { resolveContext } from "./resolveContext.js";
import { retrieveRelevantMemory, type RetrievedMemoryRecord } from "./retrieveRelevantMemory.js";
import { synthesizeIngestionResponse } from "./synthesizeIngestionResponse.js";
import { AUTHORITY_OUTCOME_TO_REASON_CODE, type EloraIngestionResult, type EloraIngressInput, type EloraStructuredIntent } from "./types.js";
import { writeBlockedReceipt } from "./writeBlockedReceipt.js";
import { writeEloraReceipt } from "./writeEloraReceipt.js";

const BLOCKED_STATUSES: readonly WorkOrderStatus[] = [
  "AWAITING_AUTHORIZATION",
  "SETUP_REQUIRED",
  "CAPABILITY_MISSING",
  "REFUSED",
];

/**
 * A duplicate submission's createWorkOrder() call correctly insert-or-fetches
 * the pre-existing WorkOrder rather than creating a second one -- but that
 * WorkOrder is no longer at RECEIVED, so blindly re-running the transition
 * sequence from INTENT_PARSED would throw InvalidWorkOrderTransitionError.
 * When the fetched WorkOrder is already past RECEIVED, this reconstructs the
 * result from what was already recorded during the original ingestion,
 * instead of writing anything new.
 */
async function loadAlreadyProcessedResult(
  tenantId: string,
  workOrder: CreateWorkOrderResult["workOrder"],
  intent: EloraStructuredIntent,
  retrievedMemory: RetrievedMemoryRecord[],
  persisted: { threadId: string; messageId: string; isDuplicate: boolean },
): Promise<EloraIngestionResult> {
  return withTenantTransaction(tenantId, async (client) => {
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
      memoryCandidateIds: candidatesResult.rows.map((row) => row.id as string),
    };
  });
}

/**
 * ELORA v1 ingestion orchestrator -- the Phase 3 entrypoint. Moves a raw
 * natural-language request through: normalize -> resolve context -> persist
 * Message -> retrieve memory -> parse intent -> (create WorkOrder when
 * task-worthy) -> RECEIVED -> INTENT_PARSED -> AUTHORITY_CLASSIFIED ->
 * branch. No model calls anywhere in this pipeline. Never moves a WorkOrder
 * past READY_TO_ACT or a non-execution branch status -- EXECUTING and
 * beyond are out of scope for Phase 3 (§6).
 */
export async function ingestUserMessage(input: EloraIngressInput): Promise<EloraIngestionResult> {
  const normalized = normalizeIngress(input);
  const context = await resolveContext(normalized);

  const persisted = await persistMessage({
    context,
    content: normalized.content,
    sourceSurface: normalized.sourceSurface,
    sourceCorrelationId: normalized.sourceCorrelationId,
  });

  const retrievedMemory = await retrieveRelevantMemory({
    tenantId: context.tenantId,
    queryText: persisted.content,
  });

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
      memoryCandidateIds: [],
    };
  }

  const { workOrder } = await createWorkOrder({
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    threadId: persisted.threadId,
    messageId: persisted.messageId,
    actorId: context.actorId,
    taskType: intent.task_type,
    interpretedIntent: intent.summary,
  });

  if (workOrder.status !== "RECEIVED") {
    return loadAlreadyProcessedResult(context.tenantId, workOrder, intent, retrievedMemory, persisted);
  }

  const transitionPath: WorkOrderStatus[] = [workOrder.status];

  const intentParsed = await transitionWorkOrder({
    tenantId: context.tenantId,
    workOrderId: workOrder.id,
    nextStatus: "INTENT_PARSED",
    actorId: context.actorId,
    reason: "Structured task parse completed",
  });
  transitionPath.push(intentParsed.workOrder.status);

  const authority = classifyAuthority({
    content: persisted.content,
    taskType: intent.task_type,
    resolvedProjectId: context.projectId,
  });

  const authorityClassified = await transitionWorkOrder({
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
    },
  });
  transitionPath.push(authorityClassified.workOrder.status);

  const authorityDecisionId = authorityClassified.authorityDecision!.id;
  const branchStatus = AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS[authority.outcome];

  const branched = await transitionWorkOrder({
    tenantId: context.tenantId,
    workOrderId: workOrder.id,
    nextStatus: branchStatus,
    actorId: context.actorId,
    reason: `Authority outcome "${authority.outcome}" routed to ${branchStatus}`,
  });
  transitionPath.push(branched.workOrder.status);

  const { responseType, responseText } = synthesizeIngestionResponse({
    finalWorkOrderStatus: branched.workOrder.status,
    intent,
    authority,
    retrievedMemory,
  });

  let actionReceiptId: string | null = null;
  let blockedReceiptId: string | null = null;
  if (branched.workOrder.status === "READY_TO_ACT") {
    const receipt = await writeEloraReceipt({
      tenantId: context.tenantId,
      workOrderId: workOrder.id,
      authorityDecisionId,
      actorId: context.actorId,
      responseText,
      retrievedMemoryIds: retrievedMemory.map((record) => record.id),
    });
    actionReceiptId = receipt.id;
  } else if (BLOCKED_STATUSES.includes(branched.workOrder.status)) {
    const receipt = await writeBlockedReceipt({
      tenantId: context.tenantId,
      workOrderId: workOrder.id,
      authorityDecisionId,
      actorId: context.actorId,
      responseText,
    });
    blockedReceiptId = receipt.id;
  }

  const memoryCandidates = await proposeMemoryCandidates({
    tenantId: context.tenantId,
    workOrderId: workOrder.id,
    intent,
    authority,
  });

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
    finalWorkOrderStatus: branched.workOrder.status,
    transitionPath,
    responseType,
    responseText,
    actionReceiptId,
    blockedReceiptId,
    memoryCandidateIds: memoryCandidates.map((candidate) => candidate.id),
  };
}
