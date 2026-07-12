import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { actionReceiptSchema, type ActionReceipt } from "../schemas/actionReceipt.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { EloraReceiptWriteError } from "./errors.js";

export interface WriteEloraReceiptInput {
  tenantId: string;
  workOrderId: string;
  authorityDecisionId: string;
  actorId: string;
  responseText: string;
  retrievedMemoryIds: string[];
}

/**
 * Writes exactly one elora_ingestion_completed receipt. Called only on the
 * READY_TO_ACT branch (§7.1) -- every other branch's accountability need is
 * already met by the AuthorityDecision row (written on every
 * INTENT_PARSED -> AUTHORITY_CLASSIFIED transition) plus the transition
 * history. Written directly here, independent of transitionWorkOrder()'s
 * own gated receipt-writing, which only fires on execution-phase
 * transitions Phase 3 never reaches.
 */
export async function writeEloraReceipt(input: WriteEloraReceiptInput): Promise<ActionReceipt> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const idempotencyKey = buildIdempotencyKey([
      input.tenantId,
      input.workOrderId,
      "receipt",
      "elora_ingestion_completed",
    ]);

    const parsedReceipt = actionReceiptSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      schema_version: 1,
      receipt_type: "elora_ingestion_completed",
      actor_id: input.actorId,
      acting_system: "elora-v1",
      created_at: now,
      parent_receipt_id: null,
      supersedes_receipt_id: null,
      correction_receipt_id: null,
      payload: {
        work_order_id: input.workOrderId,
        response_summary: input.responseText.slice(0, 500),
        retrieved_memory_ids: input.retrievedMemoryIds,
      },
    });

    try {
      await client.query(
        `INSERT INTO action_receipts
           (id, tenant_id, schema_version, receipt_type, actor_id, acting_system, work_order_id,
            authority_decision_id, parent_receipt_id, supersedes_receipt_id, correction_receipt_id,
            payload, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          parsedReceipt.id,
          parsedReceipt.tenant_id,
          parsedReceipt.schema_version,
          parsedReceipt.receipt_type,
          parsedReceipt.actor_id,
          parsedReceipt.acting_system,
          input.workOrderId,
          input.authorityDecisionId,
          parsedReceipt.parent_receipt_id,
          parsedReceipt.supersedes_receipt_id,
          parsedReceipt.correction_receipt_id,
          JSON.stringify(parsedReceipt.payload),
          idempotencyKey,
          parsedReceipt.created_at,
        ],
      );
    } catch (error) {
      throw new EloraReceiptWriteError(error instanceof Error ? error.message : String(error));
    }

    return parsedReceipt;
  });
}
