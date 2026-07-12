import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { actionReceiptSchema, type ActionReceipt } from "../schemas/actionReceipt.js";
import { authorityDecisionSchema, type AuthorityDecision } from "../schemas/authorityDecision.js";
import { memoryCandidateSchema, type MemoryCandidate } from "../schemas/memoryCandidate.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import type { WorkOrderStateTransitionRecord } from "./createWorkOrder.js";
import {
  AuthorityOutcomeMismatchError,
  TenantScopeViolationError,
  WorkOrderNotFoundError,
} from "./errors.js";
import {
  AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS,
  assertValidWorkOrderTransition,
  WorkOrderStatusSchema,
  type WorkOrderStatus,
} from "./workOrderState.js";

export interface AuthorityDecisionSubstantiatingInput {
  outcome: AuthorityOutcome;
  requiresHumanGatekeeper: boolean;
  reason?: string | null;
  riskLevel?: string | null;
  decidingActorId?: string | null;
  requiredSetup?: string | null;
}

export interface MemoryCandidateSubstantiatingInput {
  candidateContent: string;
  candidateType?: string | null;
  confidence?: number | null;
  scope?: string | null;
  reasonForCreation?: string | null;
}

export interface TransitionWorkOrderInput {
  tenantId: string;
  workOrderId: string;
  nextStatus: WorkOrderStatus;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
  /** Required when transitioning INTENT_PARSED -> AUTHORITY_CLASSIFIED. */
  authorityDecision?: AuthorityDecisionSubstantiatingInput;
  /** Required when transitioning RECEIPT_WRITTEN -> MEMORY_CANDIDATES_CREATED. */
  memoryCandidate?: MemoryCandidateSubstantiatingInput;
}

export interface TransitionWorkOrderResult {
  workOrder: { id: string; tenant_id: string; status: WorkOrderStatus; authority_decision_id: string | null };
  transition: WorkOrderStateTransitionRecord;
  authorityDecision?: AuthorityDecision;
  run?: { id: string; tenant_id: string; work_order_id: string; status: string };
  actionReceipt?: ActionReceipt;
  memoryCandidate?: MemoryCandidate;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function lockWorkOrder(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    "SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [workOrderId, tenantId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new WorkOrderNotFoundError(workOrderId);
  }
  return row;
}

