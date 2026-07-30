import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import {
  AuthorityOutcomeMismatchError,
  InvalidWorkOrderTransitionError,
  StateReferenceNotFoundError,
  TerminalWorkOrderStateError,
} from "../../src/state/errors.js";
import {
  HAPPY_PATH_INTERPRETED_INTENT,
  HAPPY_PATH_TASK_TYPE,
  HAPPY_PATH_TRANSITIONS,
} from "../../src/state/lifecycleFixtures.js";
import { transitionWorkOrder, transitionWorkOrderForTest } from "../../src/state/transitionWorkOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

type TestOutcome = "passed" | "failed";

interface ReportTransitionEntry {
  from: string | null;
  to: string;
  actor_id: string | null;
  reason: string;
  created_at: string;
  authority_decision_id?: string;
  run_id?: string;
  action_receipt_id?: string;
  memory_candidate_id?: string;
}

async function newWorkOrder(ctx: SeededContext, taskType = HAPPY_PATH_TASK_TYPE) {
  const { messageId } = await withTenantTransaction(ctx.tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO messages (id, tenant_id, thread_id, actor_id, role, content, metadata, source_surface)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.tenantId, ctx.threadId, ctx.actorId, "user", `Phase 2 fixture message ${id}`, JSON.stringify({}), "phase2-test-harness"],
    );
    return { messageId: id };
  });

  return createWorkOrder({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    threadId: ctx.threadId,
    messageId,
    actorId: ctx.actorId,
    taskType,
    interpretedIntent: HAPPY_PATH_INTERPRETED_INTENT,
  });
}

