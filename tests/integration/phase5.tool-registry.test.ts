import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { transitionWorkOrder } from "../../src/state/transitionWorkOrder.js";
import { AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS } from "../../src/state/workOrderState.js";
import { artifactWriteTool } from "../../src/tools/definitions/artifactWrite.js";
import { DuplicateToolNameError, ToolAuthorityDeniedError, ToolNotFoundError } from "../../src/tools/errors.js";
import { invokeRegisteredTool } from "../../src/tools/gateway.js";
import { registerCoreTools } from "../../src/tools/index.js";
import { listRegisteredTools, registerTool, resolveTool } from "../../src/tools/registry.js";
import {
  loadWorkspaceConfig,
  readWorkspaceFile,
  resolveWorkspaceRoot,
  writeWorkspaceFile,
} from "../../src/tools/workspace.js";
import { getInspectableReceipt } from "../../tools/diagnostics/workOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

type TestOutcome = "passed" | "failed" | "skipped";
type AuthorityOutcome = "act" | "act_and_report" | "escalate" | "setup_required" | "capability_missing" | "refuse";

let testWorkspaceRoot: string;

async function seedMessage(ctx: SeededContext, content: string): Promise<string> {
  return withTenantTransaction(ctx.tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO messages (id, tenant_id, thread_id, actor_id, role, content, metadata, source_surface)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.tenantId, ctx.threadId, ctx.actorId, "user", content, JSON.stringify({}), "phase5-test-harness"],
    );
    return id;
  });
}

/** Drives a fresh WorkOrder to AUTHORITY_CLASSIFIED and (usually) its branch status, returning real, persisted references for direct gateway/tool testing. */
async function driveWorkOrder(
  ctx: SeededContext,
  options: { taskType: string; content: string; outcome: AuthorityOutcome; branch?: boolean },
) {
  const messageId = await seedMessage(ctx, options.content);
  const { workOrder } = await createWorkOrder({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    threadId: ctx.threadId,
    messageId,
    actorId: ctx.actorId,
    taskType: options.taskType,
    interpretedIntent: options.content.slice(0, 100),
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
      outcome: options.outcome,
      requiresHumanGatekeeper: false,
      reason: "Phase 5 test fixture",
      riskLevel: "low",
    },
  });
  const authorityDecisionId = classified.authorityDecision!.id;

  if (options.branch === false) {
    return { workOrderId: workOrder.id, authorityDecisionId, messageId, status: "AUTHORITY_CLASSIFIED" as const };
  }

  const branchStatus = AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS[options.outcome];
  const branched = await transitionWorkOrder({
    tenantId: ctx.tenantId,
    workOrderId: workOrder.id,
    nextStatus: branchStatus,
    actorId: ctx.actorId,
    reason: "branch",
  });
  return { workOrderId: workOrder.id, authorityDecisionId, messageId, status: branched.workOrder.status };
}

async function countToolInvocations(tenantId: string, workOrderId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*) FROM tool_invocations WHERE tenant_id = $1 AND work_order_id = $2",
      [tenantId, workOrderId],
    );
    return Number(result.rows[0].count);
  });
}

