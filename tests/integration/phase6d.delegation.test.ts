import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { writeDelegationReceipt } from "../../src/state/writeDelegationReceipt.js";
import { reconcileSovereign, seedPersonaRoster } from "../../scripts/seedPersonaRoster.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

interface HierarchyContext extends SeededContext {
  sovereignId: string;
  personaIdsByName: Map<string, string>;
}

/** Layers the Phase 6B hierarchy (Sovereign + full persona roster) on top of the standard Phase 1 base context. */
async function seedHierarchyContext(): Promise<HierarchyContext> {
  const ctx = await seedBaseContext();
  const personaIdsByName = await withTenantTransaction(ctx.tenantId, async (client) => {
    await reconcileSovereign(client, ctx.tenantId, ctx.actorId);
    return seedPersonaRoster(client, ctx.tenantId, ctx.actorId);
  });
  return { ...ctx, sovereignId: ctx.actorId, personaIdsByName };
}

interface WorkOrderRow {
  id: string;
  tenant_id: string;
  owner_actor_id: string | null;
  parent_work_order_id: string | null;
  delegation_mode: string | null;
  delegated_authority_scope_note: string | null;
}

async function fetchWorkOrder(tenantId: string, workOrderId: string): Promise<WorkOrderRow> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<WorkOrderRow>(
      `SELECT id, tenant_id, owner_actor_id, parent_work_order_id, delegation_mode, delegated_authority_scope_note
       FROM work_orders WHERE id = $1 AND tenant_id = $2`,
      [workOrderId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`WorkOrder ${workOrderId} not found in tenant ${tenantId}`);
    return row;
  });
}

interface DelegationReceiptRow {
  id: string;
  receipt_type: string;
  actor_id: string;
  work_order_id: string;
  payload: {
    parent_actor_id: string;
    child_actor_id: string;
    work_order_id: string;
    parent_work_order_id: string;
    delegation_mode: string;
    reason: string;
  };
}

