import { AUTHORITY_OUTCOME_TO_REASON_CODE } from "../../src/elora/types.js";
import { authorityOutcomeSchema } from "../../src/shared/runtimeTypes.js";
import { readOnlyTenantQuery } from "./readOnlyTenantQuery.js";
import { redactSecretLikeValues } from "./sanitizeReceipt.js";

export interface WorkOrderRow {
  id: string;
  tenant_id: string;
  message_id: string | null;
  status: string;
  task_type: string;
  interpreted_intent: string | null;
  idempotency_key: string;
  authority_decision_id: string | null;
  created_at: string;
  updated_at: string;
  /** Phase 6D: set only on a WorkOrder created via delegation. */
  parent_work_order_id: string | null;
  delegation_mode: string | null;
}

export interface TransitionRow {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  reason: string;
  created_at: string;
}

export interface AuthorityDecisionRow {
  id: string;
  outcome: string;
  requires_human_gatekeeper: boolean;
  reason: string | null;
  risk_level: string | null;
  required_setup: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  status: string;
  attempt_number: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface ActionReceiptRow {
  id: string;
  receipt_type: string;
  schema_version: number;
  actor_id: string;
  acting_system: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface MemoryCandidateRow {
  id: string;
  candidate_content: string;
  candidate_type: string | null;
  review_status: string;
  created_at: string;
}

export interface WorkOrderDetail {
  workOrder: WorkOrderRow;
  transitions: TransitionRow[];
  authorityDecision: AuthorityDecisionRow | null;
  runs: RunRow[];
  actionReceipts: ActionReceiptRow[];
  memoryCandidates: MemoryCandidateRow[];
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Full lifecycle view of one WorkOrder: core fields, complete transition
 * history (chronological), and every linked substantiating record. Returns
 * null when no WorkOrder with that id exists for the given tenant --
 * whether because it truly doesn't exist or because RLS hides a different
 * tenant's row are indistinguishable from here by design (Decision 2).
 */
export async function getWorkOrderDetail(tenantId: string, workOrderId: string): Promise<WorkOrderDetail | null> {
  return readOnlyTenantQuery(
    async (client) => {
      const workOrderResult = await client.query("SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2", [
        workOrderId,
        tenantId,
      ]);
      const workOrderRow = workOrderResult.rows[0] as Record<string, unknown> | undefined;
      if (!workOrderRow) {
        return null;
      }

      const transitionsResult = await client.query(
        `SELECT * FROM work_order_state_transitions
         WHERE tenant_id = $1 AND work_order_id = $2
         ORDER BY created_at ASC`,
        [tenantId, workOrderId],
      );

      let authorityDecision: AuthorityDecisionRow | null = null;
      if (workOrderRow.authority_decision_id) {
        const authorityResult = await client.query(
          "SELECT * FROM authority_decisions WHERE id = $1 AND tenant_id = $2",
          [workOrderRow.authority_decision_id, tenantId],
        );
        const authorityRow = authorityResult.rows[0] as Record<string, unknown> | undefined;
        if (authorityRow) {
          authorityDecision = {
            id: authorityRow.id as string,
            outcome: authorityRow.outcome as string,
            requires_human_gatekeeper: authorityRow.requires_human_gatekeeper as boolean,
            reason: authorityRow.reason as string | null,
            risk_level: authorityRow.risk_level as string | null,
            required_setup: authorityRow.required_setup as string | null,
            created_at: toIso(authorityRow.created_at as string | Date) as string,
          };
        }
      }

      const runsResult = await client.query(
        "SELECT * FROM runs WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC",
        [tenantId, workOrderId],
      );

      const receiptsResult = await client.query(
        "SELECT * FROM action_receipts WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC",
        [tenantId, workOrderId],
      );

      const candidatesResult = await client.query(
        "SELECT * FROM memory_candidates WHERE tenant_id = $1 AND source_work_order_id = $2 ORDER BY created_at ASC",
        [tenantId, workOrderId],
      );

      return {
        workOrder: {
          id: workOrderRow.id as string,
          tenant_id: workOrderRow.tenant_id as string,
          message_id: workOrderRow.message_id as string | null,
          status: workOrderRow.status as string,
          task_type: workOrderRow.task_type as string,
          interpreted_intent: workOrderRow.interpreted_intent as string | null,
          idempotency_key: workOrderRow.idempotency_key as string,
          authority_decision_id: workOrderRow.authority_decision_id as string | null,
          created_at: toIso(workOrderRow.created_at as string | Date) as string,
          updated_at: toIso(workOrderRow.updated_at as string | Date) as string,
          parent_work_order_id: workOrderRow.parent_work_order_id as string | null,
          delegation_mode: workOrderRow.delegation_mode as string | null,
        },
        transitions: transitionsResult.rows.map((row) => ({
          id: row.id as string,
          from_status: row.from_status as string | null,
          to_status: row.to_status as string,
          actor_id: row.actor_id as string | null,
          reason: row.reason as string,
          created_at: toIso(row.created_at as string | Date) as string,
        })),
        authorityDecision,
        runs: runsResult.rows.map((row) => ({
          id: row.id as string,
          status: row.status as string,
          attempt_number: row.attempt_number as number,
          started_at: toIso(row.started_at as string | Date | null),
          ended_at: toIso(row.ended_at as string | Date | null),
          created_at: toIso(row.created_at as string | Date) as string,
        })),
        actionReceipts: receiptsResult.rows.map((row) => ({
          id: row.id as string,
          receipt_type: row.receipt_type as string,
          schema_version: row.schema_version as number,
          actor_id: row.actor_id as string,
          acting_system: row.acting_system as string,
          payload: row.payload as Record<string, unknown>,
          created_at: toIso(row.created_at as string | Date) as string,
        })),
        memoryCandidates: candidatesResult.rows.map((row) => ({
          id: row.id as string,
          candidate_content: row.candidate_content as string,
          candidate_type: row.candidate_type as string | null,
          review_status: row.review_status as string,
          created_at: toIso(row.created_at as string | Date) as string,
        })),
      };
    },
    { tenantId },
  );
}

// =============================================================================
// Phase 4 §4.3/§8: read-time receipt reconstruction. InspectableReceipt is a
// read model assembled from existing durable records (work_orders, messages,
// work_order_state_transitions, authority_decisions, action_receipts,
// memory_candidates) -- not a new denormalized mutable table.
// action_receipts remains the durable receipt anchor.
// =============================================================================

// Phase 5 §8.1/§8.2 added two more terminal receipt types alongside Phase
// 3/4's elora_ingestion_completed / elora_request_blocked:
// state_transitioned (the native VALIDATING -> RECEIPT_WRITTEN receipt,
// written for the tool-execution success path) and run_failed (written for
// the tool-execution failure path). Currently the only source of either
// type is Phase 5's execution flow -- if a future phase writes
// state_transitioned/run_failed receipts for an unrelated purpose, a
// WorkOrder could carry more than one "terminal" candidate and this
// .find() would need revisiting.
const TERMINAL_RECEIPT_TYPES = new Set([
  "elora_ingestion_completed",
  "elora_request_blocked",
  "state_transitioned",
  "run_failed",
]);

export interface InspectableReceipt {
  receiptId: string;
  workOrderId: string;

  /**
   * Phase 6D: set only when this WorkOrder was created via delegation
   * (work_orders.parent_work_order_id). Null on every ordinary WorkOrder.
   * A delegated child correctly reuses its parent's thread/message --
   * "context inheritance by reference" per core-runtime.md §11.2 -- so
   * this is the signal that originalRequest below, if present, belongs to
   * the parent, not this WorkOrder's own request.
   */
  delegatedFrom: {
    parentWorkOrderId: string;
    delegationMode: string | null;
  } | null;

  originalRequest: {
    messageId: string;
    content: string;
    createdAt: string;
    /**
     * Phase 6D: true when this WorkOrder is a delegated child. The message
     * shown here is the parent's original user request, inherited by
     * reference, not a request this WorkOrder itself received -- never
     * present it as the child's own without this label. interpretedIntent
     * below is the primary "what is this about" signal for a delegated
     * child (see AUTHORITY_AND_DELEGATION.md's delegated-child-identity
     * note); this field is supplementary context, clearly attributed.
     */
    inheritedFromParent: boolean;
  } | null;

  /**
   * task_type/summary are all Phase 3's schema durably persists on
   * work_orders (task_type, interpreted_intent). The full EloraStructuredIntent
   * computed during ingestion (intent_type, confidence, requires_clarification)
   * is never written to a durable record -- it exists only transiently in
   * ingestUserMessage.ts's return value -- so it cannot be reconstructed
   * here. This reflects only what's actually persisted, not the full
   * original object.
   */
  interpretedIntent: {
    summary: string | null;
    structuredIntent: unknown;
  };

  actingSystem: {
    name: string;
    component?: string;
  };

  authorityDecision: {
    outcome: string;
    reason: string | null;
    reasonCode: string;
  };

  /**
   * Phase 5 §14: genuine query against tool_invocations, not a hardcoded
   * literal. Truthfulness rule (§14, unchanged): only calls made through
   * the registered invocation gateway ever appear here -- ordinary
   * function calls, repository methods, database writes, or any of the
   * Phase 3/4 direct-call functions excluded from the registry (§4) are
   * never inferred as tool usage.
   */
  toolsUsed: Array<{
    invocationId: string;
    toolName: string;
    toolVersion: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    outputReference?: { type: "artifact"; id: string };
    error?: { code?: string; message: string };
  }>;

  stateTransitions: Array<{
    from?: string;
    to: string;
    createdAt: string;
  }>;

  outputs: Array<{
    type: string;
    content?: string;
    referenceId?: string;
  }>;

  /** Always empty in Phase 4 -- no error-record persistence exists for any of the deterministic authority branches. */
  errors: Array<{
    code?: string;
    message: string;
  }>;

  memoryCandidates: Array<{
    id: string;
    status?: string;
    summary?: string;
  }>;

  followUpTasks: Array<{
    type: string;
    description: string;
    requiredAction?: string;
  }>;
}

/**
 * Follow-up tasks are deterministic receipt-projection objects derived
 * purely from the outcome + required_setup already persisted on the
 * AuthorityDecision (§10) -- not a persisted task-management entity. No
 * follow-up task is ever claimed to be scheduled or assigned, because none
 * is, in Phase 4.
 */
function deriveFollowUpTasks(
  outcome: string,
  requiredSetup: string | null,
): InspectableReceipt["followUpTasks"] {
  switch (outcome) {
    case "escalate":
      return [{ type: "authorization", description: "Obtain authorization before execution can continue." }];
    case "setup_required":
      return [
        {
          type: "configuration",
          description: "Complete the required system setup.",
          requiredAction: requiredSetup ?? undefined,
        },
      ];
    case "capability_missing":
      return [{ type: "capability", description: "Implement or connect the missing capability." }];
    default:
      return [];
  }
}

/**
 * Assembles the full InspectableReceipt for a WorkOrder's terminal receipt
 * (whichever of elora_ingestion_completed / elora_request_blocked was
 * written). Returns null when the WorkOrder doesn't resolve for this tenant
 * (same RLS-opaque behavior as getWorkOrderDetail) or when no terminal
 * receipt has been written yet -- there is nothing to inspect before that.
 * Built on top of getWorkOrderDetail() rather than duplicating its queries
 * (extend, not replace -- §4.3).
 */
export async function getInspectableReceipt(tenantId: string, workOrderId: string): Promise<InspectableReceipt | null> {
  const detail = await getWorkOrderDetail(tenantId, workOrderId);
  if (!detail) {
    return null;
  }

  const receipt = detail.actionReceipts.find((r) => TERMINAL_RECEIPT_TYPES.has(r.receipt_type));
  if (!receipt) {
    return null;
  }

  const delegatedFrom: InspectableReceipt["delegatedFrom"] = detail.workOrder.parent_work_order_id
    ? {
        parentWorkOrderId: detail.workOrder.parent_work_order_id,
        delegationMode: detail.workOrder.delegation_mode,
      }
    : null;

  let originalRequest: InspectableReceipt["originalRequest"] = null;
  if (detail.workOrder.message_id) {
    const messageRow = await readOnlyTenantQuery(
      async (client) => {
        const result = await client.query("SELECT id, content, created_at FROM messages WHERE id = $1 AND tenant_id = $2", [
          detail.workOrder.message_id,
          tenantId,
        ]);
        return result.rows[0] as { id: string; content: string; created_at: string | Date } | undefined;
      },
      { tenantId },
    );
    if (messageRow) {
      originalRequest = {
        messageId: messageRow.id,
        content: redactSecretLikeValues(messageRow.content),
        createdAt: toIso(messageRow.created_at) as string,
        // Phase 6D: a delegated child WorkOrder reuses its parent's
        // thread/message by reference (core-runtime.md §11.2), so this
        // content is never the child's own request when delegatedFrom is set.
        inheritedFromParent: delegatedFrom !== null,
      };
    }
  }

  const outcome = detail.authorityDecision?.outcome ?? "act_and_report";
  const reasonCode = detail.authorityDecision
    ? AUTHORITY_OUTCOME_TO_REASON_CODE[authorityOutcomeSchema.parse(detail.authorityDecision.outcome)]
    : undefined;

  // Phase 5 §14: genuine query against tool_invocations, tenant-scoped,
  // same join-by-work_order_id pattern already used for
  // action_receipts/memory_candidates inside getWorkOrderDetail().
  const toolInvocationRows = await readOnlyTenantQuery(
    async (client) => {
      const result = await client.query(
        `SELECT id, tool_identifier, tool_version, status, output_payload, error_payload, created_at, completed_at
         FROM tool_invocations WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC`,
        [tenantId, workOrderId],
      );
      return result.rows as Record<string, unknown>[];
    },
    { tenantId },
  );

  const toolsUsed: InspectableReceipt["toolsUsed"] = toolInvocationRows.map((row) => {
    const outputPayload = row.output_payload as { artifactId?: string } | null;
    const errorPayload = row.error_payload as { code?: string; message: string } | null;
    return {
      invocationId: row.id as string,
      toolName: row.tool_identifier as string,
      toolVersion: row.tool_version as string,
      status: row.status as string,
      startedAt: toIso(row.created_at as string | Date) as string,
      completedAt: row.completed_at ? (toIso(row.completed_at as string | Date) as string) : undefined,
      outputReference: outputPayload?.artifactId ? { type: "artifact", id: outputPayload.artifactId } : undefined,
      error: errorPayload ? { code: errorPayload.code, message: redactSecretLikeValues(errorPayload.message) } : undefined,
    };
  });

  // Output/error projection varies by which terminal receipt type this is
  // (§8.1/§8.2 added state_transitioned/run_failed alongside Phase 3/4's
  // ELORA-authored receipt types, and neither carries a response_summary
  // payload field the way elora_ingestion_completed/elora_request_blocked do).
  let outputs: InspectableReceipt["outputs"] = [];
  let errors: InspectableReceipt["errors"] = [];

  if (receipt.receipt_type === "elora_ingestion_completed" || receipt.receipt_type === "elora_request_blocked") {
    const responseSummary = (receipt.payload.response_summary as string | undefined) ?? "";
    outputs = [
      {
        type: receipt.receipt_type === "elora_ingestion_completed" ? "direct_answer" : "blocked_explanation",
        content: redactSecretLikeValues(responseSummary),
      },
    ];
  } else if (receipt.receipt_type === "state_transitioned") {
    const artifactRow = await readOnlyTenantQuery(
      async (client) => {
        const result = await client.query(
          "SELECT id, storage_reference, mime_type, byte_count FROM artifacts WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at DESC LIMIT 1",
          [tenantId, workOrderId],
        );
        return result.rows[0] as Record<string, unknown> | undefined;
      },
      { tenantId },
    );
    if (artifactRow) {
      outputs = [
        {
          type: "artifact_created",
          content: `${artifactRow.storage_reference as string} (${artifactRow.byte_count as number} bytes, ${artifactRow.mime_type as string})`,
          referenceId: artifactRow.id as string,
        },
      ];
    }
  } else if (receipt.receipt_type === "run_failed") {
    const payload = receipt.payload as { failure_type?: string; failure_message?: string };
    errors = [
      {
        code: payload.failure_type,
        message: redactSecretLikeValues(payload.failure_message ?? "Execution failed"),
      },
    ];
  }

  return {
    receiptId: receipt.id,
    workOrderId: detail.workOrder.id,
    delegatedFrom,
    originalRequest,
    interpretedIntent: {
      summary: detail.workOrder.interpreted_intent,
      structuredIntent: {
        task_type: detail.workOrder.task_type,
      },
    },
    actingSystem: {
      name: receipt.acting_system,
    },
    authorityDecision: {
      outcome,
      reason: detail.authorityDecision?.reason ?? null,
      reasonCode: reasonCode ?? AUTHORITY_OUTCOME_TO_REASON_CODE.act_and_report,
    },
    toolsUsed,
    stateTransitions: detail.transitions.map((t) => ({
      from: t.from_status ?? undefined,
      to: t.to_status,
      createdAt: t.created_at,
    })),
    outputs,
    errors,
    memoryCandidates: detail.memoryCandidates.map((c) => ({
      id: c.id,
      status: c.review_status,
      summary: c.candidate_content.slice(0, 200),
    })),
    followUpTasks: deriveFollowUpTasks(outcome, detail.authorityDecision?.required_setup ?? null),
  };
}
