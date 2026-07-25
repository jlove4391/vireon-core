import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { classifyAuthority } from "../../src/elora/classifyAuthority.js";
import {
  resolveAuthorityWithHierarchy,
  type StandingRuleMatchCriteria,
} from "../../src/elora/resolveAuthorityWithHierarchy.js";
import { createScheduledTrigger } from "../../src/elora/triggers/createScheduledTrigger.js";
import {
  InvalidScheduledTriggerInputError,
  ScheduledTriggerActorNotFoundError,
} from "../../src/elora/triggers/errors.js";
import { reconcileSovereign, seedPersonaRoster } from "../../scripts/seedPersonaRoster.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

interface HierarchyContext extends SeededContext {
  sovereignId: string;
  eloraId: string;
  /** Inner Circle, reports directly to Elora. Darius's immediate superior. */
  valtrixId: string;
  /** Outer Circle, reports to Valtrix (not directly to Elora) -- two-hop chain to Elora. */
  dariusId: string;
  /** Special Envoy, reports directly to Elora -- deliberately NOT under Valtrix. Used to prove a creator outside Valtrix's chain can't borrow a rule scoped to Valtrix. */
  jynxId: string;
}

/** Layers the Phase 6B hierarchy (Sovereign + full persona roster) on top of the standard Phase 1 base context -- same helper shape as phase6c's own. */
async function seedHierarchyContext(): Promise<HierarchyContext> {
  const ctx = await seedBaseContext();
  const idByName = await withTenantTransaction(ctx.tenantId, async (client) => {
    await reconcileSovereign(client, ctx.tenantId, ctx.actorId);
    return seedPersonaRoster(client, ctx.tenantId, ctx.actorId);
  });
  const resolve = (name: string): string => {
    const id = idByName.get(name);
    if (!id) throw new Error(`seedHierarchyContext: ${name} not resolved by seedPersonaRoster`);
    return id;
  };
  return {
    ...ctx,
    sovereignId: ctx.actorId,
    eloraId: resolve("Elora"),
    valtrixId: resolve("Valtrix"),
    dariusId: resolve("Darius"),
    jynxId: resolve("Jynx"),
  };
}

interface StandingRuleOverrides {
  scopeActorId: string;
  confirmedByActorId: string;
  matchCriteria: StandingRuleMatchCriteria;
}

async function insertStandingRule(tenantId: string, overrides: StandingRuleOverrides): Promise<string> {
  const id = randomUUID();
  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `INSERT INTO authority_standing_rules
         (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, match_criteria,
          confirmed_by_actor_id, status)
       VALUES ($1,$2,'approve',$3,$4,$5,$6,$7,'active')`,
      [
        id,
        tenantId,
        overrides.scopeActorId,
        "test-domain",
        "test standing rule",
        JSON.stringify(overrides.matchCriteria),
        overrides.confirmedByActorId,
      ],
    );
  });
  return id;
}

async function countScheduledTriggers(tenantId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT count(*)::int AS n FROM scheduled_triggers WHERE tenant_id = $1", [
      tenantId,
    ]);
    return result.rows[0].n as number;
  });
}

async function countWorkOrders(tenantId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT count(*)::int AS n FROM work_orders WHERE tenant_id = $1", [tenantId]);
    return result.rows[0].n as number;
  });
}

async function countReceiptsByType(tenantId: string, receiptType: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM action_receipts WHERE tenant_id = $1 AND receipt_type = $2",
      [tenantId, receiptType],
    );
    return result.rows[0].n as number;
  });
}

