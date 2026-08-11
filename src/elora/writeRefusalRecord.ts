import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { actionReceiptSchema, type ActionReceipt } from "../schemas/actionReceipt.js";
import { authorityDecisionSchema, type AuthorityDecision } from "../schemas/authorityDecision.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { classifyAuthority } from "./classifyAuthority.js";
import { EloraReceiptWriteError } from "./errors.js";

export interface WriteRefusalRecordInput {
  tenantId: string;
  messageId: string;
  actorId: string;
  content: string;
  responseText: string;
}

export interface WriteRefusalRecordResult {
  authorityDecision: AuthorityDecision;
  actionReceipt: ActionReceipt;
}

/**
 * ADR 0008 Realignment A follow-up: a refused conversational request still
 * gets a real, governed audit trail -- AuthorityDecision (outcome: refuse)
 * -> ActionReceipt (elora_request_blocked) -- written directly here, with
 * no WorkOrder involved at all. work_order_id is nullable on both
 * authority_decisions and action_receipts at the database level
 * specifically for this: a governed record that never needed durable-work
 * tracking. Not the same code path as writeBlockedReceipt.ts, which is
 * WorkOrder-owned (requires a real workOrderId) and stays exactly as it
 * was for the four WorkOrder-pipeline blocked branches
 * (escalate/setup_required/capability_missing/refuse-via-isSystemInitiated,
 * i.e. a system-initiated durable_work trigger that also happens to match
 * REFUSE_CUE).
 *
 * classifyAuthority() is called again here (resolveEloraRoute.ts already
 * used REFUSE_CUE to decide the route) so the AuthorityDecision's
 * reason/risk_level/requires_human_gatekeeper come from the one canonical
 * place that owns those values, rather than duplicating them.
 *
 * The conversational reply itself is untouched by this function -- it was
 * already produced by runConversationalCognitiveRun.ts before this is
 * called; this only adds the governance record alongside it.
 */
export async function writeRefusalRecord(input: WriteRefusalRecordInput): Promise<WriteRefusalRecordResult> {
  const classification = classifyAuthority({ content: input.content, taskType: "unknown", resolvedProjectId: null });

  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();

    const parsedDecision = authorityDecisionSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      schema_version: 1,
      outcome: "refuse",
      requires_human_gatekeeper: classification.requires_human_gatekeeper,
      reason: classification.reason,
      risk_level: classification.risk_level,
      deciding_actor_id: input.actorId,
      work_order_id: null,
      run_id: null,
      tool_invocation_id: null,
      required_setup: null,
      resolved_via_standing_rule_id: null,
      created_at: now,
    });

    try {
      await client.query(
        `INSERT INTO authority_decisions
           (id, tenant_id, schema_version, outcome, requires_human_gatekeeper, reason,
            risk_level, deciding_actor_id, work_order_id, required_setup,
            resolved_via_standing_rule_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          parsedDecision.id,
          parsedDecision.tenant_id,
          parsedDecision.schema_version,
          parsedDecision.outcome,
          parsedDecision.requires_human_gatekeeper,
          parsedDecision.reason,
          parsedDecision.risk_level,
          parsedDecision.deciding_actor_id,
          parsedDecision.work_order_id,
          parsedDecision.required_setup,
          parsedDecision.resolved_via_standing_rule_id,
          parsedDecision.created_at,
        ],
      );
    } catch (error) {
      throw new EloraReceiptWriteError(error instanceof Error ? error.message : String(error));
    }

    const idempotencyKey = buildIdempotencyKey([input.tenantId, input.messageId, "receipt", "elora_request_blocked"]);
    const parsedReceipt = actionReceiptSchema.parse({
      id: randomUUID(),
      tenant_id: input.tenantId,
      schema_version: 1,
      receipt_type: "elora_request_blocked",
      actor_id: input.actorId,
      acting_system: "elora-v1",
      created_at: now,
      parent_receipt_id: null,
      supersedes_receipt_id: null,
      correction_receipt_id: null,
      payload: {
        work_order_id: null,
        response_summary: input.responseText.slice(0, 500),
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
          null,
          parsedDecision.id,
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

    return { authorityDecision: parsedDecision, actionReceipt: parsedReceipt };
  });
}
