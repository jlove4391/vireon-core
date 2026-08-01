import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { describeDelegation } from "../../src/state/describeDelegation.js";
import { StateReferenceNotFoundError } from "../../src/state/errors.js";
import { transitionWorkOrder } from "../../src/state/transitionWorkOrder.js";
import { writeDelegationReceipt } from "../../src/state/writeDelegationReceipt.js";
import { writeEloraReceipt } from "../../src/elora/writeEloraReceipt.js";
import { getInspectableReceipt } from "../../tools/diagnostics/workOrder.js";
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

    const delegationReason = "ELORA delegates implementation work to Nexora.";

    const { workOrder: child } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: nexoraId,
      taskType: "implementation",
      // Convention (not inherited from the parent, not left blank): a
      // synthesized description of the delegation itself.
      interpretedIntent: describeDelegation("Elora", "supervised", delegationReason),
      parentWorkOrderId: parent.id,
      delegationMode: "supervised",
    });

    const childRow = await fetchWorkOrder(ctx.tenantId, child.id);
    expect(childRow.parent_work_order_id).toBe(parent.id);
    expect(childRow.delegation_mode).toBe("supervised");
    expect(childRow.owner_actor_id).toBe(nexoraId);
    expect(child.interpreted_intent).toBe(describeDelegation("Elora", "supervised", delegationReason));
    expect(child.interpreted_intent).not.toBe(parent.interpreted_intent);

    const receipt = await writeDelegationReceipt({
      tenantId: ctx.tenantId,
      parentWorkOrderId: parent.id,
      childWorkOrderId: child.id,
      parentActorId: eloraId,
      childActorId: nexoraId,
      delegationMode: "supervised",
      reason: delegationReason,
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

    const delegationReason = "Cassian routes analysis work to Veyra as a structural peer.";

    const { workOrder: child } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: cassianId,
      ownerActorId: veyraId,
      taskType: "analysis",
      interpretedIntent: describeDelegation("Cassian", "peer", delegationReason),
      parentWorkOrderId: parent.id,
      delegationMode: "peer",
    });

    const childRow = await fetchWorkOrder(ctx.tenantId, child.id);
    expect(childRow.parent_work_order_id).toBe(parent.id);
    expect(childRow.delegation_mode).toBe("peer");
    expect(childRow.owner_actor_id).toBe(veyraId);
    expect(child.interpreted_intent).toBe(describeDelegation("Cassian", "peer", delegationReason));
    expect(child.interpreted_intent).not.toBe(parent.interpreted_intent);

    const receipt = await writeDelegationReceipt({
      tenantId: ctx.tenantId,
      parentWorkOrderId: parent.id,
      childWorkOrderId: child.id,
      parentActorId: cassianId,
      childActorId: veyraId,
      delegationMode: "peer",
      reason: delegationReason,
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

  it("getInspectableReceipt() labels inherited parent context for a delegated child, never presents it as the child's own request", async () => {
    const eloraId = ctx.personaIdsByName.get("Elora")!;
    const nexoraId = ctx.personaIdsByName.get("Nexora")!;
    const delegationReason = "ELORA delegates a follow-up analysis to Nexora.";
    const childIntent = describeDelegation("Elora", "supervised", delegationReason);

    const { workOrder: parent } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: eloraId,
      taskType: "planning",
      interpretedIntent: "Phase 6D inspectable-receipt parent",
    });

    const { workOrder: child } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      // Correctly reuses the parent's thread/message -- "context
      // inheritance by reference" per core-runtime.md §11.2. This is the
      // part that was always right; what needed fixing is how the
      // inspector *presents* it, not the data itself.
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: nexoraId,
      taskType: "analysis",
      interpretedIntent: childIntent,
      parentWorkOrderId: parent.id,
      delegationMode: "supervised",
    });

    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: child.id,
      nextStatus: "INTENT_PARSED",
      actorId: nexoraId,
      reason: "parse",
    });
    const classified = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: child.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: nexoraId,
      reason: "classify",
      authorityDecision: {
        outcome: "act_and_report",
        requiresHumanGatekeeper: false,
        reason: "Directly authorized delegated work.",
        riskLevel: "low",
      },
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: child.id,
      nextStatus: "READY_TO_ACT",
      actorId: nexoraId,
      reason: "route to READY_TO_ACT",
    });

    // Direct construction (no live caller exists to drive this through a
    // real pipeline yet) -- same synthetic-fixture approach as tests 1/2.
    await writeEloraReceipt({
      tenantId: ctx.tenantId,
      workOrderId: child.id,
      authorityDecisionId: classified.authorityDecision!.id,
      actorId: nexoraId,
      responseText: "Delegated analysis complete.",
      retrievedMemoryIds: [],
    });

    const receipt = await getInspectableReceipt(ctx.tenantId, child.id);
    expect(receipt).not.toBeNull();

    // The delegation link is surfaced explicitly...
    expect(receipt!.delegatedFrom).toEqual({ parentWorkOrderId: parent.id, delegationMode: "supervised" });

    // ...the reconstructed message is present (it's genuinely useful
    // context) but clearly labeled as the parent's, not the child's own...
    expect(receipt!.originalRequest).not.toBeNull();
    expect(receipt!.originalRequest!.messageId).toBe(ctx.messageId);
    expect(receipt!.originalRequest!.inheritedFromParent).toBe(true);

    // ...and interpretedIntent -- the child's own synthesized delegation
    // description -- is what actually identifies this WorkOrder, distinct
    // from the raw inherited message content.
    expect(receipt!.interpretedIntent.summary).toBe(childIntent);
    expect(receipt!.interpretedIntent.summary).not.toBe(receipt!.originalRequest!.content);

    // Comparison: an ordinary, non-delegated WorkOrder's own receipt never
    // carries a delegation label or an inheritance flag.
    const { workOrder: ordinary } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.sovereignId,
      taskType: "planning",
      interpretedIntent: "Phase 6D ordinary WorkOrder for inspectable-receipt comparison",
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: ordinary.id,
      nextStatus: "INTENT_PARSED",
      actorId: ctx.sovereignId,
      reason: "parse",
    });
    const ordinaryClassified = await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: ordinary.id,
      nextStatus: "AUTHORITY_CLASSIFIED",
      actorId: ctx.sovereignId,
      reason: "classify",
      authorityDecision: {
        outcome: "act_and_report",
        requiresHumanGatekeeper: false,
        reason: "Directly authorized.",
        riskLevel: "low",
      },
    });
    await transitionWorkOrder({
      tenantId: ctx.tenantId,
      workOrderId: ordinary.id,
      nextStatus: "READY_TO_ACT",
      actorId: ctx.sovereignId,
      reason: "route to READY_TO_ACT",
    });
    await writeEloraReceipt({
      tenantId: ctx.tenantId,
      workOrderId: ordinary.id,
      authorityDecisionId: ordinaryClassified.authorityDecision!.id,
      actorId: ctx.sovereignId,
      responseText: "Ordinary WorkOrder complete.",
      retrievedMemoryIds: [],
    });

    const ordinaryReceipt = await getInspectableReceipt(ctx.tenantId, ordinary.id);
    expect(ordinaryReceipt).not.toBeNull();
    expect(ordinaryReceipt!.delegatedFrom).toBeNull();
    expect(ordinaryReceipt!.originalRequest?.inheritedFromParent).toBe(false);
  });

  it("createWorkOrder() rejects a cross-tenant ownerActorId with StateReferenceNotFoundError, and persists no partial WorkOrder", async () => {
    const tenantB = await seedHierarchyContext();

    await expect(
      createWorkOrder({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        threadId: ctx.threadId,
        messageId: ctx.messageId,
        actorId: ctx.sovereignId,
        ownerActorId: tenantB.sovereignId,
        taskType: "planning",
        interpretedIntent: "Phase 6D cross-tenant ownerActorId attempt",
      }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS n FROM work_orders WHERE tenant_id = $1 AND interpreted_intent = $2",
        [ctx.tenantId, "Phase 6D cross-tenant ownerActorId attempt"],
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(rows).toBe(0);
  });

  it("writeDelegationReceipt() rejects a cross-tenant reference for each of its four ids, and persists no partial receipt", async () => {
    const tenantB = await seedHierarchyContext();
    const eloraId = ctx.personaIdsByName.get("Elora")!;
    const nexoraId = ctx.personaIdsByName.get("Nexora")!;
    const tenantBEloraId = tenantB.personaIdsByName.get("Elora")!;

    const { workOrder: parent } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: eloraId,
      ownerActorId: eloraId,
      taskType: "planning",
      interpretedIntent: "Phase 6D cross-tenant delegation-receipt parent",
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
      interpretedIntent: describeDelegation("Elora", "supervised", "cross-tenant guard check"),
      parentWorkOrderId: parent.id,
      delegationMode: "supervised",
    });
    const { workOrder: tenantBWorkOrder } = await createWorkOrder({
      tenantId: tenantB.tenantId,
      workspaceId: tenantB.workspaceId,
      projectId: tenantB.projectId,
      threadId: tenantB.threadId,
      messageId: tenantB.messageId,
      actorId: tenantBEloraId,
      taskType: "planning",
      interpretedIntent: "Phase 6D cross-tenant delegation-receipt tenant-B work order",
    });

    const baseInput = {
      tenantId: ctx.tenantId,
      parentWorkOrderId: parent.id,
      childWorkOrderId: child.id,
      parentActorId: eloraId,
      childActorId: nexoraId,
      delegationMode: "supervised" as const,
      reason: "cross-tenant guard check",
    };

    await expect(
      writeDelegationReceipt({ ...baseInput, parentWorkOrderId: tenantBWorkOrder.id }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);
    await expect(
      writeDelegationReceipt({ ...baseInput, childWorkOrderId: tenantBWorkOrder.id }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);
    await expect(
      writeDelegationReceipt({ ...baseInput, parentActorId: tenantBEloraId }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);
    await expect(
      writeDelegationReceipt({ ...baseInput, childActorId: tenantBEloraId }),
    ).rejects.toBeInstanceOf(StateReferenceNotFoundError);

    const receiptCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS n FROM action_receipts WHERE tenant_id = $1 AND receipt_type = 'agent_delegated' AND work_order_id = $2",
        [ctx.tenantId, child.id],
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(receiptCount).toBe(0);
  });

  // Item 6 (Phase 1-5, 6A, 6B, 6C regression) is verified by running the
  // full `pnpm test` suite, and item 7 (git diff scope on workOrderState.ts,
  // classifyAuthority.ts, resolveAuthorityWithHierarchy.ts, and the limited
  // createWorkOrder.ts diff) by `git diff` -- see the Phase 6D completion
  // report, not this file.
});
