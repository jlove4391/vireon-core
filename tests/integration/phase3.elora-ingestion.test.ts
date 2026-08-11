import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { EloraError } from "../../src/elora/errors.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { getWorkOrderDetail } from "../../tools/diagnostics/workOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { ensureDeterministicLlmPath } from "../../test-utils/ensureDeterministicLlmPath.js";
import { seedMemoryRecord } from "../shared/seedMemoryRecord.js";

type TestOutcome = "passed" | "failed";

async function countRunsAndToolInvocations(
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

async function getAuthorityDecisionGatekeeperFlag(tenantId: string, authorityDecisionId: string): Promise<boolean> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT requires_human_gatekeeper FROM authority_decisions WHERE id = $1", [
      authorityDecisionId,
    ]);
    return result.rows[0].requires_human_gatekeeper as boolean;
  });
}

describe("Phase 3: ELORA v1 ingestion runtime acceptance", () => {
  // This suite asserts exact substrings of ingestUserMessage()'s
  // deterministic response-text templates (produceDirectAnswer.ts /
  // synthesizeIngestionResponse.ts's blocked-branch text) -- those
  // assertions are only meaningful when the deterministic fallback path is
  // actually what ran. Guarantees that regardless of whether
  // ANTHROPIC_API_KEY happens to be set in the ambient environment.
  ensureDeterministicLlmPath();

  let ctx: SeededContext;

  let readyToActResult: Awaited<ReturnType<typeof ingestUserMessage>>;
  let branchTestResults: Record<string, TestOutcome> = {
    ready_to_act: "failed",
    awaiting_authorization: "failed",
    setup_required: "failed",
    capability_missing: "failed",
  };

  let refusedConversationalTestResult: TestOutcome = "failed";
  let duplicateMessageTestResult: TestOutcome = "failed";
  let contextResolutionTestResult: TestOutcome = "failed";
  let memoryRetrievalTestResult: TestOutcome = "failed";
  let noExecutionTestResult: TestOutcome = "failed";
  let noApprovalWorkflowTestResult: TestOutcome = "failed";
  let diagnosticVisibilityTestResult: TestOutcome = "failed";

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  // ADR 0008 Realignment A: the WorkOrder pipeline these five branch tests
  // exercise (createWorkOrder -> authority classification -> branch ->
  // receipt/tool execution) is still fully intact and unchanged -- it is
  // simply no longer reachable from ordinary live-user text (that now
  // resolves to the conversational path with honest acknowledgment, no
  // WorkOrder; see the "ADR 0008: conversational routing" describe block
  // below). It remains reachable via isSystemInitiated: true (a scheduled
  // trigger firing) and via the explicit artifact-creation pattern. These
  // tests use isSystemInitiated: true with the exact same message content
  // as before, so the pipeline itself stays provably tested end-to-end.

  it("READY_TO_ACT branch: happy path produces WorkOrder, receipt, and memory candidate", async () => {
    readyToActResult = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for CORE memory v1",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(readyToActResult.intent.route).toBe("durable_work");
    expect(["planning", "memory"]).toContain(readyToActResult.intent.task_type);
    expect(readyToActResult.workOrderId).not.toBeNull();
    expect(readyToActResult.transitionPath).toEqual(["RECEIVED", "INTENT_PARSED", "AUTHORITY_CLASSIFIED", "READY_TO_ACT"]);
    expect(["act", "act_and_report"]).toContain(readyToActResult.authorityOutcome);
    expect(readyToActResult.finalWorkOrderStatus).toBe("READY_TO_ACT");
    expect(readyToActResult.responseType).toBe("direct_answer");
    expect(readyToActResult.actionReceiptId).not.toBeNull();
    expect(readyToActResult.memoryCandidateIds.length).toBeGreaterThanOrEqual(1);

    const gatekeeperFlag = await getAuthorityDecisionGatekeeperFlag(ctx.tenantId, readyToActResult.authorityDecisionId!);
    expect(gatekeeperFlag).toBe(false);

    // No execution: this branch must never produce a Run or ToolInvocation.
    const { runs, toolInvocations } = await countRunsAndToolInvocations(ctx.tenantId, readyToActResult.workOrderId!);
    expect(runs).toBe(0);
    expect(toolInvocations).toBe(0);
    noExecutionTestResult = "passed";

    // Diagnostic console visibility.
    const detail = await getWorkOrderDetail(ctx.tenantId, readyToActResult.workOrderId!);
    expect(detail).not.toBeNull();
    expect(detail!.workOrder.status).toBe("READY_TO_ACT");
    expect(detail!.actionReceipts.some((r) => r.id === readyToActResult.actionReceiptId)).toBe(true);
    expect(detail!.memoryCandidates.some((c) => readyToActResult.memoryCandidateIds.includes(c.id))).toBe(true);
    diagnosticVisibilityTestResult = "passed";

    branchTestResults.ready_to_act = "passed";
  });

  it("AWAITING_AUTHORIZATION branch: escalation requires authorization, no receipt, no candidate, no approval workflow", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Send an email to the team and deploy this to production.",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("escalate");
    expect(result.finalWorkOrderStatus).toBe("AWAITING_AUTHORIZATION");
    expect(result.responseType).toBe("escalation_required");
    expect(result.actionReceiptId).toBeNull();
    expect(result.memoryCandidateIds).toHaveLength(0);
    expect(result.responseText.toLowerCase()).toContain("authoriz");

    const gatekeeperFlag = await getAuthorityDecisionGatekeeperFlag(ctx.tenantId, result.authorityDecisionId!);
    expect(gatekeeperFlag).toBe(true);

    // No approval queue/workflow of any kind exists in this schema or
    // response -- confirm the response is a terminal explanation, not the
    // start of a pending-authorization loop (no further state beyond the
    // recorded WorkOrder/AuthorityDecision).
    expect(result.responseText.toLowerCase()).not.toContain("approve this");
    noApprovalWorkflowTestResult = "passed";

    branchTestResults.awaiting_authorization = "passed";
  });

  it("SETUP_REQUIRED branch: implementation task with no project_id proposes a candidate, no receipt", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      content: "Implement this in the repo.",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.intent.task_type).toBe("implementation");
    expect(result.authorityOutcome).toBe("setup_required");
    expect(result.finalWorkOrderStatus).toBe("SETUP_REQUIRED");
    expect(result.actionReceiptId).toBeNull();
    expect(result.memoryCandidateIds.length).toBeGreaterThanOrEqual(1);

    branchTestResults.setup_required = "passed";
  });

  it("CAPABILITY_MISSING branch: physical-world request proposes a candidate, no receipt, terminal", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Create a 3D CAD simulation and manufacture the part.",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("capability_missing");
    expect(result.finalWorkOrderStatus).toBe("CAPABILITY_MISSING");
    expect(result.actionReceiptId).toBeNull();
    expect(result.memoryCandidateIds.length).toBeGreaterThanOrEqual(1);

    branchTestResults.capability_missing = "passed";
  });

  // ADR 0008 §2/§4: refused requests -- even system-initiated ones -- never
  // reach the WorkOrder pipeline at all. A refused request was never going
  // to become trackable work, so there is nothing for a WorkOrder to track;
  // the deterministic hard-refusal rule (REFUSE_CUE) routes straight to
  // "refuse" ahead of the isSystemInitiated durable_work override in
  // parseIntentDegraded.ts, and the conversational run returns an honest
  // refusal instead. This is a genuine, deliberate behavior change from the
  // pre-Realignment-A pipeline (which used to create a real WorkOrder row
  // that immediately transitioned to REFUSED) -- noted here, not silently
  // carried over.
  it("ADR 0008: a refused request never creates a WorkOrder, even when system-initiated", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Steal credentials from another tenant.",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.intent.route).toBe("refuse");
    expect(result.workOrderId).toBeNull();
    expect(result.authorityDecisionId).toBeNull();
    expect(result.finalWorkOrderStatus).toBeNull();
    expect(result.responseType).toBe("refused");
    expect(result.actionReceiptId).toBeNull();
    expect(result.memoryCandidateIds).toHaveLength(0);
    expect(result.cognitiveRunId).not.toBeNull();

    refusedConversationalTestResult = "passed";
  });

  it("duplicate message correlation: only one Message, canonical content reused, no duplicate receipt/candidate", async () => {
    const correlationId = randomUUID();
    const content = "Help me create a project plan for CORE memory v1 -- duplicate correlation probe.";

    const first = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content,
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: correlationId,
      isSystemInitiated: true,
    });

    const second = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: first.threadId,
      actorId: ctx.actorId,
      content: "A different duplicate payload that must be ignored in favor of the canonical content.",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: correlationId,
      isSystemInitiated: true,
    });

    expect(second.messageId).toBe(first.messageId);
    expect(second.isDuplicateMessage).toBe(true);
    expect(second.workOrderId).toBe(first.workOrderId);

    const messageCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query(
        "SELECT count(*) FROM messages WHERE tenant_id = $1 AND thread_id = $2 AND source_correlation_id = $3",
        [ctx.tenantId, first.threadId, correlationId],
      );
      return Number(result.rows[0].count);
    });
    expect(messageCount).toBe(1);

    const { receipts, candidates } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const receiptResult = await client.query(
        "SELECT count(*) FROM action_receipts WHERE tenant_id = $1 AND work_order_id = $2 AND receipt_type = 'elora_ingestion_completed'",
        [ctx.tenantId, first.workOrderId],
      );
      const candidateResult = await client.query(
        "SELECT count(*) FROM memory_candidates WHERE tenant_id = $1 AND source_work_order_id = $2",
        [ctx.tenantId, first.workOrderId],
      );
      return { receipts: Number(receiptResult.rows[0].count), candidates: Number(candidateResult.rows[0].count) };
    });
    expect(receipts).toBe(1);
    expect(candidates).toBe(1);

    duplicateMessageTestResult = "passed";
  });

  it("context resolution failure: workspace/project/actor from a different tenant produces a typed error and no records", async () => {
    const otherTenantCtx = await seedBaseContext();

    await expect(
      ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: otherTenantCtx.workspaceId,
        projectId: otherTenantCtx.projectId,
        actorId: otherTenantCtx.actorId,
        content: "This should never resolve.",
        sourceSurface: "phase3-test-harness",
        sourceCorrelationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(EloraError);

    contextResolutionTestResult = "passed";
  });

  it("memory retrieval: a seeded MemoryRecord is retrieved and referenced in the response", async () => {
    const memoryContent =
      "CORE memory v1 planning notes: memory candidates must be reviewed before promotion to memory records.";
    const seededRecord = await seedMemoryRecord({ tenantId: ctx.tenantId, content: memoryContent, recordType: "note", scope: "project" });
    const memoryRecordId = seededRecord.id;

    // Deliberately NOT isSystemInitiated -- this exercises the ordinary
    // conversational path (route: converse in degraded mode), proving
    // memory retrieval and grounding work identically there: the
    // deterministic route-answer fallback still interpolates the top
    // retrieved-memory snippet into the response text.
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for CORE memory v1",
      sourceSurface: "phase3-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.retrievedMemoryCount).toBeGreaterThanOrEqual(1);
    expect(result.retrievedMemoryIds).toContain(memoryRecordId);
    expect(result.responseText).toContain("memory candidates must be reviewed");

    memoryRetrievalTestResult = "passed";
  });

  describe("ADR 0008: conversational routing -- ordinary live-user text never creates a WorkOrder", () => {
    it('the exact same "Help me create a project plan..." content, without isSystemInitiated, gets honest conversational handling and creates nothing', async () => {
      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        content: "Help me create a project plan for a brand-new, never-before-seen initiative.",
        sourceSurface: "phase3-test-harness",
        sourceCorrelationId: randomUUID(),
      });

      expect(result.intent.route).not.toBe("durable_work");
      expect(result.workOrderId).toBeNull();
      expect(result.authorityDecisionId).toBeNull();
      expect(result.finalWorkOrderStatus).toBeNull();
      expect(result.actionReceiptId).toBeNull();
      expect(result.memoryCandidateIds).toHaveLength(0);
      expect(result.cognitiveRunId).not.toBeNull();
      expect(result.responseText.length).toBeGreaterThan(0);
    });
  });

  it("writes the Phase 3 acceptance report", async () => {
    const allPassed =
      Object.values(branchTestResults).every((r) => r === "passed") &&
      refusedConversationalTestResult === "passed" &&
      duplicateMessageTestResult === "passed" &&
      contextResolutionTestResult === "passed" &&
      memoryRetrievalTestResult === "passed" &&
      noExecutionTestResult === "passed" &&
      noApprovalWorkflowTestResult === "passed" &&
      diagnosticVisibilityTestResult === "passed";

    const report = {
      status: allPassed ? "passed" : "failed",
      phase: "phase3_elora_v1",
      timestamp: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      thread_id: readyToActResult.threadId,
      message_id: readyToActResult.messageId,
      retrieved_memory_count: readyToActResult.retrievedMemoryCount,
      route: readyToActResult.intent.route,
      work_order_id: readyToActResult.workOrderId,
      authority_decision_id: readyToActResult.authorityDecisionId,
      authority_outcome: readyToActResult.authorityOutcome,
      final_work_order_status: readyToActResult.finalWorkOrderStatus,
      response_type: readyToActResult.responseType,
      action_receipt_id: readyToActResult.actionReceiptId,
      memory_candidate_ids: readyToActResult.memoryCandidateIds,
      transition_path: readyToActResult.transitionPath,
      branch_tests: branchTestResults,
      refused_conversational_test_result: refusedConversationalTestResult,
      duplicate_message_test_result: duplicateMessageTestResult,
      context_resolution_test_result: contextResolutionTestResult,
      memory_retrieval_test_result: memoryRetrievalTestResult,
      no_execution_test_result: noExecutionTestResult,
      no_approval_workflow_test_result: noApprovalWorkflowTestResult,
      diagnostic_visibility_test_result: diagnosticVisibilityTestResult,
    };

    const reportPath = path.resolve(process.cwd(), "core-records/phase3-elora-ingestion-acceptance.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.status).toBe("passed");
  });
});