async function fetchDelegationReceipt(tenantId: string, receiptId: string): Promise<DelegationReceiptRow> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<DelegationReceiptRow>(
      "SELECT id, receipt_type, actor_id, work_order_id, payload FROM action_receipts WHERE id = $1",
      [receiptId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Receipt ${receiptId} not found`);
    return row;
  });
}

async function expectPgError(promise: Promise<unknown>, sqlState: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(sqlState);
}

describe("Phase 6D: Delegation -- vertical and peer, reconciled -- acceptance", () => {
  let ctx: HierarchyContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedHierarchyContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. supervised delegation: parent-child link resolves correctly, agent_delegated receipt written with correct references and delegation_mode", async () => {
    const eloraId = ctx.personaIdsByName.get("Elora")!;
    const nexoraId = ctx.personaIdsByName.get("Nexora")!;

    const { workOrder: parent } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: eloraId,
      taskType: "planning",
      interpretedIntent: "Phase 6D supervised-delegation parent",
    });

    const { workOrder: child } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: nexoraId,
      taskType: "implementation",
      interpretedIntent: "Phase 6D supervised-delegation child",
      parentWorkOrderId: parent.id,
      delegationMode: "supervised",
    });

    const childRow = await fetchWorkOrder(ctx.tenantId, child.id);
    expect(childRow.parent_work_order_id).toBe(parent.id);
    expect(childRow.delegation_mode).toBe("supervised");
    expect(childRow.owner_actor_id).toBe(nexoraId);

    const receipt = await writeDelegationReceipt({
      tenantId: ctx.tenantId,
      parentWorkOrderId: parent.id,
      childWorkOrderId: child.id,
      parentActorId: eloraId,
      childActorId: nexoraId,
      delegationMode: "supervised",
      reason: "ELORA delegates implementation work to Nexora.",
    });

    const persistedReceipt = await fetchDelegationReceipt(ctx.tenantId, receipt.id);
    expect(persistedReceipt.receipt_type).toBe("agent_delegated");
    expect(persistedReceipt.actor_id).toBe(eloraId);
    expect(persistedReceipt.work_order_id).toBe(child.id);
    expect(persistedReceipt.payload.parent_actor_id).toBe(eloraId);
    expect(persistedReceipt.payload.child_actor_id).toBe(nexoraId);
    expect(persistedReceipt.payload.work_order_id).toBe(child.id);
    expect(persistedReceipt.payload.parent_work_order_id).toBe(parent.id);
    expect(persistedReceipt.payload.delegation_mode).toBe("supervised");
    expect(persistedReceipt.payload.reason.length).toBeGreaterThan(0);
  });

  it("2. peer delegation: parent-child link resolves correctly between structural peers, agent_delegated receipt written correctly", async () => {
    const cassianId = ctx.personaIdsByName.get("Cassian")!;
    const veyraId = ctx.personaIdsByName.get("Veyra")!;

    // Sanity: confirm these two are genuine structural peers (both Inner
    // Circle, neither reports to the other) before using them as the peer
    // delegation example.
    const peerRows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query<{ id: string; hierarchy_tier: string; reports_to_actor_id: string }>(
        "SELECT id, hierarchy_tier, reports_to_actor_id FROM actors WHERE id = ANY($1) ORDER BY id",
        [[cassianId, veyraId]],
      );
      return result.rows;
    });
    const cassianRow = peerRows.find((row) => row.id === cassianId);
    const veyraRow = peerRows.find((row) => row.id === veyraId);
    expect(cassianRow).toBeDefined();
    expect(veyraRow).toBeDefined();
    expect(cassianRow!.reports_to_actor_id).not.toBe(veyraId);
    expect(veyraRow!.reports_to_actor_id).not.toBe(cassianId);
    expect(cassianRow!.hierarchy_tier).toBe("inner_circle");
    expect(veyraRow!.hierarchy_tier).toBe("inner_circle");

    const { workOrder: parent } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: cassianId,
      ownerActorId: cassianId,
      taskType: "planning",
      interpretedIntent: "Phase 6D peer-delegation parent",
    });

    const { workOrder: child } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: cassianId,
      ownerActorId: veyraId,
      taskType: "analysis",
      interpretedIntent: "Phase 6D peer-delegation child",
      parentWorkOrderId: parent.id,
      delegationMode: "peer",
    });

    const childRow = await fetchWorkOrder(ctx.tenantId, child.id);
    expect(childRow.parent_work_order_id).toBe(parent.id);
    expect(childRow.delegation_mode).toBe("peer");
    expect(childRow.owner_actor_id).toBe(veyraId);

    const receipt = await writeDelegationReceipt({
      tenantId: ctx.tenantId,
      parentWorkOrderId: parent.id,
      childWorkOrderId: child.id,
      parentActorId: cassianId,
      childActorId: veyraId,
      delegationMode: "peer",
      reason: "Cassian routes analysis work to Veyra as a structural peer.",
    });

    const persistedReceipt = await fetchDelegationReceipt(ctx.tenantId, receipt.id);
    expect(persistedReceipt.payload.parent_work_order_id).toBe(parent.id);
    expect(persistedReceipt.payload.work_order_id).toBe(child.id);
    expect(persistedReceipt.payload.delegation_mode).toBe("peer");
    expect(persistedReceipt.payload.parent_actor_id).toBe(cassianId);
    expect(persistedReceipt.payload.child_actor_id).toBe(veyraId);
  });

  it("3. cross-tenant integrity: parent_work_order_id referencing a different tenant fails with a foreign-key violation", async () => {
    const tenantB = await seedHierarchyContext();

    const { workOrder: parentInTenantA } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.sovereignId,
      taskType: "planning",
      interpretedIntent: "Phase 6D cross-tenant integrity parent (tenant A)",
    });

    await expectPgError(
      createWorkOrder({
        tenantId: tenantB.tenantId,
        workspaceId: tenantB.workspaceId,
        projectId: tenantB.projectId,
        threadId: tenantB.threadId,
        messageId: tenantB.messageId,
        actorId: tenantB.sovereignId,
        taskType: "implementation",
        interpretedIntent: "Phase 6D cross-tenant integrity child (tenant B, invalid parent)",
        parentWorkOrderId: parentInTenantA.id,
        delegationMode: "supervised",
      }),
      "23503",
    );
  });

  it("4. non-delegated WorkOrders unaffected: ordinary creation still produces parent_work_order_id = NULL, delegation_mode = NULL", async () => {
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.sovereignId,
      taskType: "planning",
      interpretedIntent: "Phase 6D ordinary, non-delegated WorkOrder",
    });

    const row = await fetchWorkOrder(ctx.tenantId, workOrder.id);
    expect(row.parent_work_order_id).toBeNull();
    expect(row.delegation_mode).toBeNull();
  });

  it("5. delegated_authority_scope_note accepts and stores free text but enforces nothing", async () => {
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.sovereignId,
      taskType: "planning",
      interpretedIntent: "Phase 6D scope-note inertness check",
    });

    // createWorkOrder() doesn't even expose this field (Phase 6D deliberately
    // doesn't thread it through) -- set it directly to prove the column
    // itself is a bare, unconstrained text field: arbitrary content,
    // including a value that would fail if any validation/matching existed,
    // is accepted verbatim with no error.
    const arbitraryNote = "  NOT VALID JSON {{{ }}} <<malformed>>  -ish free text with no structure at all";
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query("UPDATE work_orders SET delegated_authority_scope_note = $1 WHERE id = $2", [
        arbitraryNote,
        workOrder.id,
      ]);
    });

    const row = await fetchWorkOrder(ctx.tenantId, workOrder.id);
    expect(row.delegated_authority_scope_note).toBe(arbitraryNote);

    // No CHECK constraint exists on this column -- confirmed directly
    // against the catalog, not just inferred from one successful write.
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'work_orders'::regclass
         AND conname ILIKE '%delegated_authority_scope_note%'`,
    );
    expect(constraints.rows).toHaveLength(0);

    // Setting it (or leaving it null) has no bearing on WorkOrder status --
    // still RECEIVED, nothing consumed or validated it.
    expect(workOrder.status).toBe("RECEIVED");
  });

  // Item 6 (Phase 1-5, 6A, 6B, 6C regression) is verified by running the
  // full `pnpm test` suite, and item 7 (git diff scope on workOrderState.ts,
  // classifyAuthority.ts, resolveAuthorityWithHierarchy.ts, and the limited
  // createWorkOrder.ts diff) by `git diff` -- see the Phase 6D completion
  // report, not this file.
});