async function mostRecentRun(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  forUpdate: boolean,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.query(
    `SELECT * FROM runs WHERE tenant_id = $1 AND work_order_id = $2
     ORDER BY created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, workOrderId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

/**
 * Runs the WorkOrder transition sequence inside a single tenant-scoped
 * transaction: lock -> validate -> substantiate -> update status ->
 * record transition -> (test-only) inject failure -> commit.
 */
async function runTransition(
  input: TransitionWorkOrderInput,
  options: { injectFailureAfterTransitionInsert: boolean },
): Promise<TransitionWorkOrderResult> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const now = new Date().toISOString();
    const workOrderRow = await lockWorkOrder(client, input.tenantId, input.workOrderId);
    const currentStatus = WorkOrderStatusSchema.parse(workOrderRow.status);

    assertValidWorkOrderTransition(input.workOrderId, currentStatus, input.nextStatus);

    let authorityDecision: AuthorityDecision | undefined;
    let newAuthorityDecisionId: string | null = null;
    let run: Record<string, unknown> | undefined;
    let actionReceipt: ActionReceipt | undefined;
    let memoryCandidate: MemoryCandidate | undefined;

    if (currentStatus === "INTENT_PARSED" && input.nextStatus === "AUTHORITY_CLASSIFIED") {
      if (!input.authorityDecision) {
        throw new Error(
          "transitionWorkOrder: authorityDecision input is required for INTENT_PARSED -> AUTHORITY_CLASSIFIED",
        );
      }
      const decisionInput = input.authorityDecision;
      const decisionId = randomUUID();
      const parsedDecision = authorityDecisionSchema.parse({
        id: decisionId,
        tenant_id: input.tenantId,
        schema_version: 1,
        outcome: decisionInput.outcome,
        requires_human_gatekeeper: decisionInput.requiresHumanGatekeeper,
        reason: decisionInput.reason ?? null,
        risk_level: decisionInput.riskLevel ?? null,
        deciding_actor_id: decisionInput.decidingActorId ?? input.actorId,
        work_order_id: input.workOrderId,
        run_id: null,
        tool_invocation_id: null,
        required_setup: decisionInput.requiredSetup ?? null,
        created_at: now,
      });

      await client.query(
        `INSERT INTO authority_decisions
           (id, tenant_id, schema_version, outcome, requires_human_gatekeeper, reason,
            risk_level, deciding_actor_id, work_order_id, required_setup, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
          parsedDecision.created_at,
        ],
      );

      authorityDecision = parsedDecision;
      newAuthorityDecisionId = parsedDecision.id;
    }

    const authorityBranchStatuses: readonly WorkOrderStatus[] = [
      "READY_TO_ACT",
      "AWAITING_AUTHORIZATION",
      "SETUP_REQUIRED",
      "CAPABILITY_MISSING",
      "REFUSED",
    ];
    if (currentStatus === "AUTHORITY_CLASSIFIED" && authorityBranchStatuses.includes(input.nextStatus)) {
      const linkedDecisionId = workOrderRow.authority_decision_id as string | null;
      if (!linkedDecisionId) {
        throw new Error(
          `transitionWorkOrder: WorkOrder ${input.workOrderId} has no linked AuthorityDecision to verify outcome against`,
        );
      }
      const decisionResult = await client.query("SELECT * FROM authority_decisions WHERE id = $1", [
        linkedDecisionId,
      ]);
      const decisionRow = decisionResult.rows[0] as Record<string, unknown> | undefined;
      if (!decisionRow) {
        throw new Error(
          `transitionWorkOrder: linked AuthorityDecision ${linkedDecisionId} for WorkOrder ${input.workOrderId} not found`,
        );
      }
      if (decisionRow.tenant_id !== input.tenantId) {
        throw new TenantScopeViolationError(
          input.workOrderId,
          decisionRow.tenant_id as string,
          input.tenantId,
        );
      }

      const outcome = decisionRow.outcome as AuthorityOutcome;
      const expectedStatus = AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS[outcome];
      if (expectedStatus !== input.nextStatus) {
        throw new AuthorityOutcomeMismatchError(input.workOrderId, outcome, expectedStatus, input.nextStatus);
      }
    }

    if (currentStatus === "READY_TO_ACT" && input.nextStatus === "EXECUTING") {
      const runId = randomUUID();
      const runIdempotencyKey = buildIdempotencyKey([input.tenantId, input.workOrderId, "run", 1]);
      const runInsert = await client.query(
        `INSERT INTO runs (id, tenant_id, work_order_id, actor_id, status, attempt_number, started_at, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,'EXECUTING',1,$5,$6,$5)
         RETURNING *`,
        [runId, input.tenantId, input.workOrderId, input.actorId, now, runIdempotencyKey],
      );
      run = runInsert.rows[0] as Record<string, unknown>;
    }

    if (currentStatus === "EXECUTING" && input.nextStatus === "VALIDATING") {
      const existingRun = await mostRecentRun(client, input.tenantId, input.workOrderId, true);
      if (!existingRun) {
        throw new Error(`transitionWorkOrder: no Run found for WorkOrder ${input.workOrderId} to validate`);
      }
      if (existingRun.tenant_id !== input.tenantId) {
        throw new TenantScopeViolationError(input.workOrderId, existingRun.tenant_id as string, input.tenantId);
      }
      const runUpdate = await client.query(
        "UPDATE runs SET status = 'VALIDATING' WHERE id = $1 RETURNING *",
        [existingRun.id],
      );
      run = runUpdate.rows[0] as Record<string, unknown>;
    }

    if (currentStatus === "VALIDATING" && input.nextStatus === "RECEIPT_WRITTEN") {
      const existingRun = await mostRecentRun(client, input.tenantId, input.workOrderId, false);
      if (!existingRun) {
        throw new Error(`transitionWorkOrder: no Run found for WorkOrder ${input.workOrderId} to receipt`);
      }
      if (existingRun.tenant_id !== input.tenantId) {
        throw new TenantScopeViolationError(input.workOrderId, existingRun.tenant_id as string, input.tenantId);
      }

      const receiptId = randomUUID();
      const receiptIdempotencyKey = buildIdempotencyKey([
        input.tenantId,
        input.workOrderId,
        "receipt",
        "state_transitioned",
        input.nextStatus,
      ]);
      const parsedReceipt = actionReceiptSchema.parse({
        id: receiptId,
        tenant_id: input.tenantId,
        schema_version: 1,
        receipt_type: "state_transitioned",
        actor_id: input.actorId,
        acting_system: "core-state-machine",
        created_at: now,
        parent_receipt_id: null,
        supersedes_receipt_id: null,
        correction_receipt_id: null,
        payload: {
          entity_type: "work_order",
          entity_id: input.workOrderId,
          from_state: currentStatus,
          to_state: input.nextStatus,
        },
      });

      await client.query(
        `INSERT INTO action_receipts
           (id, tenant_id, schema_version, receipt_type, actor_id, acting_system, work_order_id, run_id,
            authority_decision_id, parent_receipt_id, supersedes_receipt_id, correction_receipt_id,
            payload, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          parsedReceipt.id,
          parsedReceipt.tenant_id,
          parsedReceipt.schema_version,
          parsedReceipt.receipt_type,
          parsedReceipt.actor_id,
          parsedReceipt.acting_system,
          input.workOrderId,
          existingRun.id,
          workOrderRow.authority_decision_id,
          parsedReceipt.parent_receipt_id,
          parsedReceipt.supersedes_receipt_id,
          parsedReceipt.correction_receipt_id,
          JSON.stringify(parsedReceipt.payload),
          receiptIdempotencyKey,
          parsedReceipt.created_at,
        ],
      );

      actionReceipt = parsedReceipt;
    }

    if (currentStatus === "RECEIPT_WRITTEN" && input.nextStatus === "MEMORY_CANDIDATES_CREATED") {
      if (!input.memoryCandidate) {
        throw new Error(
          "transitionWorkOrder: memoryCandidate input is required for RECEIPT_WRITTEN -> MEMORY_CANDIDATES_CREATED",
        );
      }
      const receiptResult = await client.query(
        `SELECT * FROM action_receipts
         WHERE tenant_id = $1 AND work_order_id = $2 AND receipt_type = 'state_transitioned'
         ORDER BY created_at DESC LIMIT 1`,
        [input.tenantId, input.workOrderId],
      );
      const sourceReceiptRow = receiptResult.rows[0] as Record<string, unknown> | undefined;
      if (!sourceReceiptRow) {
        throw new Error(
          `transitionWorkOrder: no ActionReceipt found for WorkOrder ${input.workOrderId} to source a MemoryCandidate from`,
        );
      }
      if (sourceReceiptRow.tenant_id !== input.tenantId) {
        throw new TenantScopeViolationError(
          input.workOrderId,
          sourceReceiptRow.tenant_id as string,
          input.tenantId,
        );
      }

      const candidateInput = input.memoryCandidate;
      const candidateId = randomUUID();
      const parsedCandidate = memoryCandidateSchema.parse({
        id: candidateId,
        tenant_id: input.tenantId,
        source_message_id: workOrderRow.message_id,
        source_receipt_id: sourceReceiptRow.id,
        source_work_order_id: input.workOrderId,
        candidate_content: candidateInput.candidateContent,
        candidate_type: candidateInput.candidateType ?? null,
        confidence: candidateInput.confidence ?? null,
        scope: candidateInput.scope ?? null,
        reason_for_creation: candidateInput.reasonForCreation ?? null,
        promoted_memory_record_id: null,
        created_at: now,
      });

      await client.query(
        `INSERT INTO memory_candidates
           (id, tenant_id, source_message_id, source_receipt_id, source_work_order_id,
            candidate_content, candidate_type, confidence, scope, review_status,
            reason_for_creation, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          parsedCandidate.id,
          parsedCandidate.tenant_id,
          parsedCandidate.source_message_id,
          parsedCandidate.source_receipt_id,
          parsedCandidate.source_work_order_id,
          parsedCandidate.candidate_content,
          parsedCandidate.candidate_type,
          parsedCandidate.confidence,
          parsedCandidate.scope,
          parsedCandidate.review_status,
          parsedCandidate.reason_for_creation,
          parsedCandidate.created_at,
        ],
      );

      memoryCandidate = parsedCandidate;
    }

    const workOrderUpdate = await client.query(
      `UPDATE work_orders
       SET status = $1, updated_at = $2, authority_decision_id = COALESCE($3, authority_decision_id)
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [input.nextStatus, now, newAuthorityDecisionId, input.workOrderId, input.tenantId],
    );
    const updatedWorkOrderRow = workOrderUpdate.rows[0] as Record<string, unknown>;

    const transitionInsert = await client.query(
      `INSERT INTO work_order_state_transitions
         (id, tenant_id, work_order_id, from_status, to_status, actor_id, reason, transition_type, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'state_change',$8,$9)
       RETURNING *`,
      [
        randomUUID(),
        input.tenantId,
        input.workOrderId,
        currentStatus,
        input.nextStatus,
        input.actorId,
        input.reason,
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    const transitionRow = transitionInsert.rows[0] as Record<string, unknown>;

    if (options.injectFailureAfterTransitionInsert) {
      throw new Error("transitionWorkOrder: test-only failure injection after transition insert");
    }

    return {
      workOrder: {
        id: updatedWorkOrderRow.id as string,
        tenant_id: updatedWorkOrderRow.tenant_id as string,
        status: WorkOrderStatusSchema.parse(updatedWorkOrderRow.status),
        authority_decision_id: updatedWorkOrderRow.authority_decision_id as string | null,
      },
      transition: {
        id: transitionRow.id as string,
        tenant_id: transitionRow.tenant_id as string,
        work_order_id: transitionRow.work_order_id as string,
        from_status: transitionRow.from_status as string | null,
        to_status: transitionRow.to_status as string,
        actor_id: transitionRow.actor_id as string | null,
        reason: transitionRow.reason as string,
        transition_type: transitionRow.transition_type as string,
        metadata: transitionRow.metadata as Record<string, unknown>,
        created_at: toIso(transitionRow.created_at as string | Date),
      },
      authorityDecision,
      run: run
        ? {
            id: run.id as string,
            tenant_id: run.tenant_id as string,
            work_order_id: run.work_order_id as string,
            status: run.status as string,
          }
        : undefined,
      actionReceipt,
      memoryCandidate,
    };
  });
}

/** Production entry point. Never accepts failure-injection input. */
export async function transitionWorkOrder(input: TransitionWorkOrderInput): Promise<TransitionWorkOrderResult> {
  return runTransition(input, { injectFailureAfterTransitionInsert: false });
}

/**
 * Test-only wrapper that can force a rollback after the transition row is
 * inserted but before commit, to prove no partial status/history/record
 * mismatch survives a rollback. Rejected outside test context so this is
 * not a reachable production code path.
 */
export async function transitionWorkOrderForTest(
  input: TransitionWorkOrderInput,
): Promise<TransitionWorkOrderResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("transitionWorkOrderForTest may only be called with NODE_ENV=test");
  }
  return runTransition(input, { injectFailureAfterTransitionInsert: true });
}
