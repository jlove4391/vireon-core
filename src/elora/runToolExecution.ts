import { transitionWorkOrder } from "../state/transitionWorkOrder.js";
import type { WorkOrderStatus } from "../state/workOrderState.js";
import { invokeRegisteredTool } from "../tools/gateway.js";
import type { DispatchedToolCall } from "./dispatchTool.js";
import { proposeMemoryCandidates } from "./proposeMemoryCandidates.js";
import type { EloraAuthorityClassification, EloraStructuredIntent } from "./types.js";
import { writeExecutionFailureReceipt } from "./writeExecutionFailureReceipt.js";

export interface RunToolExecutionInput {
  tenantId: string;
  workOrderId: string;
  actorId: string;
  authorityDecisionId: string;
  workspaceId: string | null;
  projectId: string | null;
  threadId: string;
  sourceMessageId: string;
  correlationId: string;
  dispatched: DispatchedToolCall;
  intent: EloraStructuredIntent;
  authority: EloraAuthorityClassification;
}

export interface RunToolExecutionResult {
  finalStatus: WorkOrderStatus;
  transitionPath: WorkOrderStatus[];
  toolInvocationId: string | null;
  artifactId: string | null;
  responseText: string;
  memoryCandidateIds: string[];
}

/**
 * §8.1/§8.2: the execution-and-native-receipt sequence, using Phase 2's
 * existing gated transitions (EXECUTING auto-creates a `runs` row;
 * RECEIPT_WRITTEN auto-writes a `state_transitioned` action_receipt) rather
 * than writeEloraReceipt.ts. Zero modifications to transitionWorkOrder.ts
 * -- this is a pure consumer of its existing gated transitions, exactly as
 * Phase 3 was a pure consumer of workOrderState.ts.
 */
export async function runToolExecution(input: RunToolExecutionInput): Promise<RunToolExecutionResult> {
  const transitionPath: WorkOrderStatus[] = [];

  const executing = await transitionWorkOrder({
    tenantId: input.tenantId,
    workOrderId: input.workOrderId,
    nextStatus: "EXECUTING",
    actorId: input.actorId,
    reason: `Dispatching to registered tool "${input.dispatched.toolName}"`,
  });
  transitionPath.push(executing.workOrder.status);

  if (!executing.run) {
    throw new Error(`runToolExecution: EXECUTING transition for WorkOrder ${input.workOrderId} did not create a Run`);
  }
  const runId = executing.run.id;

  const invocation = await invokeRegisteredTool({
    toolName: input.dispatched.toolName,
    input: input.dispatched.input,
    context: {
      tenantId: input.tenantId,
      actorId: input.actorId,
      workspaceId: input.workspaceId ?? undefined,
      projectId: input.projectId ?? undefined,
      workOrderId: input.workOrderId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      authorityOutcome: input.authority.outcome === "act" ? "act" : "act_and_report",
      actingSystem: "elora-v1",
      correlationId: input.correlationId,
    },
  });

  if (invocation.status !== "succeeded") {
    const failed = await transitionWorkOrder({
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      nextStatus: "FAILED",
      actorId: input.actorId,
      reason: `Tool "${input.dispatched.toolName}" invocation failed: ${invocation.error?.message ?? "unknown error"}`,
    });
    transitionPath.push(failed.workOrder.status);

    await writeExecutionFailureReceipt({
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      runId,
      toolInvocationId: invocation.invocationId,
      authorityDecisionId: input.authorityDecisionId,
      actorId: input.actorId,
      failureType: invocation.error?.code ?? "TOOL_EXECUTION_FAILED",
      failureMessage: invocation.error?.message ?? "Tool invocation failed",
    });

    return {
      finalStatus: failed.workOrder.status,
      transitionPath,
      toolInvocationId: invocation.invocationId,
      artifactId: null,
      responseText: `I attempted to create the artifact, but the operation failed: ${invocation.error?.message ?? "unknown error"}`,
      memoryCandidateIds: [],
    };
  }

  const validating = await transitionWorkOrder({
    tenantId: input.tenantId,
    workOrderId: input.workOrderId,
    nextStatus: "VALIDATING",
    actorId: input.actorId,
    reason: "Execution complete, validating output",
  });
  transitionPath.push(validating.workOrder.status);

  // Native VALIDATING -> RECEIPT_WRITTEN transition auto-writes a
  // state_transitioned action_receipt as a side effect -- this is the
  // receipt for this path, not elora_ingestion_completed (§8.1).
  const receiptWritten = await transitionWorkOrder({
    tenantId: input.tenantId,
    workOrderId: input.workOrderId,
    nextStatus: "RECEIPT_WRITTEN",
    actorId: input.actorId,
    reason: "Validation complete, receipt recorded",
  });
  transitionPath.push(receiptWritten.workOrder.status);

  // Direct call, same three-branch scoping as Phase 3/4 -- not via
  // transitionWorkOrder()'s own gated RECEIPT_WRITTEN -> MEMORY_CANDIDATES_CREATED
  // writer (§8.1).
  const memoryCandidates = await proposeMemoryCandidates({
    tenantId: input.tenantId,
    workOrderId: input.workOrderId,
    intent: input.intent,
    authority: input.authority,
  });

  const completed = await transitionWorkOrder({
    tenantId: input.tenantId,
    workOrderId: input.workOrderId,
    nextStatus: "COMPLETED",
    actorId: input.actorId,
    reason: "Execution completed successfully",
  });
  transitionPath.push(completed.workOrder.status);

  const output = invocation.output as { artifactId?: string; relativePath?: string } | undefined;

  return {
    finalStatus: completed.workOrder.status,
    transitionPath,
    toolInvocationId: invocation.invocationId,
    artifactId: output?.artifactId ?? null,
    responseText: `I created the artifact "${output?.relativePath ?? "the requested file"}" and recorded it as a durable artifact.`,
    memoryCandidateIds: memoryCandidates.map((candidate) => candidate.id),
  };
}
