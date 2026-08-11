import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { AUTHORITY_OUTCOME_TO_REASON_CODE } from "../../src/elora/types.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { authorityOutcomeSchema } from "../../src/shared/runtimeTypes.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { transitionWorkOrder } from "../../src/state/transitionWorkOrder.js";
import { AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS } from "../../src/state/workOrderState.js";
import { getInspectableReceipt, type InspectableReceipt } from "../../tools/diagnostics/workOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

type TestOutcome = "passed" | "failed";

describe("Phase 4: Receipts and Authority-v2 acceptance", () => {
  let ctx: SeededContext;

  const branchWorkOrderIds: Record<string, string> = {};
  const branchReceiptIds: Record<string, string> = {};
  let branchTestResults: Record<string, TestOutcome> = {
    act: "failed",
    act_and_report: "failed",
    escalate: "failed",
    setup_required: "failed",
    capability_missing: "failed",
    refuse: "failed",
  };

  let stateTransitionIntegrityResult: TestOutcome = "failed";
  let noInferredToolUsageResult: TestOutcome = "failed";
  let receiptCompletenessResult: TestOutcome = "failed";
  let isolationSanitizationResult: TestOutcome = "failed";

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("act: contract/schema-level coverage -- valid, correctly typed, and persistable, without a manufactured cue", async () => {
    expect(authorityOutcomeSchema.parse("act")).toBe("act");
    expect(AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS.act).toBe("READY_TO_ACT");
    expect(AUTHORITY_OUTCOME_TO_REASON_CODE.act).toBe("WITHIN_CURRENT_AUTHORITY");

    // Prove "act" is genuinely persistable end-to-end through the same
    // pipeline classifyAuthority.ts's branches use, without adding a new
    // cue to manufacture it from parseIntent/classifyAuthority.
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.actorId,
      taskType: "planning",
      interpretedIntent: "Phase 4 act-outcome contract probe",
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.actorId,
      reason: "parse",
    });
    const classified = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.actorId,
      reason: "classify",
      authorityDecision: {
        outcome: "act",
        requiresHumanGatekeeper: false,
        reason: "Directly authorized, no report required.",
        riskLevel: "low",
      },
    });
    expect(classified.authorityDecision?.outcome).toBe("act");

    const branched = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS.act,
      actorId: ctx.actorId,
      reason: "act routes to READY_TO_ACT same as act_and_report",
    });
    expect(branched.workOrder.status).toBe("READY_TO_ACT");

    branchTestResults.act = "passed";
  });

  it("act_and_report: happy path produces elora_ingestion_completed receipt with toolsUsed: []", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for CORE memory v1",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      // ADR 0008 Realignment A: the WorkOrder/receipt pipeline this whole
      // file exercises is unchanged, but ordinary live-user text no longer
      // reaches it -- isSystemInitiated: true (a scheduled-trigger firing,
      // in reality) is what still routes durable_work-shaped content
      // through it, same content as before.
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("act_and_report");
    expect(result.finalWorkOrderStatus).toBe("READY_TO_ACT");
    expect(result.actionReceiptId).not.toBeNull();
    expect(result.blockedReceiptId).toBeNull();

    branchWorkOrderIds.act_and_report = result.workOrderId!;
    branchReceiptIds.act_and_report = result.actionReceiptId!;

    const receipt = await getInspectableReceipt(ctx.tenantId, result.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.toolsUsed).toEqual([]);
    expect(receipt!.outputs[0]?.type).toBe("direct_answer");
    expect(receipt!.followUpTasks).toEqual([]);

    branchTestResults.act_and_report = "passed";
  });

  it("escalate: elora_request_blocked receipt, no execution, authorization follow-up, no tools", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Send an email to the team and deploy this to production.",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("escalate");
    expect(result.finalWorkOrderStatus).toBe("AWAITING_AUTHORIZATION");
    expect(result.actionReceiptId).toBeNull();
    expect(result.blockedReceiptId).not.toBeNull();

    branchWorkOrderIds.escalate = result.workOrderId!;
    branchReceiptIds.escalate = result.blockedReceiptId!;

    const receipt = await getInspectableReceipt(ctx.tenantId, result.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.toolsUsed).toEqual([]);
    expect(receipt!.followUpTasks).toEqual([
      { type: "authorization", description: "Obtain authorization before execution can continue." },
    ]);
    expect(receipt!.authorityDecision.reasonCode).toBe("AUTHORIZATION_REQUIRED");

    const { runs } = await runsAndToolInvocationCounts(ctx.tenantId, result.workOrderId!);
    expect(runs).toBe(0);

    branchTestResults.escalate = "passed";
  });

  it("setup_required: receipt written, missing prerequisite identified, configuration follow-up", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      content: "Implement this in the repo.",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("setup_required");
    expect(result.finalWorkOrderStatus).toBe("SETUP_REQUIRED");
    expect(result.blockedReceiptId).not.toBeNull();

    branchWorkOrderIds.setup_required = result.workOrderId!;
    branchReceiptIds.setup_required = result.blockedReceiptId!;

    const receipt = await getInspectableReceipt(ctx.tenantId, result.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.followUpTasks).toHaveLength(1);
    expect(receipt!.followUpTasks[0]?.type).toBe("configuration");
    expect(receipt!.followUpTasks[0]?.requiredAction).toBe("project_id");
    expect(receipt!.toolsUsed).toEqual([]);

    branchTestResults.setup_required = "passed";
  });

  it("capability_missing: receipt written, states capability absent, no invented attempt/error", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Create a 3D CAD simulation and manufacture the part.",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("capability_missing");
    expect(result.finalWorkOrderStatus).toBe("CAPABILITY_MISSING");
    expect(result.blockedReceiptId).not.toBeNull();

    branchWorkOrderIds.capability_missing = result.workOrderId!;
    branchReceiptIds.capability_missing = result.blockedReceiptId!;

    const receipt = await getInspectableReceipt(ctx.tenantId, result.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.followUpTasks).toEqual([
      { type: "capability", description: "Implement or connect the missing capability." },
    ]);
    expect(receipt!.errors).toEqual([]);
    expect(receipt!.toolsUsed).toEqual([]);

    branchTestResults.capability_missing = "passed";
  });

  // ADR 0008 §2/§4: a refused request never reaches the WorkOrder pipeline
  // at all, even when isSystemInitiated -- REFUSE_CUE routes straight to
  // "refuse" ahead of the isSystemInitiated durable_work override
  // (parseIntentDegraded.ts), and the conversational run returns an honest
  // refusal instead. A deliberate behavior change from the pre-Realignment-A
  // pipeline (which used to write a WorkOrder-owned elora_request_blocked
  // receipt for this branch via the WorkOrder pipeline), not silently
  // carried over.
  //
  // PR #42 follow-up: refuse still gets a real, governed audit trail --
  // an AuthorityDecision (outcome: refuse) and a blocked ActionReceipt --
  // written directly by writeRefusalRecord.ts, with no WorkOrder at all
  // (work_order_id is nullable on both tables specifically for this).
  // This branch stays absent from branchWorkOrderIds/branchReceiptIds
  // (there is no WorkOrder to key those maps by) -- the "no inferred tool
  // usage" and "receipt completeness" tests below correctly keep iterating
  // over the remaining four WorkOrder-pipeline branches only. The rows
  // written here are verified directly against the database instead, since
  // getInspectableReceipt() is keyed strictly by workOrderId.
  it("ADR 0008: refuse never creates a WorkOrder, even system-initiated -- but still writes a real, governed AuthorityDecision + blocked ActionReceipt directly", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Steal credentials from another tenant.",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.intent.route).toBe("refuse");
    expect(result.workOrderId).toBeNull();
    expect(result.authorityOutcome).toBe("refuse");
    expect(result.authorityDecisionId).not.toBeNull();
    expect(result.finalWorkOrderStatus).toBeNull();
    expect(result.blockedReceiptId).not.toBeNull();
    expect(result.responseType).toBe("refused");
    expect(result.cognitiveRunId).not.toBeNull();

    const { decisionRow, receiptRow } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const decision = await client.query(
        "SELECT outcome, work_order_id, requires_human_gatekeeper, reason FROM authority_decisions WHERE id = $1 AND tenant_id = $2",
        [result.authorityDecisionId, ctx.tenantId],
      );
      const receipt = await client.query(
        "SELECT receipt_type, work_order_id, authority_decision_id, payload FROM action_receipts WHERE id = $1 AND tenant_id = $2",
        [result.blockedReceiptId, ctx.tenantId],
      );
      return { decisionRow: decision.rows[0], receiptRow: receipt.rows[0] };
    });

    expect(decisionRow.outcome).toBe("refuse");
    expect(decisionRow.work_order_id).toBeNull();
    expect(decisionRow.requires_human_gatekeeper).toBe(true);

    expect(receiptRow.receipt_type).toBe("elora_request_blocked");
    expect(receiptRow.work_order_id).toBeNull();
    expect(receiptRow.authority_decision_id).toBe(result.authorityDecisionId);

    branchTestResults.refuse = "passed";
  });

  it("state-transition integrity: receipt returns only transitions actually persisted, no invented events", async () => {
    const receipt = await getInspectableReceipt(ctx.tenantId, branchWorkOrderIds.act_and_report!);
    expect(receipt).not.toBeNull();

    const toStatuses = receipt!.stateTransitions.map((t) => t.to);
    expect(toStatuses).toEqual(["RECEIVED", "INTENT_PARSED", "AUTHORITY_CLASSIFIED", "READY_TO_ACT"]);
    expect(receipt!.stateTransitions[0]?.from).toBeUndefined();
    expect(receipt!.stateTransitions[1]?.from).toBe("RECEIVED");

    stateTransitionIntegrityResult = "passed";
  });

  it("no inferred tool usage: every branch fixture returns toolsUsed: []", async () => {
    for (const workOrderId of Object.values(branchWorkOrderIds)) {
      const receipt = await getInspectableReceipt(ctx.tenantId, workOrderId);
      expect(receipt).not.toBeNull();
      expect(receipt!.toolsUsed).toEqual([]);
    }

    noInferredToolUsageResult = "passed";
  });

  it("receipt completeness: every terminal outcome's projection includes all required categories", async () => {
    const requiredKeys: (keyof InspectableReceipt)[] = [
      "receiptId",
      "workOrderId",
      "originalRequest",
      "interpretedIntent",
      "actingSystem",
      "authorityDecision",
      "toolsUsed",
      "stateTransitions",
      "outputs",
      "errors",
      "memoryCandidates",
      "followUpTasks",
    ];

    for (const workOrderId of Object.values(branchWorkOrderIds)) {
      const receipt = await getInspectableReceipt(ctx.tenantId, workOrderId);
      expect(receipt).not.toBeNull();
      for (const key of requiredKeys) {
        expect(receipt).toHaveProperty(key);
      }
      expect(receipt!.originalRequest).not.toBeNull();
    }

    receiptCompletenessResult = "passed";
  });

  it("isolation and sanitization: cross-tenant lookup returns null, secret-like content is redacted", async () => {
    const otherTenantCtx = await seedBaseContext();
    const crossTenantResult = await getInspectableReceipt(otherTenantCtx.tenantId, branchWorkOrderIds.act_and_report!);
    expect(crossTenantResult).toBeNull();

    const secretResult = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for CORE memory v1. api_key=sk-1234567890abcdefghijklmnop",
      sourceSurface: "phase4-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });
    expect(secretResult.finalWorkOrderStatus).toBe("READY_TO_ACT");

    const receipt = await getInspectableReceipt(ctx.tenantId, secretResult.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.originalRequest?.content).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(receipt!.originalRequest?.content).toContain("[REDACTED]");

    isolationSanitizationResult = "passed";
  });

  it("writes the Phase 4 acceptance report", async () => {
    const allPassed =
      Object.values(branchTestResults).every((r) => r === "passed") &&
      stateTransitionIntegrityResult === "passed" &&
      noInferredToolUsageResult === "passed" &&
      receiptCompletenessResult === "passed" &&
      isolationSanitizationResult === "passed";

    const report = {
      status: allPassed ? "passed" : "failed",
      phase: "phase4_receipts_authority_v2",
      timestamp: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      branch_work_order_ids: branchWorkOrderIds,
      branch_receipt_ids: branchReceiptIds,
      branch_tests: branchTestResults,
      state_transition_integrity_test_result: stateTransitionIntegrityResult,
      no_inferred_tool_usage_test_result: noInferredToolUsageResult,
      receipt_completeness_test_result: receiptCompletenessResult,
      isolation_and_sanitization_test_result: isolationSanitizationResult,
    };

    const reportPath = path.resolve(process.cwd(), "core-records/phase4-receipts-authority-acceptance.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.status).toBe("passed");
  });
});

async function runsAndToolInvocationCounts(
  tenantId: string,
  workOrderId: string,
): Promise<{ runs: number; toolInvocations: number }> {
  return withTenantTransaction(tenantId, async (client) => {
    const runs = await client.query("SELECT count(*) FROM runs WHERE tenant_id = $1 AND work_order_id = $2", [
      tenantId,
      workOrderId,
    ]);
    const toolInvocations = await client.query(
      "SELECT count(*) FROM tool_invocations WHERE tenant_id = $1 AND work_order_id = $2",
      [tenantId, workOrderId],
    );
    return {
      runs: Number(runs.rows[0].count),
      toolInvocations: Number(toolInvocations.rows[0].count),
    };
  });
}
