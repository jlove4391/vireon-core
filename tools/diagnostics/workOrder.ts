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

const TERMINAL_RECEIPT_TYPES = new Set(["elora_ingestion_completed", "elora_request_blocked"]);

export interface InspectableReceipt {
  receiptId: string;
  workOrderId: string;

  originalRequest: {
    messageId: string;
    content: string;
    createdAt: string;
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

  /** Always empty in Phase 4 -- tool_invocations has never been written to by anything (§5/§2). Not a placeholder; this is correct. */
  toolsUsed: [];

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

  let originalRequest: InspectableReceipt["originalRequest"] = null;
  if (detail.workOrder.message_id) {
    originalRequest = await readOnlyTenantQuery(
      async (client) => {
        const result = await client.query("SELECT id, content, created_at FROM messages WHERE id = $1 AND tenant_id = $2", [
          detail.workOrder.message_id,
          tenantId,
        ]);
        const row = result.rows[0] as { id: string; content: string; created_at: string | Date } | undefined;
        if (!row) return null;
        return {
          messageId: row.id,
          content: redactSecretLikeValues(row.content),
          createdAt: toIso(row.created_at) as string,
        };
      },
      { tenantId },
    );
  }

  const outcome = detail.authorityDecision?.outcome ?? "act_and_report";
  const reasonCode = detail.authorityDecision
    ? AUTHORITY_OUTCOME_TO_REASON_CODE[authorityOutcomeSchema.parse(detail.authorityDecision.outcome)]
    : undefined;

  const responseSummary = (receipt.payload.response_summary as string | undefined) ?? "";

  return {
    receiptId: receipt.id,
    workOrderId: detail.workOrder.id,
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
    toolsUsed: [],
    stateTransitions: detail.transitions.map((t) => ({
      from: t.from_status ?? undefined,
      to: t.to_status,
      createdAt: t.created_at,
    })),
    outputs: [
      {
        type: receipt.receipt_type === "elora_ingestion_completed" ? "direct_answer" : "blocked_explanation",
        content: redactSecretLikeValues(responseSummary),
      },
    ],
    errors: [],
    memoryCandidates: detail.memoryCandidates.map((c) => ({
      id: c.id,
      status: c.review_status,
      summary: c.candidate_content.slice(0, 200),
    })),
    followUpTasks: deriveFollowUpTasks(outcome, detail.authorityDecision?.required_setup ?? null),
  };
}
