import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createRedisClient } from "../../src/redis/client.js";
import { actionReceiptSchema } from "../../src/schemas/actionReceipt.js";
import { authorityDecisionSchema } from "../../src/schemas/authorityDecision.js";
import { memoryCandidateSchema } from "../../src/schemas/memoryCandidate.js";
import { workOrderSchema } from "../../src/schemas/workOrder.js";
import { buildIdempotencyKey } from "../../src/shared/ids.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

type TestOutcome = "passed" | "failed";

describe("Phase 1: database spine acceptance", () => {
  let ctx: SeededContext;
  let workOrderId: string;
  let authorityDecisionId: string;
  let actionReceiptId: string;
  let memoryCandidateId: string;

  let rollbackTestResult: TestOutcome = "failed";
  let idempotencyTestResult: TestOutcome = "failed";
  let rlsIsolationTestResult: TestOutcome = "failed";

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("seeds a durable tenant/user/actor/workspace/project/thread/message chain", () => {
    expect(ctx.tenantId).toBeTruthy();
    expect(ctx.userId).toBeTruthy();
    expect(ctx.actorId).toBeTruthy();
    expect(ctx.workspaceId).toBeTruthy();
    expect(ctx.projectId).toBeTruthy();
    expect(ctx.threadId).toBeTruthy();
    expect(ctx.messageId).toBeTruthy();
  });

  it("creates WorkOrder, AuthorityDecision, ActionReceipt, and MemoryCandidate in one tenant-scoped transaction and commits", async () => {
    const now = new Date().toISOString();

    workOrderId = randomUUID();
    const workOrder = workOrderSchema.parse({
      id: workOrderId,
      tenant_id: ctx.tenantId,
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      thread_id: ctx.threadId,
      message_id: ctx.messageId,
      owner_actor_id: ctx.actorId,
      task_type: "answer_question",
      interpreted_intent: "Prove the Phase 1 database spine end to end",
      idempotency_key: buildIdempotencyKey([ctx.tenantId, ctx.threadId, ctx.messageId, "answer_question"]),
      created_at: now,
      updated_at: now,
    });

    authorityDecisionId = randomUUID();
    const authorityDecision = authorityDecisionSchema.parse({
      id: authorityDecisionId,
      tenant_id: ctx.tenantId,
      outcome: "act",
      requires_human_gatekeeper: false,
      reason: "Low-risk read-only acceptance test action",
      risk_level: "low",
      deciding_actor_id: ctx.actorId,
      work_order_id: workOrder.id,
      created_at: now,
    });

    actionReceiptId = randomUUID();
    const actionReceipt = actionReceiptSchema.parse({
      id: actionReceiptId,
      tenant_id: ctx.tenantId,
      schema_version: 1,
      receipt_type: "work_order_created",
      actor_id: ctx.actorId,
      acting_system: "phase1-test-harness",
      created_at: now,
      parent_receipt_id: null,
      supersedes_receipt_id: null,
      correction_receipt_id: null,
      payload: {
        work_order_id: workOrder.id,
        task_type: workOrder.task_type,
        summary: "WorkOrder created during Phase 1 acceptance test",
      },
    });
    const actionReceiptIdempotencyKey = buildIdempotencyKey([
      ctx.tenantId,
      workOrder.id,
      actionReceipt.receipt_type,
    ]);

    memoryCandidateId = randomUUID();
    const memoryCandidate = memoryCandidateSchema.parse({
      id: memoryCandidateId,
      tenant_id: ctx.tenantId,
      source_message_id: ctx.messageId,
      source_receipt_id: actionReceiptId,
      source_work_order_id: workOrder.id,
      candidate_content: "User asked a Phase 1 acceptance question worth remembering.",
      candidate_type: "observation",
      confidence: 0.8,
      scope: "project",
      reason_for_creation: "Derived from WorkOrder completion during acceptance test",
      created_at: now,
    });

    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO work_orders
           (id, tenant_id, workspace_id, project_id, thread_id, message_id, owner_actor_id,
            task_type, interpreted_intent, status, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          workOrder.id,
          workOrder.tenant_id,
          workOrder.workspace_id,
          workOrder.project_id,
          workOrder.thread_id,
          workOrder.message_id,
          workOrder.owner_actor_id,
          workOrder.task_type,
          workOrder.interpreted_intent,
          workOrder.status,
          workOrder.idempotency_key,
          workOrder.created_at,
          workOrder.updated_at,
        ],
      );

      await client.query(
        `INSERT INTO authority_decisions
           (id, tenant_id, schema_version, outcome, requires_human_gatekeeper, reason,
            risk_level, deciding_actor_id, work_order_id, required_setup, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          authorityDecision.id,
          authorityDecision.tenant_id,
          authorityDecision.schema_version,
          authorityDecision.outcome,
          authorityDecision.requires_human_gatekeeper,
          authorityDecision.reason,
          authorityDecision.risk_level,
          authorityDecision.deciding_actor_id,
          authorityDecision.work_order_id,
          authorityDecision.required_setup,
          authorityDecision.created_at,
        ],
      );

      await client.query(
        `INSERT INTO action_receipts
           (id, tenant_id, schema_version, receipt_type, actor_id, acting_system, work_order_id,
            authority_decision_id, parent_receipt_id, supersedes_receipt_id, correction_receipt_id,
            payload, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          actionReceipt.id,
          actionReceipt.tenant_id,
          actionReceipt.schema_version,
          actionReceipt.receipt_type,
          actionReceipt.actor_id,
          actionReceipt.acting_system,
          workOrder.id,
          authorityDecision.id,
          actionReceipt.parent_receipt_id,
          actionReceipt.supersedes_receipt_id,
          actionReceipt.correction_receipt_id,
          JSON.stringify(actionReceipt.payload),
          actionReceiptIdempotencyKey,
          actionReceipt.created_at,
        ],
      );

      await client.query(
        `INSERT INTO memory_candidates
           (id, tenant_id, source_message_id, source_receipt_id, source_work_order_id,
            candidate_content, candidate_type, confidence, scope, review_status,
            reason_for_creation, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          memoryCandidate.id,
          memoryCandidate.tenant_id,
          memoryCandidate.source_message_id,
          memoryCandidate.source_receipt_id,
          memoryCandidate.source_work_order_id,
          memoryCandidate.candidate_content,
          memoryCandidate.candidate_type,
          memoryCandidate.confidence,
          memoryCandidate.scope,
          memoryCandidate.review_status,
          memoryCandidate.reason_for_creation,
          memoryCandidate.created_at,
        ],
      );
    });

    const { workOrderRow, authorityDecisionRow, actionReceiptRow, memoryCandidateRow } =
      await withTenantTransaction(ctx.tenantId, async (client) => {
        const workOrderResult = await client.query(
          "SELECT * FROM work_orders WHERE id = $1",
          [workOrderId],
        );
        const authorityDecisionResult = await client.query(
          "SELECT * FROM authority_decisions WHERE id = $1",
          [authorityDecisionId],
        );
        const actionReceiptResult = await client.query(
          "SELECT * FROM action_receipts WHERE id = $1",
          [actionReceiptId],
        );
        const memoryCandidateResult = await client.query(
          "SELECT * FROM memory_candidates WHERE id = $1",
          [memoryCandidateId],
        );
        return {
          workOrderRow: workOrderResult.rows[0],
          authorityDecisionRow: authorityDecisionResult.rows[0],
          actionReceiptRow: actionReceiptResult.rows[0],
          memoryCandidateRow: memoryCandidateResult.rows[0],
        };
      });

    // Rows exist.
    expect(workOrderRow).toBeDefined();
    expect(authorityDecisionRow).toBeDefined();
    expect(actionReceiptRow).toBeDefined();
    expect(memoryCandidateRow).toBeDefined();

    // Shared tenant scope.
    for (const row of [workOrderRow, authorityDecisionRow, actionReceiptRow, memoryCandidateRow]) {
      expect(row.tenant_id).toBe(ctx.tenantId);
    }

    // Relational links are valid.
    expect(authorityDecisionRow.work_order_id).toBe(workOrderId);
    expect(actionReceiptRow.work_order_id).toBe(workOrderId);
    expect(actionReceiptRow.authority_decision_id).toBe(authorityDecisionId);
    expect(memoryCandidateRow.source_work_order_id).toBe(workOrderId);
    expect(memoryCandidateRow.source_receipt_id).toBe(actionReceiptId);
    expect(memoryCandidateRow.source_message_id).toBe(ctx.messageId);

    // Receipt references the meaningful action and is correctly versioned for its variant.
    expect(actionReceiptRow.receipt_type).toBe("work_order_created");
    expect(actionReceiptRow.schema_version).toBe(1);
    expect(actionReceiptRow.payload.work_order_id).toBe(workOrderId);

    // Memory candidate references at least one source.
    expect(
      memoryCandidateRow.source_message_id !== null ||
        memoryCandidateRow.source_receipt_id !== null ||
        memoryCandidateRow.source_work_order_id !== null,
    ).toBe(true);
  });

  it("rolls back all writes when a transaction fails partway through", async () => {
    const rollbackWorkOrderId = randomUUID();
    const rollbackIdempotencyKey = buildIdempotencyKey([ctx.tenantId, "rollback-smoke-test", rollbackWorkOrderId]);

    await expect(
      withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO work_orders (id, tenant_id, task_type, idempotency_key)
           VALUES ($1, $2, $3, $4)`,
          [rollbackWorkOrderId, ctx.tenantId, "answer_question", rollbackIdempotencyKey],
        );
        throw new Error("forced failure to verify rollback");
      }),
    ).rejects.toThrow("forced failure to verify rollback");

    const verifyResult = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query("SELECT id FROM work_orders WHERE id = $1", [rollbackWorkOrderId]),
    );
    expect(verifyResult.rows).toHaveLength(0);

    rollbackTestResult = "passed";
  });

  it("prevents duplicate WorkOrder rows on a retried write with the same idempotency key", async () => {
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    const sharedKey = buildIdempotencyKey([ctx.tenantId, "idempotency-smoke-test"]);

    const firstInsert = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query(
        `INSERT INTO work_orders (id, tenant_id, task_type, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [firstAttemptId, ctx.tenantId, "answer_question", sharedKey],
      ),
    );
    expect(firstInsert.rows).toHaveLength(1);
    expect(firstInsert.rows[0].id).toBe(firstAttemptId);

    // Simulated retry: insert-or-fetch per core-runtime.md 3.2, using a
    // different candidate id to prove the conflict path resumes from the
    // existing durable record rather than creating a duplicate.
    const retryResult = await withTenantTransaction(ctx.tenantId, async (client) => {
      const conflictResult = await client.query(
        `INSERT INTO work_orders (id, tenant_id, task_type, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [secondAttemptId, ctx.tenantId, "answer_question", sharedKey],
      );
      if (conflictResult.rows.length > 0) {
        return conflictResult;
      }
      return client.query(
        "SELECT id FROM work_orders WHERE tenant_id = $1 AND idempotency_key = $2",
        [ctx.tenantId, sharedKey],
      );
    });

    expect(retryResult.rows).toHaveLength(1);
    expect(retryResult.rows[0].id).toBe(firstAttemptId);

    const countResult = await withTenantTransaction(ctx.tenantId, async (client) =>
      client.query("SELECT count(*) FROM work_orders WHERE tenant_id = $1 AND idempotency_key = $2", [
        ctx.tenantId,
        sharedKey,
      ]),
    );
    expect(Number(countResult.rows[0].count)).toBe(1);

    idempotencyTestResult = "passed";
  });

  it("enforces row-level security so seeded rows are invisible without the correct tenant context", async () => {
    // Case 1: tenant context left entirely unset.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const unsetResult = await client.query("SELECT id FROM work_orders WHERE id = $1", [workOrderId]);
      expect(unsetResult.rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Case 2: tenant context set to a different, unrelated tenant.
    const otherTenantId = randomUUID();
    const wrongTenantResult = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM work_orders WHERE id = $1", [workOrderId]),
    );
    expect(wrongTenantResult.rows).toHaveLength(0);

    // Control: the correct tenant context still sees its own row.
    const correctTenantResult = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM work_orders WHERE id = $1", [workOrderId]),
    );
    expect(correctTenantResult.rows).toHaveLength(1);

    rlsIsolationTestResult = "passed";
  });

  it("writes the Phase 1 acceptance report", async () => {
    let redisConnectivityTestResult: TestOutcome = "failed";
    const redisClient = createRedisClient();
    try {
      await redisClient.connect();
      const pong = await redisClient.ping();
      redisConnectivityTestResult = pong === "PONG" ? "passed" : "failed";
    } finally {
      await redisClient.quit();
    }

    const allPassed =
      rollbackTestResult === "passed" &&
      idempotencyTestResult === "passed" &&
      rlsIsolationTestResult === "passed" &&
      redisConnectivityTestResult === "passed";

    const report = {
      status: allPassed ? "passed" : "failed",
      timestamp: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      actor_id: ctx.actorId,
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      thread_id: ctx.threadId,
      message_id: ctx.messageId,
      work_order_id: workOrderId,
      authority_decision_id: authorityDecisionId,
      action_receipt_id: actionReceiptId,
      memory_candidate_id: memoryCandidateId,
      rollback_test_result: rollbackTestResult,
      idempotency_test_result: idempotencyTestResult,
      rls_isolation_test_result: rlsIsolationTestResult,
      redis_connectivity_test_result: redisConnectivityTestResult,
    };

    const reportPath = path.resolve(process.cwd(), "core-records/phase1-database-spine-acceptance.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.status).toBe("passed");
  });
});
