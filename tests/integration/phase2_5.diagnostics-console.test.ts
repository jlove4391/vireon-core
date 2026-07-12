import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { HAPPY_PATH_INTERPRETED_INTENT, HAPPY_PATH_TASK_TYPE, HAPPY_PATH_TRANSITIONS } from "../../src/state/lifecycleFixtures.js";
import { transitionWorkOrder } from "../../src/state/transitionWorkOrder.js";
import { listAcceptanceReports } from "../../tools/diagnostics/acceptanceReports.js";
import { readOnlyTenantQuery } from "../../tools/diagnostics/readOnlyTenantQuery.js";
import { listTenants, listWorkOrdersForTenant } from "../../tools/diagnostics/tenants.js";
import { getWorkOrderDetail } from "../../tools/diagnostics/workOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

describe("Phase 2.5: Diagnostic Runtime Console acceptance", () => {
  let ctx: SeededContext;
  let workOrderId: string;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();

    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.actorId,
      taskType: HAPPY_PATH_TASK_TYPE,
      interpretedIntent: HAPPY_PATH_INTERPRETED_INTENT,
    });
    workOrderId = workOrder.id;

    for (const fixture of HAPPY_PATH_TRANSITIONS) {
      await transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId,
        nextStatus: fixture.nextStatus,
        actorId: ctx.actorId,
        reason: fixture.reason,
        authorityDecision: fixture.authorityDecision,
        memoryCandidate: fixture.memoryCandidate,
      });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("readOnlyTenantQuery structurally rejects a write attempted inside it", async () => {
    await expect(
      readOnlyTenantQuery(async (client) => {
        await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
          randomUUID(),
          "should never be written",
        ]);
      }),
    ).rejects.toThrow(/read-only transaction/i);

    const tenants = await listTenants();
    expect(tenants.some((t) => t.name === "should never be written")).toBe(false);
  });

  it("tenants requires no tenant context and surfaces the seeded tenant", async () => {
    const tenants = await listTenants();
    expect(tenants.some((t) => t.id === ctx.tenantId)).toBe(true);
  });

  it("tenant scopes strictly by tenant_id (RLS-backed) and lists the created WorkOrder", async () => {
    const ownTenantWorkOrders = await listWorkOrdersForTenant(ctx.tenantId);
    expect(ownTenantWorkOrders.some((wo) => wo.id === workOrderId)).toBe(true);

    const otherTenantId = randomUUID();
    const wrongTenantWorkOrders = await listWorkOrdersForTenant(otherTenantId);
    expect(wrongTenantWorkOrders.some((wo) => wo.id === workOrderId)).toBe(false);
  });

  it("work-order returns null for a wrong tenant and the full lifecycle view for the right one", async () => {
    const otherTenantId = randomUUID();
    const wrongTenantResult = await getWorkOrderDetail(otherTenantId, workOrderId);
    expect(wrongTenantResult).toBeNull();

    const detail = await getWorkOrderDetail(ctx.tenantId, workOrderId);
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.workOrder.id).toBe(workOrderId);
    expect(detail.workOrder.tenant_id).toBe(ctx.tenantId);
    expect(detail.workOrder.status).toBe("COMPLETED");
    expect(detail.workOrder.authority_decision_id).not.toBeNull();

    // Full chronological transition history, including the initial NULL -> RECEIVED row.
    expect(detail.transitions).toHaveLength(HAPPY_PATH_TRANSITIONS.length + 1);
    expect(detail.transitions[0]?.from_status).toBeNull();
    expect(detail.transitions[0]?.to_status).toBe("RECEIVED");
    for (let i = 1; i < detail.transitions.length; i++) {
      const prev = detail.transitions[i - 1];
      const current = detail.transitions[i];
      expect(new Date(current!.created_at).getTime()).toBeGreaterThanOrEqual(new Date(prev!.created_at).getTime());
    }
    expect(detail.transitions.at(-1)?.to_status).toBe("COMPLETED");

    // Linked substantiating records.
    expect(detail.authorityDecision).not.toBeNull();
    expect(detail.authorityDecision?.outcome).toBe("act");
    expect(detail.authorityDecision?.id).toBe(detail.workOrder.authority_decision_id);

    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.status).toBe("VALIDATING");

    expect(detail.actionReceipts).toHaveLength(1);
    expect(detail.actionReceipts[0]?.receipt_type).toBe("state_transitioned");
    expect(detail.actionReceipts[0]?.payload.entity_id).toBe(workOrderId);

    expect(detail.memoryCandidates).toHaveLength(1);
    expect(detail.memoryCandidates[0]?.review_status).toBe("proposed");
  });

  it("acceptance lists and summarizes the existing core-records reports", () => {
    const reports = listAcceptanceReports();

    const phase1 = reports.find((r) => r.file === "phase1-database-spine-acceptance.json");
    const phase2 = reports.find((r) => r.file === "phase2-state-machine-acceptance.json");

    expect(phase1).toBeDefined();
    expect(phase1?.status).toBe("passed");
    expect(phase1?.timestamp).not.toBe("unknown");

    expect(phase2).toBeDefined();
    expect(phase2?.status).toBe("passed");
    expect(phase2?.timestamp).not.toBe("unknown");
  });
});
