import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { actionReceiptSchema, type ActionReceipt } from "../schemas/actionReceipt.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { DelegationReceiptWriteError } from "./errors.js";

export interface WriteDelegationReceiptInput {
  tenantId: string;
  parentWorkOrderId: string;
  childWorkOrderId: string;
  parentActorId: string;
  childActorId: string;
  delegationMode: "supervised" | "peer";
  /** Human-readable note on why the delegation happened -- not just the four IDs. */
  reason: string;
}

/**
 * Writes exactly one agent_delegated receipt, at the point a delegation is
 * created (the linked child WorkOrder already inserted). Direct-call
 * pattern, same as writeEloraReceipt.ts / writeBlockedReceipt.ts /
 * writeExecutionFailureReceipt.ts -- independent of transitionWorkOrder()'s
 * own gated receipt-writing. Persona-neutral: delegation is not an
 * ELORA-specific concept, so this lives in src/state/ alongside
 * createWorkOrder.ts/transitionWorkOrder.ts, not src/elora/.
 *
 * Phase 6D §6: finally exercises the agent_delegated receipt type, which
 * has existed in schema since Phase 1 and had never been written by any
 * production code path.
 */
export async function writeDelegationReceipt(input: WriteDelegationReceiptInput): Promise<ActionReceipt> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const idempotencyKey = buildIdempotencyKey([
      input.tenantId,
      input.parentWorkOrderId,
      input.childWorkOrderId,
      "receipt",
      "agent_delegated",
    ]);

    const parsedReceipt = actionReceiptSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      schema_version: 1,
      receipt_type: "agent_delegated",
      actor_id: input.parentActorId,
      acting_system: "core-delegation-v1",
      created_at: now,
      parent_receipt_id: null,
      supersedes_receipt_id: null,
      correction_receipt_id: null,
      payload: {
        parent_actor_id: input.parentActorId,
        child_actor_id: input.childActorId,
        work_order_id: input.childWorkOrderId,
        parent_work_order_id: input.parentWorkOrderId,
        delegation_mode: input.delegationMode,
        reason: input.reason,
      },
    });

    try {
      await client.query(
        `INSERT INTO action_receipts
           (id, tenant_id, schema_version, receipt_type, actor_id, acting_system, work_order_id,
            parent_receipt_id, supersedes_receipt_id, correction_receipt_id, payload, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          parsedReceipt.id,
          parsedReceipt.tenant_id,
          parsedReceipt.schema_version,
          parsedReceipt.receipt_type,
          parsedReceipt.actor_id,
          parsedReceipt.acting_system,
          input.childWorkOrderId,
          parsedReceipt.parent_receipt_id,
          parsedReceipt.supersedes_receipt_id,
          parsedReceipt.correction_receipt_id,
          JSON.stringify(parsedReceipt.payload),
          idempotencyKey,
          parsedReceipt.created_at,
        ],
      );
    } catch (error) {
      throw new DelegationReceiptWriteError(error instanceof Error ? error.message : String(error));
    }

    return parsedReceipt;
  });
}
