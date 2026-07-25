import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { actionReceiptSchema, type ActionReceipt } from "../../schemas/actionReceipt.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import { ScheduledTriggerReceiptWriteError } from "./errors.js";

export interface WriteTriggerFireSkippedReceiptInput {
  tenantId: string;
  scheduledTriggerId: string;
  owningActorId: string;
  createdByActorId: string;
  reason: "ownership_unauthorized" | "owner_not_elora";
  /** ISO string -- the occurrence (trigger.next_fire_at at read time) that was declined. */
  occurrenceTimestamp: string;
}

/**
 * Writes exactly one trigger_fire_skipped receipt per (trigger, occurrence)
 * -- a stuck/blocked trigger re-evaluated on every subsequent poll cycle
 * (its next_fire_at never advances if it never actually fires) produces
 * exactly one receipt for that occurrence, not one per poll cycle,
 * because the idempotency key is derived from the occurrence itself, not
 * from when the poller happened to notice it. No work_order_id / receipt
 * has no authority_decision_id either: nothing was created on this branch
 * -- it's a rejection before ingestUserMessage() is ever called.
 */
export async function writeTriggerFireSkippedReceipt(
  client: PoolClient,
  input: WriteTriggerFireSkippedReceiptInput,
): Promise<ActionReceipt> {
  const now = new Date().toISOString();
  const idempotencyKey = buildIdempotencyKey([
    input.tenantId,
    input.scheduledTriggerId,
    input.occurrenceTimestamp,
    "receipt",
    "trigger_fire_skipped",
  ]);

  const parsedReceipt = actionReceiptSchema.parse({
    id: randomUUID(),
    tenant_id: input.tenantId,
    schema_version: 1,
    receipt_type: "trigger_fire_skipped",
    actor_id: input.createdByActorId,
    acting_system: "elora-triggers-v1",
    created_at: now,
    parent_receipt_id: null,
    supersedes_receipt_id: null,
    correction_receipt_id: null,
    payload: {
      scheduled_trigger_id: input.scheduledTriggerId,
      owning_actor_id: input.owningActorId,
      created_by_actor_id: input.createdByActorId,
      reason: input.reason,
      occurrence_timestamp: input.occurrenceTimestamp,
    },
  });

  let insertResult;
  try {
    insertResult = await client.query(
      `INSERT INTO action_receipts
         (id, tenant_id, schema_version, receipt_type, actor_id, acting_system,
          parent_receipt_id, supersedes_receipt_id, correction_receipt_id,
          payload, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        parsedReceipt.id,
        parsedReceipt.tenant_id,
        parsedReceipt.schema_version,
        parsedReceipt.receipt_type,
        parsedReceipt.actor_id,
        parsedReceipt.acting_system,
        parsedReceipt.parent_receipt_id,
        parsedReceipt.supersedes_receipt_id,
        parsedReceipt.correction_receipt_id,
        JSON.stringify(parsedReceipt.payload),
        idempotencyKey,
        parsedReceipt.created_at,
      ],
    );
  } catch (error) {
    throw new ScheduledTriggerReceiptWriteError(error instanceof Error ? error.message : String(error));
  }

  if (insertResult.rows.length > 0) {
    return parsedReceipt;
  }

  const existing = await client.query("SELECT * FROM action_receipts WHERE tenant_id = $1 AND idempotency_key = $2", [
    input.tenantId,
    idempotencyKey,
  ]);
  const existingRow = existing.rows[0] as Record<string, unknown>;
  return actionReceiptSchema.parse({
    id: existingRow.id,
    tenant_id: existingRow.tenant_id,
    schema_version: existingRow.schema_version,
    receipt_type: existingRow.receipt_type,
    actor_id: existingRow.actor_id,
    acting_system: existingRow.acting_system,
    created_at:
      existingRow.created_at instanceof Date ? existingRow.created_at.toISOString() : existingRow.created_at,
    parent_receipt_id: existingRow.parent_receipt_id,
    supersedes_receipt_id: existingRow.supersedes_receipt_id,
    correction_receipt_id: existingRow.correction_receipt_id,
    payload: existingRow.payload,
  });
}
