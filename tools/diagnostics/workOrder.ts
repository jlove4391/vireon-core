import { readOnlyTenantQuery } from "./readOnlyTenantQuery.js";

export interface WorkOrderRow {
  id: string;
  tenant_id: string;
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
