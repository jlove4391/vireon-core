import { createHash, randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { workOrderSchema, type WorkOrder } from "../schemas/workOrder.js";
import { buildIdempotencyKey } from "../shared/ids.js";

export interface CreateWorkOrderInput {
  tenantId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  threadId: string;
  messageId: string;
  actorId: string;
  ownerActorId?: string | null;
  taskType: string;
  interpretedIntent?: string | null;
  /** Phase 6D: set only on a child WorkOrder created via delegation. */
  parentWorkOrderId?: string | null;
  /** Phase 6D: 'supervised' (vertical, delegator has real standing) or 'peer' (horizontal, no authority relationship). Null on every non-delegated WorkOrder. */
  delegationMode?: "supervised" | "peer" | null;
}

export interface WorkOrderStateTransitionRecord {
  id: string;
  tenant_id: string;
  work_order_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  reason: string;
  transition_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateWorkOrderResult {
  workOrder: WorkOrder;
  initialTransition: WorkOrderStateTransitionRecord;
}

function intentFingerprint(interpretedIntent: string | null | undefined): string {
  return createHash("sha256")
    .update(interpretedIntent ?? "")
    .digest("hex")
    .slice(0, 16);
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToWorkOrder(row: Record<string, unknown>): WorkOrder {
  return workOrderSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    owner_actor_id: row.owner_actor_id,
    task_type: row.task_type,
    interpreted_intent: row.interpreted_intent,
    status: row.status,
    idempotency_key: row.idempotency_key,
    authority_decision_id: row.authority_decision_id,
    created_at: toIso(row.created_at as string | Date),
    updated_at: toIso(row.updated_at as string | Date),
  });
}

function rowToTransition(row: Record<string, unknown>): WorkOrderStateTransitionRecord {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    work_order_id: row.work_order_id as string,
    from_status: row.from_status as string | null,
    to_status: row.to_status as string,
    actor_id: row.actor_id as string | null,
    reason: row.reason as string,
    transition_type: row.transition_type as string,
    metadata: row.metadata as Record<string, unknown>,
    created_at: toIso(row.created_at as string | Date),
  };
}

/**
 * Creates a WorkOrder in RECEIVED status and its initial NULL -> RECEIVED
 * transition row atomically in one tenant-scoped transaction. Idempotency
 * key derivation follows ELORA.md 9.1: tenant_id, thread_id, message_id,
 * actor_id, task type, and an intent fingerprint.
 *
 * Uses insert-or-fetch on the WorkOrder's (tenant_id, idempotency_key)
 * unique constraint. On a fetched-existing conflict, the pre-existing
 * initial transition row is returned rather than inserting a second one.
 */
export async function createWorkOrder(input: CreateWorkOrderInput): Promise<CreateWorkOrderResult> {
  const idempotencyKey = buildIdempotencyKey([
    input.tenantId,
    input.threadId,
    input.messageId,
    input.actorId,
    input.taskType,
    intentFingerprint(input.interpretedIntent),
  ]);

  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const candidateId = randomUUID();
    const ownerActorId = input.ownerActorId ?? input.actorId;

    const insertResult = await client.query(
      `INSERT INTO work_orders
         (id, tenant_id, workspace_id, project_id, thread_id, message_id, owner_actor_id,
          task_type, interpreted_intent, status, idempotency_key, created_at, updated_at,
          parent_work_order_id, delegation_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIVED',$10,$11,$11,$12,$13)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        candidateId,
        input.tenantId,
        input.workspaceId ?? null,
        input.projectId ?? null,
        input.threadId,
        input.messageId,
        ownerActorId,
        input.taskType,
        input.interpretedIntent ?? null,
        idempotencyKey,
        now,
        input.parentWorkOrderId ?? null,
        input.delegationMode ?? null,
      ],
    );

    if (insertResult.rows.length > 0) {
      const workOrderRow = insertResult.rows[0] as Record<string, unknown>;
      const transitionInsert = await client.query(
        `INSERT INTO work_order_state_transitions
           (id, tenant_id, work_order_id, from_status, to_status, actor_id, reason, transition_type, metadata, created_at)
         VALUES ($1,$2,$3,NULL,'RECEIVED',$4,$5,'state_change','{}'::jsonb,$6)
         RETURNING *`,
        [randomUUID(), input.tenantId, workOrderRow.id, input.actorId, "WorkOrder created", now],
      );

      return {
        workOrder: rowToWorkOrder(workOrderRow),
        initialTransition: rowToTransition(transitionInsert.rows[0] as Record<string, unknown>),
      };
    }

    const existingWorkOrderResult = await client.query(
      "SELECT * FROM work_orders WHERE tenant_id = $1 AND idempotency_key = $2",
      [input.tenantId, idempotencyKey],
    );
    const existingWorkOrderRow = existingWorkOrderResult.rows[0] as Record<string, unknown>;

    const existingTransitionResult = await client.query(
      `SELECT * FROM work_order_state_transitions
       WHERE tenant_id = $1 AND work_order_id = $2 AND from_status IS NULL
       ORDER BY created_at ASC
       LIMIT 1`,
      [input.tenantId, existingWorkOrderRow.id],
    );

    return {
      workOrder: rowToWorkOrder(existingWorkOrderRow),
      initialTransition: rowToTransition(existingTransitionResult.rows[0] as Record<string, unknown>),
    };
  });
}
