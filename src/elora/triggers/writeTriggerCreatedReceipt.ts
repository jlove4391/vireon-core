import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { actionReceiptSchema, type ActionReceipt } from "../../schemas/actionReceipt.js";
import type { ScheduledTrigger } from "../../schemas/scheduledTrigger.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import type { AuthorityOutcome } from "../../shared/runtimeTypes.js";
import { ScheduledTriggerReceiptWriteError } from "./errors.js";

export interface WriteTriggerCreatedReceiptInput {
  tenantId: string;
  trigger: ScheduledTrigger;
  authorityDecisionId: string;
  outcome: AuthorityOutcome;
}

/**
 * Writes exactly one trigger_created receipt, on the same tenant-scoped
 * client/transaction as the scheduled_triggers insert it documents (see
 * createScheduledTrigger.ts) -- both succeed or both roll back together,
 * same durability guarantee core-runtime.md 3.3 requires for any meaningful
 * state mutation and its receipt. Called only on the authorized branch;
 * there is no "trigger_creation_blocked" counterpart in this phase --
 * AuthorityDecision already carries the full accountability record for a
 * blocked attempt (see AGENTS.md's Receipt Rules / core-runtime.md 7.5),
 * and nothing was created for a blocked receipt to describe.
 */
export async function writeTriggerCreatedReceipt(
  client: PoolClient,
  input: WriteTriggerCreatedReceiptInput,
): Promise<ActionReceipt> {
  const now = new Date().toISOString();
  const idempotencyKey = buildIdempotencyKey([
    input.tenantId,
    input.trigger.id,
    "receipt",
    "trigger_created",
  ]);

  const parsedReceipt = actionReceiptSchema.parse({
    id: randomUUID(),
    tenant_id: input.tenantId,
    schema_version: 1,
    receipt_type: "trigger_created",
    actor_id: input.trigger.created_by_actor_id,
    acting_system: "elora-triggers-v1",
    created_at: now,
    parent_receipt_id: null,
    supersedes_receipt_id: null,
    correction_receipt_id: null,
    payload: {
      scheduled_trigger_id: input.trigger.id,
      owning_actor_id: input.trigger.owning_actor_id,
      schedule_kind: input.trigger.schedule_kind,
      outcome: input.outcome,
    },
  });

  let insertResult;
  try {
    insertResult = await client.query(
      `INSERT INTO action_receipts
         (id, tenant_id, schema_version, receipt_type, actor_id, acting_system,
          authority_decision_id, parent_receipt_id, supersedes_receipt_id, correction_receipt_id,
          payload, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        parsedReceipt.id,
        parsedReceipt.tenant_id,
        parsedReceipt.schema_version,
        parsedReceipt.receipt_type,
        parsedReceipt.actor_id,
        parsedReceipt.acting_system,
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
    throw new ScheduledTriggerReceiptWriteError(error instanceof Error ? error.message : String(error));
  }

  if (insertResult.rows.length > 0) {
    return parsedReceipt;
  }

  // Defense in depth (same reasoning as artifactWriteTool.ts's own guard):
  // createScheduledTrigger.ts's caller-side idempotency check should make
  // this unreachable in practice, but if it's ever reached, return the
  // receipt that actually exists rather than an id that was never
  // persisted.
  const existing = await client.query(
    "SELECT * FROM action_receipts WHERE tenant_id = $1 AND idempotency_key = $2",
    [input.tenantId, idempotencyKey],
  );
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