describe("Phase 2: CORE state machine v1 acceptance", () => {
  let ctx: SeededContext;

  let happyPathWorkOrderId: string;
  let happyPathTransitions: ReportTransitionEntry[] = [];
  let substantiatingRecords: Record<string, string> = {};

  let invalidTransitionTestResult: TestOutcome = "failed";
  let terminalStateTestResult: TestOutcome = "failed";
  let authorityOutcomeMismatchTestResult: TestOutcome = "failed";
  let rollbackTestResult: TestOutcome = "failed";
  let idempotentRetryTestResult: TestOutcome = "failed";
  let rlsIsolationTestResult: TestOutcome = "failed";

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("createWorkOrder() produces a RECEIVED WorkOrder and its initial NULL -> RECEIVED transition row", async () => {
    const { workOrder, initialTransition } = await newWorkOrder(ctx);
    happyPathWorkOrderId = workOrder.id;

    expect(workOrder.status).toBe("RECEIVED");
    expect(workOrder.tenant_id).toBe(ctx.tenantId);
    expect(initialTransition.from_status).toBeNull();
    expect(initialTransition.to_status).toBe("RECEIVED");
    expect(initialTransition.work_order_id).toBe(workOrder.id);
    expect(initialTransition.tenant_id).toBe(ctx.tenantId);

    happyPathTransitions.push({
      from: initialTransition.from_status,
      to: initialTransition.to_status,
      actor_id: initialTransition.actor_id,
      reason: initialTransition.reason,
      created_at: initialTransition.created_at,
    });
  });

  it("walks the full happy path via transitionWorkOrder(), verifying each gated substantiating record", async () => {
    for (const fixture of HAPPY_PATH_TRANSITIONS) {
      const result = await transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: happyPathWorkOrderId,
        nextStatus: fixture.nextStatus,
        actorId: ctx.actorId,
        reason: fixture.reason,
        authorityDecision: fixture.authorityDecision,
        memoryCandidate: fixture.memoryCandidate,
      });

      expect(result.workOrder.status).toBe(fixture.nextStatus);
      expect(result.transition.to_status).toBe(fixture.nextStatus);
      expect(result.transition.tenant_id).toBe(ctx.tenantId);

      const reportEntry: ReportTransitionEntry = {
        from: result.transition.from_status,
        to: result.transition.to_status,
        actor_id: result.transition.actor_id,
        reason: result.transition.reason,
        created_at: result.transition.created_at,
      };

      if (fixture.nextStatus === "AUTHORITY_CLASSIFIED") {
        expect(result.authorityDecision).toBeDefined();
        expect(result.authorityDecision?.tenant_id).toBe(ctx.tenantId);
        expect(result.authorityDecision?.work_order_id).toBe(happyPathWorkOrderId);
        expect(result.authorityDecision?.outcome).toBe("act");
        expect(result.workOrder.authority_decision_id).toBe(result.authorityDecision?.id);
        substantiatingRecords.authority_decision_id = result.authorityDecision!.id;
        reportEntry.authority_decision_id = result.authorityDecision!.id;
      }

      if (fixture.nextStatus === "EXECUTING") {
        expect(result.run).toBeDefined();
        expect(result.run?.tenant_id).toBe(ctx.tenantId);
        expect(result.run?.work_order_id).toBe(happyPathWorkOrderId);
        expect(result.run?.status).toBe("EXECUTING");
        substantiatingRecords.run_id = result.run!.id;
        reportEntry.run_id = result.run!.id;
      }

      if (fixture.nextStatus === "VALIDATING") {
        expect(result.run).toBeDefined();
        expect(result.run?.status).toBe("VALIDATING");
        expect(result.run?.id).toBe(substantiatingRecords.run_id);
      }

      if (fixture.nextStatus === "RECEIPT_WRITTEN") {
        expect(result.actionReceipt).toBeDefined();
        expect(result.actionReceipt?.tenant_id).toBe(ctx.tenantId);
        expect(result.actionReceipt?.receipt_type).toBe("state_transitioned");

        const receiptRow = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT * FROM action_receipts WHERE id = $1", [result.actionReceipt!.id]);
          return r.rows[0];
        });
        expect(receiptRow.work_order_id).toBe(happyPathWorkOrderId);
        expect(receiptRow.run_id).toBe(substantiatingRecords.run_id);

        substantiatingRecords.action_receipt_id = result.actionReceipt!.id;
        reportEntry.action_receipt_id = result.actionReceipt!.id;
      }

      if (fixture.nextStatus === "MEMORY_CANDIDATES_CREATED") {
        expect(result.memoryCandidate).toBeDefined();
        expect(result.memoryCandidate?.tenant_id).toBe(ctx.tenantId);
        expect(result.memoryCandidate?.source_work_order_id).toBe(happyPathWorkOrderId);
        expect(result.memoryCandidate?.source_receipt_id).toBe(substantiatingRecords.action_receipt_id);
        substantiatingRecords.memory_candidate_id = result.memoryCandidate!.id;
        reportEntry.memory_candidate_id = result.memoryCandidate!.id;
      }

      happyPathTransitions.push(reportEntry);
    }

    const finalWorkOrder = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT * FROM work_orders WHERE id = $1", [happyPathWorkOrderId]);
      return r.rows[0];
    });
    expect(finalWorkOrder.status).toBe("COMPLETED");
  });

  it("rejects an AUTHORITY_CLASSIFIED branch transition that does not match the AuthorityDecision outcome", async () => {
    const { workOrder } = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.actorId,
      reason: "classify",
      authorityDecision: {
        outcome: "act",
        requiresHumanGatekeeper: false,
        reason: "low risk",
        riskLevel: "low",
      },
    });

    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: "AWAITING_AUTHORIZATION",
        actorId: ctx.actorId,
        reason: "mismatched branch attempt",
      }),
    ).rejects.toBeInstanceOf(AuthorityOutcomeMismatchError);

    authorityOutcomeMismatchTestResult = "passed";
  });

  it("rejects an unlisted transition with InvalidWorkOrderTransitionError", async () => {
    const { workOrder } = await newWorkOrder(ctx);

    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: "EXECUTING",
        actorId: ctx.actorId,
        reason: "invalid skip-ahead attempt",
      }),
    ).rejects.toBeInstanceOf(InvalidWorkOrderTransitionError);

    invalidTransitionTestResult = "passed";
  });

  it("blocks further transitions from all four terminal states", async () => {
    // COMPLETED, reached by the happy path WorkOrder.
    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: happyPathWorkOrderId,
        nextStatus: "FAILED",
        actorId: ctx.actorId,
        reason: "attempt to mutate a completed WorkOrder",
      }),
    ).rejects.toBeInstanceOf(TerminalWorkOrderStateError);

    // FAILED.
    const failedWO = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: failedWO.workOrder.id,
      nextStatus: "FAILED",
      actorId: ctx.actorId,
      reason: "forced failure",
    });
    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: failedWO.workOrder.id,
        nextStatus: "INTENT_PARSED",
        actorId: ctx.actorId,
        reason: "attempt to mutate a failed WorkOrder",
      }),
    ).rejects.toBeInstanceOf(TerminalWorkOrderStateError);

    // REFUSED.
    const refusedWO = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: refusedWO.workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: refusedWO.workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.actorId,
      reason: "classify",
      authorityDecision: {
        outcome: "refuse",
        requiresHumanGatekeeper: true,
        reason: "out of policy scope",
        riskLevel: "high",
      },
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: refusedWO.workOrder.id,
      nextStatus: "REFUSED",
      actorId: ctx.actorId,
      reason: "refused per authority decision",
    });
    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: refusedWO.workOrder.id,
        nextStatus: "READY_TO_ACT",
        actorId: ctx.actorId,
        reason: "attempt to mutate a refused WorkOrder",
      }),
    ).rejects.toBeInstanceOf(TerminalWorkOrderStateError);

    // CAPABILITY_MISSING.
    const capabilityMissingWO = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: capabilityMissingWO.workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: capabilityMissingWO.workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.actorId,
      reason: "classify",
      authorityDecision: {
        outcome: "capability_missing",
        requiresHumanGatekeeper: false,
        reason: "no tool available",
        riskLevel: "n/a",
      },
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: capabilityMissingWO.workOrder.id,
      nextStatus: "CAPABILITY_MISSING",
      actorId: ctx.actorId,
      reason: "capability missing per authority decision",
    });
    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: capabilityMissingWO.workOrder.id,
        nextStatus: "READY_TO_ACT",
        actorId: ctx.actorId,
        reason: "attempt to mutate a capability-missing WorkOrder",
      }),
    ).rejects.toBeInstanceOf(TerminalWorkOrderStateError);

    terminalStateTestResult = "passed";
  });

  it("rolls back status, transition history, and substantiating records on a forced mid-transaction failure", async () => {
    const { workOrder } = await newWorkOrder(ctx);

    await expect(
      transitionWorkOrderForTest({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: "INTENT_PARSED",
        actorId: ctx.actorId,
        reason: "forced rollback probe",
      }),
    ).rejects.toThrow("test-only failure injection");

    const { workOrderRow, transitionRows } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const wo = await client.query("SELECT * FROM work_orders WHERE id = $1", [workOrder.id]);
      const transitions = await client.query(
        "SELECT * FROM work_order_state_transitions WHERE work_order_id = $1 ORDER BY created_at ASC",
        [workOrder.id],
      );
      return { workOrderRow: wo.rows[0], transitionRows: transitions.rows };
    });

    expect(workOrderRow.status).toBe("RECEIVED");
    expect(transitionRows).toHaveLength(1);
    expect(transitionRows[0].to_status).toBe("RECEIVED");

    rollbackTestResult = "passed";
  });

  it("self-rejects a retried transition targeting the already-current status, without duplicating a row", async () => {
    const { workOrder } = await newWorkOrder(ctx);

    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "first attempt",
    });

    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: "INTENT_PARSED",
        actorId: ctx.actorId,
        reason: "retried attempt",
      }),
    ).rejects.toBeInstanceOf(InvalidWorkOrderTransitionError);

    const countResult = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query(
        "SELECT count(*) FROM work_order_state_transitions WHERE work_order_id = $1 AND to_status = 'INTENT_PARSED'",
        [workOrder.id],
      ),
    );
    expect(Number(countResult.rows[0].count)).toBe(1);

    idempotentRetryTestResult = "passed";
  });

  it("enforces row-level security on work_order_state_transitions", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const unsetResult = await client.query(
        "SELECT id FROM work_order_state_transitions WHERE work_order_id = $1",
        [happyPathWorkOrderId],
      );
      expect(unsetResult.rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const otherTenantId = randomUUID();
    const wrongTenantResult = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM work_order_state_transitions WHERE work_order_id = $1", [happyPathWorkOrderId]),
    );
    expect(wrongTenantResult.rows).toHaveLength(0);

    const correctTenantResult = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM work_order_state_transitions WHERE work_order_id = $1", [happyPathWorkOrderId]),
    );
    expect(correctTenantResult.rows.length).toBeGreaterThan(0);

    rlsIsolationTestResult = "passed";
  });

  it("confirms every transition row and substantiating record for the happy path shares tenant_id", async () => {
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const transitions = await client.query(
        "SELECT tenant_id FROM work_order_state_transitions WHERE work_order_id = $1",
        [happyPathWorkOrderId],
      );
      const authority = await client.query("SELECT tenant_id FROM authority_decisions WHERE id = $1", [
        substantiatingRecords.authority_decision_id,
      ]);
      const run = await client.query("SELECT tenant_id FROM runs WHERE id = $1", [substantiatingRecords.run_id]);
      const receipt = await client.query("SELECT tenant_id FROM action_receipts WHERE id = $1", [
        substantiatingRecords.action_receipt_id,
      ]);
      const memory = await client.query("SELECT tenant_id FROM memory_candidates WHERE id = $1", [
        substantiatingRecords.memory_candidate_id,
      ]);
      return [
        ...transitions.rows,
        authority.rows[0],
        run.rows[0],
        receipt.rows[0],
        memory.rows[0],
      ];
    });

    for (const row of rows) {
      expect(row.tenant_id).toBe(ctx.tenantId);
    }
  });

  it("accepts an explicit authorityDecision.decidingActorId override when it belongs to the same tenant", async () => {
    const { workOrder } = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });

    // ctx.actorId is a real, same-tenant Actor distinct from the transition's
    // own input.actorId -- proves the override path itself (not just the
    // input.actorId fallback every other AUTHORITY_CLASSIFIED test exercises)
    // works end-to-end for a genuinely legitimate same-tenant value.
    const classified = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.actorId,
      reason: "classify with an explicit deciding actor",
      authorityDecision: {
        outcome: "act",
        requiresHumanGatekeeper: false,
        reason: "low risk",
        riskLevel: "low",
        decidingActorId: ctx.actorId,
      },
    });

    expect(classified.authorityDecision?.deciding_actor_id).toBe(ctx.actorId);
  });

  it("rejects a cross-tenant authorityDecision.decidingActorId with StateReferenceNotFoundError, and never persists a partial AuthorityDecision", async () => {
    const tenantB = await seedBaseContext();
    const { workOrder } = await newWorkOrder(ctx);
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });

    await expect(
      transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: "AUTHORITY_CLASSIFIED",
        actorId: ctx.actorId,
        reason: "classify with a foreign deciding actor",
        authorityDecision: {
          outcome: "act",
          requiresHumanGatekeeper: false,
          reason: "low risk",
          riskLevel: "low",
          decidingActorId: tenantB.actorId,
        },
      }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);

    // The WorkOrder must still be INTENT_PARSED, and no orphaned
    // AuthorityDecision row left behind by the rejected attempt.
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const wo = await client.query("SELECT status FROM work_orders WHERE id = $1 AND tenant_id = $2", [
        workOrder.id,
        ctx.tenantId,
      ]);
      const decisions = await client.query(
        "SELECT count(*)::int AS n FROM authority_decisions WHERE tenant_id = $1 AND work_order_id = $2",
        [ctx.tenantId, workOrder.id],
      );
      return { status: wo.rows[0].status as string, decisionCount: (decisions.rows[0] as { n: number }).n };
    });
    expect(row.status).toBe("INTENT_PARSED");
    expect(row.decisionCount).toBe(0);
  });

  it("writes the Phase 2 acceptance report", async () => {
    const allPassed =
      invalidTransitionTestResult === "passed" &&
      terminalStateTestResult === "passed" &&
      authorityOutcomeMismatchTestResult === "passed" &&
      rollbackTestResult === "passed" &&
      idempotentRetryTestResult === "passed" &&
      rlsIsolationTestResult === "passed";

    const report = {
      status: allPassed ? "passed" : "failed",
      timestamp: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      work_order_id: happyPathWorkOrderId,
      final_status: "COMPLETED",
      transitions: happyPathTransitions,
      substantiating_records: substantiatingRecords,
      invalid_transition_test_result: invalidTransitionTestResult,
      terminal_state_test_result: terminalStateTestResult,
      authority_outcome_mismatch_test_result: authorityOutcomeMismatchTestResult,
      rollback_test_result: rollbackTestResult,
      idempotent_retry_test_result: idempotentRetryTestResult,
      rls_isolation_test_result: rlsIsolationTestResult,
    };

    const reportPath = path.resolve(process.cwd(), "core-records/phase2-state-machine-acceptance.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.status).toBe("passed");
  });
});