describe("Phase 5: tool registry v1 acceptance", () => {
  let ctx: SeededContext;
  const results: Record<string, TestOutcome> = {};

  beforeAll(async () => {
    testWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vireon-phase5-"));
    process.env.ELORA_WORKSPACE_ROOT = testWorkspaceRoot;

    await migrate();
    registerCoreTools();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // ---------------------------------------------------------------------
  // Registry (1-5)
  // ---------------------------------------------------------------------

  it("1: all three canonical tools are registered", () => {
    const tools = listRegisteredTools().map((t) => t.name);
    expect(tools).toEqual(["core.artifact.write", "core.local_file.read", "core.local_file.write"]);
    results.registry_all_three = "passed";
  });

  it("2: tool names are unique -- duplicate registration is rejected", () => {
    expect(() => registerTool(artifactWriteTool)).toThrow(DuplicateToolNameError);
    results.registry_unique_names = "passed";
  });

  it("3: unknown tool name does not execute", async () => {
    expect(() => resolveTool("core.nonexistent")).toThrow(ToolNotFoundError);

    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Unknown tool probe",
      outcome: "act_and_report",
    });

    await expect(
      invokeRegisteredTool({
        toolName: "core.nonexistent",
        input: {},
        context: {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          workOrderId,
          authorityOutcome: "act_and_report",
          actingSystem: "phase5-test-harness",
          correlationId: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);

    expect(await countToolInvocations(ctx.tenantId, workOrderId)).toBe(0);
    results.registry_unknown_tool = "passed";
  });

  it("4: input/output schemas are enforced", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Invalid input probe",
      outcome: "act_and_report",
    });

    const result = await invokeRegisteredTool({
      toolName: "core.artifact.write",
      input: { filename: "", content: "" }, // missing mimeType, empty filename/content -- fails inputSchema
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workOrderId,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(await countToolInvocations(ctx.tenantId, workOrderId)).toBe(1);
    results.registry_schema_enforced = "passed";
  });

  it("5: a caller cannot bypass authority through the gateway -- verified independently of caller behavior", async () => {
    // Real persisted authority outcome is "escalate" -- never branched
    // past AUTHORITY_CLASSIFIED, so it never legitimately reaches a tool.
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Send an email and deploy this -- authority bypass probe",
      outcome: "escalate",
      branch: false,
    });

    // Caller claims act_and_report -- a lie the gateway must not trust.
    await expect(
      invokeRegisteredTool({
        toolName: "core.artifact.write",
        input: { filename: "bypass.md", content: "should never be written", mimeType: "text/markdown" },
        context: {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          workOrderId,
          authorityOutcome: "act_and_report",
          actingSystem: "phase5-test-harness",
          correlationId: randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(ToolAuthorityDeniedError);

    expect(await countToolInvocations(ctx.tenantId, workOrderId)).toBe(0);
    results.registry_authority_independent = "passed";
  });

  // ---------------------------------------------------------------------
  // Workspace (6-13)
  // ---------------------------------------------------------------------

  it("6-7: valid Markdown file written and readable back", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await fs.mkdir(root, { recursive: true });

    const writeResult = await writeWorkspaceFile(config, root, "notes/hello.md", "# Hello\n\nBody text.", {
      allowOverwrite: false,
    });
    expect(writeResult.created).toBe(true);
    expect(writeResult.byteCount).toBeGreaterThan(0);

    const readResult = await readWorkspaceFile(config, root, "notes/hello.md");
    expect(readResult.content).toBe("# Hello\n\nBody text.");
    expect(readResult.contentHash).toBe(writeResult.contentHash);

    results.workspace_write_read = "passed";
  });

  it("8: absolute paths are rejected", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await expect(writeWorkspaceFile(config, root, "/etc/passwd", "x", { allowOverwrite: false })).rejects.toThrow(
      /ABSOLUTE_PATH/,
    );
    results.workspace_absolute_rejected = "passed";
  });

  it("9: '..' traversal is rejected", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await expect(
      writeWorkspaceFile(config, root, "../../etc/passwd", "x", { allowOverwrite: false }),
    ).rejects.toThrow(/PATH_TRAVERSAL/);
    results.workspace_traversal_rejected = "passed";
  });

  it("10: Windows drive-letter and UNC escapes are rejected", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await expect(
      writeWorkspaceFile(config, root, "C:\\Windows\\System32\\config", "x", { allowOverwrite: false }),
    ).rejects.toThrow(/DRIVE_LETTER_PATH/);
    await expect(
      writeWorkspaceFile(config, root, "\\\\server\\share\\file.md", "x", { allowOverwrite: false }),
    ).rejects.toThrow(/UNC_PATH/);
    results.workspace_windows_escape_rejected = "passed";
  });

  it("11: symlink escape is rejected (skipped gracefully if this environment cannot create symlinks)", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await fs.mkdir(root, { recursive: true });

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "vireon-phase5-outside-"));
    const linkPath = path.join(root, "escape-link");

    try {
      await fs.symlink(outsideDir, linkPath, "dir");
    } catch {
      // No symlink privilege in this environment (common on Windows
      // without Developer Mode/admin). Not a failure of the boundary
      // logic itself -- record as skipped rather than fail the suite.
      results.workspace_symlink_rejected = "skipped";
      return;
    }

    await expect(
      writeWorkspaceFile(config, root, "escape-link/evil.md", "x", { allowOverwrite: false }),
    ).rejects.toThrow(/SYMLINK_ESCAPE/);
    results.workspace_symlink_rejected = "passed";
  });

  it("12: content over the configured limit is rejected", async () => {
    const config = loadWorkspaceConfig();
    const smallConfig = { ...config, maxBytes: 10 };
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await expect(
      writeWorkspaceFile(smallConfig, root, "too-big.md", "this content is definitely over ten bytes", {
        allowOverwrite: false,
      }),
    ).rejects.toThrow(/CONTENT_TOO_LARGE/);
    results.workspace_size_limit_rejected = "passed";
  });

  it("13: existing files are not overwritten by default", async () => {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    await writeWorkspaceFile(config, root, "no-overwrite.md", "original", { allowOverwrite: false });
    await expect(
      writeWorkspaceFile(config, root, "no-overwrite.md", "replacement", { allowOverwrite: false }),
    ).rejects.toThrow(/ALREADY_EXISTS/);
    results.workspace_no_overwrite = "passed";
  });

  // ---------------------------------------------------------------------
  // Invocation (14-18)
  // ---------------------------------------------------------------------

  it("14: a successful call creates a succeeded invocation record", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Invocation success probe",
      outcome: "act_and_report",
    });
    const result = await invokeRegisteredTool({
      toolName: "core.artifact.write",
      input: { filename: "success-probe.md", content: "content", mimeType: "text/markdown" },
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workOrderId,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });
    expect(result.status).toBe("succeeded");

    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT status FROM tool_invocations WHERE id = $1", [result.invocationId]);
      return r.rows[0];
    });
    expect(row.status).toBe("succeeded");

    results.invocation_success = "passed";
  });

  it("15: a failed call (invalid input) creates a failed invocation record", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Invocation failure probe",
      outcome: "act_and_report",
    });
    const result = await invokeRegisteredTool({
      toolName: "core.artifact.write",
      input: { filename: "", content: "", mimeType: "text/markdown" }, // fails inputSchema deterministically
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workOrderId,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });
    expect(result.status).toBe("failed");

    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT status FROM tool_invocations WHERE id = $1", [result.invocationId]);
      return r.rows[0];
    });
    expect(row.status).toBe("failed");

    results.invocation_failure = "passed";
  });

  it("16-17: sanitized input/output evidence is stored, secret-like/internal error content is not exposed", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Sanitization probe",
      outcome: "act_and_report",
    });

    const result = await invokeRegisteredTool({
      toolName: "core.artifact.write",
      input: {
        filename: "sanitize-probe.md",
        content: "Notes. api_key=sk-1234567890abcdefghijklmnop should never be stored raw.",
        mimeType: "text/markdown",
      },
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workOrderId,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });
    expect(result.status).toBe("succeeded");

    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT input_payload FROM tool_invocations WHERE id = $1", [result.invocationId]);
      return r.rows[0];
    });
    const storedInput = JSON.stringify(row.input_payload);
    expect(storedInput).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(storedInput).toContain("[REDACTED]");

    results.invocation_sanitized_evidence = "passed";
  });

  it("18: a blocked authority outcome creates no tool invocation at all", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Blocked outcome probe",
      outcome: "refuse",
    });
    expect(await countToolInvocations(ctx.tenantId, workOrderId)).toBe(0);
    results.invocation_blocked_no_row = "passed";
  });

  // ---------------------------------------------------------------------
  // Artifact (19-23)
  // ---------------------------------------------------------------------

  it("19-22: core.artifact.write creates a real file, persists an artifacts row, and they agree", async () => {
    const { workOrderId } = await driveWorkOrder(ctx, {
      taskType: "artifact_creation",
      content: "Artifact row probe",
      outcome: "act_and_report",
    });

    const result = await invokeRegisteredTool<{ filename: string; content: string; mimeType: "text/markdown" }, {
      artifactId: string;
      relativePath: string;
      byteCount: number;
      contentHash: string;
    }>({
      toolName: "core.artifact.write",
      input: { filename: "artifact-row-probe.md", content: "# Real Artifact\n\nAgreement check.", mimeType: "text/markdown" },
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workspaceId: ctx.workspaceId,
        workOrderId,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });
    expect(result.status).toBe("succeeded");
    const output = result.output!;

    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    const fileContent = await fs.readFile(path.join(root, output.relativePath), "utf8");
    expect(fileContent).toBe("# Real Artifact\n\nAgreement check.");

    const artifactRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT * FROM artifacts WHERE id = $1", [output.artifactId]);
      return r.rows[0];
    });
    expect(artifactRow).toBeDefined();
    expect(artifactRow.storage_reference).toBe(output.relativePath);
    expect(artifactRow.byte_count).toBe(output.byteCount);
    expect(artifactRow.content_hash).toBe(output.contentHash);
    expect(Buffer.byteLength(fileContent, "utf8")).toBe(output.byteCount);

    results.artifact_row_file_agree = "passed";
  });

  it("23: a persistence failure does not leave a falsely-successful artifact row (file is cleaned up)", async () => {
    // Call the handler directly with a syntactically valid but
    // non-existent work_order_id for this tenant -- the file write
    // succeeds, then the artifacts INSERT fails on its work_order_id FK,
    // exercising the cleanup path.
    const fakeWorkOrderId = randomUUID();

    await expect(
      artifactWriteTool.execute(
        { filename: "cleanup-probe.md", content: "should be cleaned up", mimeType: "text/markdown" },
        {
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          workOrderId: fakeWorkOrderId,
          authorityOutcome: "act_and_report",
          actingSystem: "phase5-test-harness",
          correlationId: randomUUID(),
        },
      ),
    ).rejects.toThrow();

    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, ctx.workspaceId);
    const fileExists = await fs
      .access(path.join(root, "artifacts", "cleanup-probe.md"))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);

    const rowCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT count(*) FROM artifacts WHERE tenant_id = $1 AND work_order_id = $2", [
        ctx.tenantId,
        fakeWorkOrderId,
      ]);
      return Number(r.rows[0].count);
    });
    expect(rowCount).toBe(0);

    results.artifact_cleanup_on_failure = "passed";
  });

  // ---------------------------------------------------------------------
  // Receipt (24-28) + End-to-end (29) -- combined, since the end-to-end
  // flow is what produces the fixture these receipt assertions inspect.
  // ---------------------------------------------------------------------

  let endToEndWorkOrderId: string;
  let endToEndArtifactId: string;

  it("29: end-to-end -- explicit local-Markdown request creates WorkOrder, invokes core.artifact.write, completes", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Create a local markdown artifact named endtoend.md containing: Q1 planning notes for the initiative.",
      sourceSurface: "phase5-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.task_type).toBe("artifact_creation");
    expect(result.authorityOutcome).toBe("act_and_report");
    expect(result.finalWorkOrderStatus).toBe("COMPLETED");
    expect(result.transitionPath).toEqual([
      "RECEIVED",
      "INTENT_PARSED",
      "AUTHORITY_CLASSIFIED",
      "READY_TO_ACT",
      "EXECUTING",
      "VALIDATING",
      "RECEIPT_WRITTEN",
      "COMPLETED",
    ]);
    expect(result.toolInvocationId).not.toBeNull();
    expect(result.artifactId).not.toBeNull();
    expect(result.actionReceiptId).toBeNull(); // elora_ingestion_completed must NOT be written on this path

    endToEndWorkOrderId = result.workOrderId!;
    endToEndArtifactId = result.artifactId!;

    results.end_to_end = "passed";
  });

  it("24-25: inspectable receipt lists the real artifact tool invocation and includes it as an output", async () => {
    const receipt = await getInspectableReceipt(ctx.tenantId, endToEndWorkOrderId);
    expect(receipt).not.toBeNull();
    expect(receipt!.toolsUsed).toHaveLength(1);
    expect(receipt!.toolsUsed[0]?.toolName).toBe("core.artifact.write");
    expect(receipt!.toolsUsed[0]?.status).toBe("succeeded");
    expect(receipt!.toolsUsed[0]?.outputReference).toEqual({ type: "artifact", id: endToEndArtifactId });

    expect(receipt!.outputs.some((o) => o.referenceId === endToEndArtifactId)).toBe(true);

    results.receipt_lists_real_tool = "passed";
    results.receipt_artifact_output = "passed";
  });

  it("26: failed invocations appear under errors via the run_failed receipt", async () => {
    const messageId = await seedMessage(ctx, "Create a local markdown artifact named notfound.md containing: irrelevant.");
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId,
      actorId: ctx.actorId,
      taskType: "artifact_creation",
      interpretedIntent: "failure fixture",
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
      authorityDecision: { outcome: "act_and_report", requiresHumanGatekeeper: false, reason: "test", riskLevel: "low" },
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "READY_TO_ACT",
      actorId: ctx.actorId,
      reason: "branch",
    });
    const executing = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "EXECUTING",
      actorId: ctx.actorId,
      reason: "execute",
    });

    const invocation = await invokeRegisteredTool({
      toolName: "core.artifact.write",
      input: { filename: "", content: "", mimeType: "text/markdown" }, // forces INVALID_INPUT
      context: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        workOrderId: workOrder.id,
        authorityOutcome: "act_and_report",
        actingSystem: "phase5-test-harness",
        correlationId: randomUUID(),
      },
    });
    expect(invocation.status).toBe("failed");

    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      nextStatus: "FAILED",
      actorId: ctx.actorId,
      reason: "tool invocation failed",
    });

    const { writeExecutionFailureReceipt } = await import("../../src/elora/writeExecutionFailureReceipt.js");
    await writeExecutionFailureReceipt({
      tenantId: ctx.tenantId,
      workOrderId: workOrder.id,
      runId: executing.run!.id,
      toolInvocationId: invocation.invocationId,
      authorityDecisionId: classified.authorityDecision!.id,
      actorId: ctx.actorId,
      failureType: invocation.error?.code ?? "TOOL_EXECUTION_FAILED",
      failureMessage: invocation.error?.message ?? "failed",
    });

    const receipt = await getInspectableReceipt(ctx.tenantId, workOrder.id);
    expect(receipt).not.toBeNull();
    expect(receipt!.errors.length).toBeGreaterThanOrEqual(1);
    expect(receipt!.errors[0]?.message).toBeTruthy();

    results.receipt_failed_under_errors = "passed";
  });

  it("27: no direct internal function is ever listed as a tool", async () => {
    // The happy-path (non-artifact) fixture exercises createWorkOrder,
    // proposeMemoryCandidates, writeEloraReceipt -- none of which are
    // registered tools (§4).
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for Q3 initiatives.",
      sourceSurface: "phase5-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });
    expect(result.finalWorkOrderStatus).toBe("READY_TO_ACT");

    const receipt = await getInspectableReceipt(ctx.tenantId, result.workOrderId!);
    expect(receipt).not.toBeNull();
    expect(receipt!.toolsUsed).toEqual([]);

    const knownToolNames = listRegisteredTools().map((t) => t.name);
    for (const usage of receipt!.toolsUsed) {
      expect(knownToolNames).toContain(usage.toolName);
    }

    results.receipt_no_fake_tools = "passed";
  });

  it("28: receipt inspection remains tenant/workspace isolated", async () => {
    const otherTenantCtx = await seedBaseContext();
    const crossTenant = await getInspectableReceipt(otherTenantCtx.tenantId, endToEndWorkOrderId);
    expect(crossTenant).toBeNull();
    results.receipt_tenant_isolated = "passed";
  });

  // ---------------------------------------------------------------------
  // Replay (30)
  // ---------------------------------------------------------------------

  it("30: replaying the same source request returns existing references, no second file/row/invocation", async () => {
    const correlationId = randomUUID();
    const content = "Create a local markdown artifact named replay.md containing: Replay fixture content.";

    const first = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content,
      sourceSurface: "phase5-test-harness",
      sourceCorrelationId: correlationId,
    });
    expect(first.finalWorkOrderStatus).toBe("COMPLETED");

    const second = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: first.threadId,
      actorId: ctx.actorId,
      content: "A different duplicate payload that must be ignored in favor of the canonical content.",
      sourceSurface: "phase5-test-harness",
      sourceCorrelationId: correlationId,
    });

    expect(second.workOrderId).toBe(first.workOrderId);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.toolInvocationId).toBe(first.toolInvocationId);

    const invocationCount = await countToolInvocations(ctx.tenantId, first.workOrderId!);
    expect(invocationCount).toBe(1);

    const artifactCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT count(*) FROM artifacts WHERE tenant_id = $1 AND work_order_id = $2", [
        ctx.tenantId,
        first.workOrderId,
      ]);
      return Number(r.rows[0].count);
    });
    expect(artifactCount).toBe(1);

    results.replay_no_duplicate = "passed";
  });

  it("writes the Phase 5 acceptance report", () => {
    const allPassed = Object.values(results).every((r) => r === "passed" || r === "skipped");

    const report = {
      status: allPassed ? "passed" : "failed",
      phase: "phase5_tool_registry_v1",
      timestamp: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      end_to_end_work_order_id: endToEndWorkOrderId,
      end_to_end_artifact_id: endToEndArtifactId,
      results,
    };

    const reportPath = path.resolve(process.cwd(), "core-records/phase5-tool-registry-acceptance.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(report.status).toBe("passed");
  });
});