describe("Phase 6I: Scheduled Trigger Schema & Creation acceptance", () => {
  let ctx: HierarchyContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedHierarchyContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. precondition: classifyAuthority()/resolveAuthorityWithHierarchy() execute correctly with no WorkOrder created before, during, or after the call -- the structural basis Path B depends on", async () => {
    const before = await countWorkOrders(ctx.tenantId);

    const content = "Please send an email to the team about the schedule.";
    const baseline = classifyAuthority({ content, taskType: "unknown", resolvedProjectId: null });
    const resolved = await resolveAuthorityWithHierarchy({
      tenantId: ctx.tenantId,
      content,
      taskType: "unknown",
      resolvedProjectId: null,
      resolveStartingActorId: async () => ctx.eloraId,
    });

    expect(resolved.outcome).toBe(baseline.outcome);
    expect(resolved.outcome).toBe("escalate");
    expect(resolved.floorProtected).toBe(false);

    const after = await countWorkOrders(ctx.tenantId);
    expect(after).toBe(before);
  });

  it("2. authorized outcome (act_and_report, no standing rule): persists the trigger, an AuthorityDecision with work_order_id null, and exactly one trigger_created receipt", async () => {
    const result = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      owningActorId: ctx.eloraId,
      createdByActorId: ctx.sovereignId,
      scheduleKind: "cron",
      scheduleExpression: "0 8 * * *",
      timezone: "UTC",
      syntheticMessageContent: "Draft a summary of this week's project plan progress.",
      triggerCategory: "reminder",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected status: created");

    expect(result.trigger.owning_actor_id).toBe(ctx.eloraId);
    expect(result.trigger.created_by_actor_id).toBe(ctx.sovereignId);
    expect(result.trigger.status).toBe("active");
    expect(result.trigger.schedule_kind).toBe("cron");
    expect(result.trigger.authority_decision_id).toBe(result.authorityDecision.id);

    expect(result.authorityDecision.outcome).toBe("act_and_report");
    expect(result.authorityDecision.work_order_id).toBeNull();
    expect(result.authorityDecision.deciding_actor_id).toBe(ctx.sovereignId);

    const receiptRows = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query("SELECT * FROM action_receipts WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, result.receiptId]),
    );
    expect(receiptRows.rows).toHaveLength(1);
    expect(receiptRows.rows[0].receipt_type).toBe("trigger_created");
    expect(receiptRows.rows[0].payload.scheduled_trigger_id).toBe(result.trigger.id);
    expect(receiptRows.rows[0].payload.outcome).toBe("act_and_report");
  });

  it("3. blocked outcome (ordinary escalate): AuthorityDecision is persisted, but no scheduled_triggers row and no trigger_created receipt are ever written", async () => {
    const beforeTriggers = await countScheduledTriggers(ctx.tenantId);
    const beforeReceipts = await countReceiptsByType(ctx.tenantId, "trigger_created");

    const result = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      owningActorId: ctx.eloraId,
      createdByActorId: ctx.eloraId,
      scheduleKind: "interval",
      scheduleExpression: "P1D",
      syntheticMessageContent: "Every day, send an email to the team with a status update.",
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected status: blocked");
    expect(result.outcome).toBe("escalate");
    expect(result.authorityDecision.outcome).toBe("escalate");
    expect(result.authorityDecision.work_order_id).toBeNull();

    const afterTriggers = await countScheduledTriggers(ctx.tenantId);
    const afterReceipts = await countReceiptsByType(ctx.tenantId, "trigger_created");
    expect(afterTriggers).toBe(beforeTriggers);
    expect(afterReceipts).toBe(beforeReceipts);
  });

  it("4. floor-protected escalate never creates a row, even when a matching standing rule exists", async () => {
    await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "payment" },
    });
    const before = await countScheduledTriggers(ctx.tenantId);

    const result = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      owningActorId: ctx.eloraId,
      createdByActorId: ctx.eloraId,
      scheduleKind: "one_off",
      scheduleExpression: "2026-08-01T00:00:00.000Z",
      syntheticMessageContent: "Please send a payment to the vendor every month.",
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected status: blocked");
    expect(result.outcome).toBe("escalate");

    const after = await countScheduledTriggers(ctx.tenantId);
    expect(after).toBe(before);
  });

  it("5. ordinary escalate resolved via a standing rule held by the CREATOR's own superior: creates the trigger, resolved_via_standing_rule_id populated", async () => {
    // Rule scoped to Valtrix -- Darius's real immediate superior. Content
    // must actually hit classifyAuthority's ORDINARY_ESCALATE_CUE ("send an
    // email" / "calendar event") -- otherwise baseline is already
    // act_and_report and the standing-rule machinery is never consulted at
    // all, which would make this test pass for the wrong reason.
    const ruleId = await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.valtrixId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "calendar event" },
    });

    const result = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      // Darius both owns and requests this one -- the legitimate case.
      owningActorId: ctx.dariusId,
      createdByActorId: ctx.dariusId,
      scheduleKind: "cron",
      scheduleExpression: "0 9 * * MON",
      syntheticMessageContent: "Please schedule a calendar event for the Outer Circle ops sync.",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected status: created");
    expect(result.authorityDecision.outcome).toBe("act_and_report");
    expect(result.authorityDecision.resolved_via_standing_rule_id).toBe(ruleId);
  });

  it("6. a creator outside the rule's chain cannot borrow it by merely naming a differently-privileged owner (the gap flagged in review, now closed)", async () => {
    // Same rule shape as test 5: scoped to Valtrix, matching a "calendar
    // event" pattern. Jynx reports directly to Elora and never passes
    // through Valtrix at all -- if authority resolution incorrectly walked
    // from owningActorId (the pre-fix behavior), naming Darius as owner
    // would let Jynx's request inherit Valtrix's rule even though Jynx
    // himself has no relationship to it whatsoever.
    const ruleId = await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.valtrixId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "calendar event" },
    });

    const result = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      owningActorId: ctx.dariusId, // named owner IS under the rule's scope
      createdByActorId: ctx.jynxId, // but the actual requester is NOT
      scheduleKind: "cron",
      scheduleExpression: "0 9 * * TUE",
      syntheticMessageContent: "Please schedule a calendar event for the ops sync, alternate wording.",
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected status: blocked -- Jynx's own chain never reaches Valtrix's rule");
    expect(result.outcome).toBe("escalate");
    expect(result.authorityDecision.resolved_via_standing_rule_id).toBeNull();
    void ruleId; // exists and would match if the walk incorrectly started from owningActorId -- proven irrelevant here
  });

  it("7. idempotent retry: identical creation input returns the same trigger, decision, and receipt -- no duplicate rows", async () => {
    const input = {
      tenantId: ctx.tenantId,
      owningActorId: ctx.eloraId,
      createdByActorId: ctx.sovereignId,
      scheduleKind: "cron" as const,
      scheduleExpression: "0 7 * * *",
      syntheticMessageContent: "Draft the daily planning brief.",
    };

    const first = await createScheduledTrigger(input);
    const second = await createScheduledTrigger(input);

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") throw new Error("expected status: created");

    expect(second.trigger.id).toBe(first.trigger.id);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.authorityDecision.id).toBe(first.authorityDecision.id);

    const rows = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query("SELECT count(*)::int AS n FROM scheduled_triggers WHERE tenant_id = $1 AND id = $2", [
        ctx.tenantId,
        first.trigger.id,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);

    const receiptRows = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query("SELECT count(*)::int AS n FROM action_receipts WHERE tenant_id = $1 AND id = $2", [
        ctx.tenantId,
        first.receiptId,
      ]),
    );
    expect(receiptRows.rows[0].n).toBe(1);
  });

  it("8. cross-tenant isolation: a trigger created in tenant A is invisible under tenant B's context", async () => {
    const tenantB = await seedHierarchyContext();

    const created = await createScheduledTrigger({
      tenantId: ctx.tenantId,
      owningActorId: ctx.eloraId,
      createdByActorId: ctx.sovereignId,
      scheduleKind: "cron",
      scheduleExpression: "0 6 * * *",
      syntheticMessageContent: "Draft the morning briefing.",
    });
    if (created.status !== "created") throw new Error("expected status: created");

    const wrongTenantResult = await withTenantTransaction(tenantB.tenantId, (client) =>
      client.query("SELECT id FROM scheduled_triggers WHERE id = $1", [created.trigger.id]),
    );
    expect(wrongTenantResult.rows).toHaveLength(0);

    const correctTenantResult = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query("SELECT id FROM scheduled_triggers WHERE id = $1", [created.trigger.id]),
    );
    expect(correctTenantResult.rows).toHaveLength(1);
  });

  it("9. rejects malformed input before ever touching the database", async () => {
    await expect(
      createScheduledTrigger({
        tenantId: "not-a-uuid",
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.sovereignId,
        scheduleKind: "cron",
        scheduleExpression: "0 6 * * *",
        syntheticMessageContent: "test",
      }),
    ).rejects.toBeInstanceOf(InvalidScheduledTriggerInputError);

    await expect(
      createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.sovereignId,
        // @ts-expect-error -- deliberately invalid scheduleKind to exercise the validation branch
        scheduleKind: "not-a-real-kind",
        scheduleExpression: "0 6 * * *",
        syntheticMessageContent: "test",
      }),
    ).rejects.toBeInstanceOf(InvalidScheduledTriggerInputError);
  });

  it("10. rejects an unknown owning actor without creating anything", async () => {
    const before = await countScheduledTriggers(ctx.tenantId);

    await expect(
      createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: randomUUID(),
        createdByActorId: ctx.sovereignId,
        scheduleKind: "cron",
        scheduleExpression: "0 6 * * *",
        syntheticMessageContent: "test",
      }),
    ).rejects.toBeInstanceOf(ScheduledTriggerActorNotFoundError);

    const after = await countScheduledTriggers(ctx.tenantId);
    expect(after).toBe(before);
  });

  it("11. suite-level invariant: no test in this file ever created a WorkOrder -- Path B genuinely never touches work_orders", async () => {
    const count = await countWorkOrders(ctx.tenantId);
    expect(count).toBe(0);
  });
});
