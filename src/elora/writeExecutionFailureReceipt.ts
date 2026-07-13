import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { actionReceiptSchema, type ActionReceipt } from "../schemas/actionReceipt.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { EloraReceiptWriteError } from "./errors.js";

export interface WriteExecutionFailureReceiptInput {
  tenantId: string;
  workOrderId: string;
  runId: string;
  toolInvocationId: string | null;
  authorityDecisionId: string | null;
  actorId: string;
  failureType: string;
  failureMessage: string;
}

/**
 * Writes the run_failed receipt (§8.2) -- one of the original 11 types from
 * Phase 1/3's schema, dormant since it was defined, never used by anything
 * until now. Fired explicitly on EXECUTING -> FAILED, the one transition
 * the native VALIDATING -> RECEIPT_WRITTEN mechanism never reaches (a
 * failed invocation never gets to VALIDATING). Same direct-call pattern as
 * writeEloraReceipt.ts/writeBlockedReceipt.ts. Payload fields follow
 * core-runtime.md §16.6's list to the extent the existing (unmodified)
 * runFailedReceiptSchema payload shape supports -- run_id, failure_type,
 * failure_message. Work order reference and actor/system are already
 * covered by the receipt row's own top-level columns; "state at failure"
 * is recoverable from the transition history (FAILED); rollback status and
 * retry recommendation are not modeled as new payload fields here, since
 * extending a dormant Phase 1 schema contract wasn't explicitly scoped by
 * this phase.
 */
export async function writeExecutionFailureReceipt(input: WriteExecutionFailureReceiptInput): Promise<ActionReceipt> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const idempotencyKey = buildIdempotencyKey([input.tenantId, input.workOrderId, "receipt", "run_failed", input.runId]);

    const parsedReceipt = actionReceiptSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      schema_version: 1,
      receipt_type: "run_failed",
      actor_id: input.actorId,
      acting_system: "elora-v1",
      created_at: now,
      parent_receipt_id: null,
      supersedes_receipt_id: null,
      correction_receipt_id: null,
      payload: {
        run_id: input.runId,
        failure_type: input.failureType,
        failure_message: input.failureMessage,
      },
    });

    try {
      await client.query(
        `INSERT INTO action_receipts
           (id, tenant_id, schema_version, receipt_type, actor_id, acting_system, work_order_id, run_id,
            authority_decision_id, tool_invocation_id, parent_receipt_id, supersedes_receipt_id,
            correction_receipt_id, payload, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          parsedReceipt.id,
          parsedReceipt.tenant_id,
          parsedReceipt.schema_version,
          parsedReceipt.receipt_type,
          parsedReceipt.actor_id,
          parsedReceipt.acting_system,
          input.workOrderId,
          input.runId,
          input.authorityDecisionId,
          input.toolInvocationId,
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
