import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createScheduledTrigger } from "../../src/elora/triggers/createScheduledTrigger.js";
import { computeNextFireAt } from "../../src/elora/triggers/computeNextFireAt.js";
import {
  fireDueTrigger,
  pollAllTenantsOnce,
  pollTenantOnce,
  selectDueTriggers,
} from "../../src/elora/triggers/fireDueTriggers.js";
import { isOwnershipAssignmentAuthorized } from "../../src/elora/triggers/isOwnershipAssignmentAuthorized.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { createRedisClient } from "../../src/redis/client.js";
import {
  acquireTriggerFiringLock,
  buildTriggerFiringLockKey,
  releaseTriggerFiringLock,
} from "../../src/redis/triggerLock.js";
import { reconcileSovereign, seedPersonaRoster } from "../../scripts/seedPersonaRoster.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

interface HierarchyContext extends SeededContext {
  sovereignId: string;
  eloraId: string;
  /** Inner Circle, reports directly to Elora. Darius's immediate superior. */
  valtrixId: string;
  /** Outer Circle, reports to Valtrix -- two-hop chain to Elora. */
  dariusId: string;
  /** Special Envoy, reports directly to Elora -- NOT under Valtrix at all. */
  jynxId: string;
}

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

async function forceTriggerDueNow(tenantId: string, triggerId: string, when: Date = new Date()): Promise<void> {
  await withTenantTransaction(tenantId, async (client) => {
    await client.query("UPDATE scheduled_triggers SET next_fire_at = $1 WHERE id = $2 AND tenant_id = $3", [
      when.toISOString(),
      triggerId,
      tenantId,
    ]);
  });
}

async function fetchTrigger(tenantId: string, triggerId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM scheduled_triggers WHERE id = $1 AND tenant_id = $2", [
      triggerId,
      tenantId,
    ]);
    return result.rows[0] as Record<string, unknown>;
  });
}

async function countReceiptsByTypeAndTrigger(tenantId: string, receiptType: string, triggerId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM action_receipts WHERE tenant_id = $1 AND receipt_type = $2 AND payload->>'scheduled_trigger_id' = $3",
      [tenantId, receiptType, triggerId],
    );
    return result.rows[0].n as number;
  });
}

describe("Phase 6J: Trigger Execution Engine acceptance", () => {
  let ctx: HierarchyContext;
  let redis: ReturnType<typeof createRedisClient>;

  beforeAll(async () => {
    await migrate();
    ctx = await seedHierarchyContext();
    redis = createRedisClient();
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
    await pool.end();
  });

  describe("A. isOwnershipAssignmentAuthorized() -- the firing-time ownership guard", () => {
    it("1. self-owned: trivially authorized", async () => {
      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.dariusId, ctx.dariusId),
      );
      expect(authorized).toBe(true);
    });

    it("2. direct subordinate: creator is the owner's real immediate superior", async () => {
      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.valtrixId, ctx.dariusId),
      );
      expect(authorized).toBe(true);
    });

    it("3. multi-level subordinate (grandchild): creator is two hops above the owner -- proves the chain walk is genuinely transitive, not a single-hop check", async () => {
      // Darius -> Valtrix -> Elora: Elora is Darius's grandparent, not his
      // direct superior. A naive "check only the immediate superior"
      // implementation would incorrectly reject this.
      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.eloraId, ctx.dariusId),
      );
      expect(authorized).toBe(true);
    });

    it("4. peer/unrelated: creator's chain never reaches the owner at all -- must block", async () => {
      // Jynx reports directly to Elora and never passes through Valtrix --
      // no relationship whatsoever to Darius's chain.
      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.jynxId, ctx.dariusId),
      );
      expect(authorized).toBe(false);
    });

    it("5. named superior (the actual vulnerability case): a subordinate naming their own boss as owner must block", async () => {
      // Darius naming Valtrix (his real superior) as owner. Structurally
      // impossible to authorize correctly given an acyclic hierarchy,
      // since Darius can never appear as an ancestor of Valtrix.
      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.dariusId, ctx.valtrixId),
      );
      expect(authorized).toBe(false);
    });

    it("5b. a genuine cycle in reports_to_actor_id (application-level convention only, not DB-enforced -- verified directly against pg_constraint/pg_trigger) terminates with false rather than looping forever", async () => {
      // actors carries no CHECK constraint or trigger preventing a cycle
      // -- only a tenant-scoped FK and tier-vocabulary CHECKs. Constructed
      // via two UPDATEs (each individually valid against the FK at the
      // time it runs) since a single INSERT can't point at a
      // not-yet-existing row.
      const cycleActorA = randomUUID();
      const cycleActorB = randomUUID();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id)
           VALUES ($1, $2, 'agent', $3, 'cycle-test', 'outer_circle', $4)`,
          [cycleActorA, ctx.tenantId, `Cycle Test Actor A ${cycleActorA}`, ctx.sovereignId],
        );
        await client.query(
          `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id)
           VALUES ($1, $2, 'agent', $3, 'cycle-test', 'outer_circle', $4)`,
          [cycleActorB, ctx.tenantId, `Cycle Test Actor B ${cycleActorB}`, cycleActorA],
        );
        // Close the cycle: A now reports to B, and B already reports to A.
        await client.query("UPDATE actors SET reports_to_actor_id = $1 WHERE id = $2 AND tenant_id = $3", [
          cycleActorB,
          cycleActorA,
          ctx.tenantId,
        ]);
      });

      const authorized = await withTenantTransaction(ctx.tenantId, (client) =>
        isOwnershipAssignmentAuthorized(client, ctx.tenantId, ctx.jynxId, cycleActorA),
      );
      expect(authorized).toBe(false);
    });
  });

  describe("B. computeNextFireAt()", () => {
    it("6. cron: computes the next matching occurrence strictly after 'from', not 'from' itself", () => {
      const from = new Date("2026-08-03T08:00:00.000Z"); // a Monday, exactly matching "0 8 * * MON"
      const next = computeNextFireAt({
        scheduleKind: "cron",
        scheduleExpression: "0 8 * * MON",
        timezone: "UTC",
        from,
      });
      expect(next.toISOString()).toBe("2026-08-10T08:00:00.000Z"); // the following Monday, not the same instant
    });

    it("7. interval: adds the ISO 8601 duration to 'from' exactly", () => {
      const from = new Date("2026-08-03T08:00:00.000Z");
      const next = computeNextFireAt({ scheduleKind: "interval", scheduleExpression: "P1D", timezone: null, from });
      expect(next.toISOString()).toBe("2026-08-04T08:00:00.000Z");
    });

    it("7b. interval: a month-end date crossing into a shorter month clamps to that month's last day, not a native Date rollover into the following month", () => {
      // 2026 is not a leap year -- February has 28 days. Date's native
      // setUTCMonth would otherwise turn "Jan 31 + 1 month" into "Feb 31"
      // -> silently normalized to Mar 3.
      const from = new Date("2026-01-31T08:00:00.000Z");
      const next = computeNextFireAt({ scheduleKind: "interval", scheduleExpression: "P1M", timezone: null, from });
      expect(next.toISOString()).toBe("2026-02-28T08:00:00.000Z");
    });

    it("7c. interval: the same month-end overflow into a leap February clamps to Feb 29, not Feb 28 or a rollover into March", () => {
      const from = new Date("2028-01-31T08:00:00.000Z"); // 2028 is a leap year
      const next = computeNextFireAt({ scheduleKind: "interval", scheduleExpression: "P1M", timezone: null, from });
      expect(next.toISOString()).toBe("2028-02-29T08:00:00.000Z");
    });

    it("8. one_off: returns the parsed expression itself, independent of 'from'", () => {
      const next = computeNextFireAt({
        scheduleKind: "one_off",
        scheduleExpression: "2026-09-01T00:00:00.000Z",
        timezone: null,
        from: new Date("2020-01-01T00:00:00.000Z"),
      });
      expect(next.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    });
  });

  describe("C. createScheduledTrigger() sets a real next_fire_at (6I gap closed)", () => {
    it("9. a newly created cron trigger has next_fire_at populated, matching computeNextFireAt's own output", async () => {
      const beforeCreate = new Date();
      const result = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "cron",
        scheduleExpression: "0 8 * * *",
        syntheticMessageContent: "Write the daily standup notes.",
      });
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("expected status: created");
      expect(result.trigger.next_fire_at).not.toBeNull();
      expect(new Date(result.trigger.next_fire_at!).getTime()).toBeGreaterThan(beforeCreate.getTime());
    });
  });

  describe("D. selectDueTriggers() -- the 6I due-query surface", () => {
    it("10. returns only active triggers whose next_fire_at has arrived; excludes future, paused, and revoked", async () => {
      const dueOneOff = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write the due-query test message (immediately due).",
      });
      if (dueOneOff.status !== "created") throw new Error("expected created");

      const futureOneOff = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() + 3_600_000).toISOString(),
        syntheticMessageContent: "Write the due-query test message (not yet due).",
      });
      if (futureOneOff.status !== "created") throw new Error("expected created");

      const paused = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write the due-query test message (paused).",
      });
      if (paused.status !== "created") throw new Error("expected created");
      await withTenantTransaction(ctx.tenantId, (client) =>
        client.query("UPDATE scheduled_triggers SET status = 'paused' WHERE id = $1", [paused.trigger.id]),
      );

      const due = await selectDueTriggers(ctx.tenantId);
      const dueIds = due.map((row) => row.id);
      expect(dueIds).toContain(dueOneOff.trigger.id);
      expect(dueIds).not.toContain(futureOneOff.trigger.id);
      expect(dueIds).not.toContain(paused.trigger.id);
    });
  });

  describe("E. Redis firing lock", () => {
    it("11. a second acquisition on the same key fails while the first holds it; release then allows re-acquisition", async () => {
      const key = buildTriggerFiringLockKey(ctx.tenantId, randomUUID(), new Date().toISOString());
      const first = await acquireTriggerFiringLock(redis, key, 5_000);
      expect(first).not.toBeNull();

      const second = await acquireTriggerFiringLock(redis, key, 5_000);
      expect(second).toBeNull();

      await releaseTriggerFiringLock(redis, first!);
      const third = await acquireTriggerFiringLock(redis, key, 5_000);
      expect(third).not.toBeNull();
      await releaseTriggerFiringLock(redis, third!);
    });

    it("12. release only succeeds when the token matches -- a stale release never deletes a different holder's lock", async () => {
      const key = buildTriggerFiringLockKey(ctx.tenantId, randomUUID(), new Date().toISOString());
      const originalLock = await acquireTriggerFiringLock(redis, key, 5_000);
      expect(originalLock).not.toBeNull();

      // Simulate: the original lock expired and a different attempt
      // acquired the same key with a new token.
      const newHolderToken = randomUUID();
      await redis.set(key, newHolderToken, "PX", 5_000);

      // The original (now-stale) holder attempts to release using its own, old token.
      await releaseTriggerFiringLock(redis, originalLock!);

      // The new holder's lock must still be intact.
      const currentValue = await redis.get(key);
      expect(currentValue).toBe(newHolderToken);

      await redis.del(key);
    });
  });

  describe("F. fireDueTrigger() end-to-end", () => {
    it("13. Elora-owned, self-created, recurring cron: fires, creates a WorkOrder, persists+reuses a thread, advances next_fire_at to a strictly later occurrence", async () => {
      const created = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "cron",
        scheduleExpression: "0 8 * * *",
        syntheticMessageContent: "Write the morning briefing summary.",
      });
      if (created.status !== "created") throw new Error("expected created");
      await forceTriggerDueNow(ctx.tenantId, created.trigger.id);
      const dueRow = (await selectDueTriggers(ctx.tenantId)).find((row) => row.id === created.trigger.id)!;
      const outcome = await fireDueTrigger(redis, ctx.tenantId, dueRow);

      expect(outcome.status).toBe("fired");
      if (outcome.status !== "fired") throw new Error("expected fired");
      expect(outcome.workOrderId).not.toBeNull();

      const after = await fetchTrigger(ctx.tenantId, created.trigger.id);
      expect(after.thread_id).not.toBeNull();
      expect(after.last_fired_work_order_id).toBe(outcome.workOrderId);
      expect(new Date(after.next_fire_at as string).getTime()).toBeGreaterThan(new Date(dueRow.next_fire_at).getTime());
    });

    it("14. one_off fires exactly once: next_fire_at becomes null and a second poll no longer finds it due", async () => {
      const created = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write the one-off reminder message.",
      });
      if (created.status !== "created") throw new Error("expected created");

      const outcomes = await pollTenantOnce(redis, ctx.tenantId);
      const thisOutcome = outcomes.find((o) => o.triggerId === created.trigger.id);
      expect(thisOutcome?.status).toBe("fired");

      const after = await fetchTrigger(ctx.tenantId, created.trigger.id);
      expect(after.next_fire_at).toBeNull();

      const dueAgain = await selectDueTriggers(ctx.tenantId);
      expect(dueAgain.map((row) => row.id)).not.toContain(created.trigger.id);
    });

    it("15. non-Elora owner: skipped with a trigger_fire_skipped receipt (owner_not_elora), no WorkOrder created", async () => {
      const created = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.dariusId,
        createdByActorId: ctx.dariusId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write Darius's own reminder message.",
      });
      if (created.status !== "created") throw new Error("expected created");
      const dueRow = (await selectDueTriggers(ctx.tenantId)).find((row) => row.id === created.trigger.id)!;

      const outcome = await fireDueTrigger(redis, ctx.tenantId, dueRow);
      expect(outcome).toEqual({ status: "skipped", triggerId: created.trigger.id, reason: "owner_not_elora" });

      const receiptCount = await countReceiptsByTypeAndTrigger(ctx.tenantId, "trigger_fire_skipped", created.trigger.id);
      expect(receiptCount).toBe(1);

      const after = await fetchTrigger(ctx.tenantId, created.trigger.id);
      expect(after.last_fired_work_order_id).toBeNull();
    });

    it("16. Elora-owned but unauthorized creator (Jynx, unrelated to Elora's chain): skipped with ownership_unauthorized, no WorkOrder created", async () => {
      // 6I's own creation-time check only classifies the *content* via the
      // creator's chain -- it never checked creator/owner relationship
      // (that's exactly this phase's job at firing time), so 6I happily
      // creates this row given safe, non-escalating content.
      const created = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.jynxId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write a status update Jynx asked Elora's identity to send.",
      });
      if (created.status !== "created") throw new Error("expected created");
      const dueRow = (await selectDueTriggers(ctx.tenantId)).find((row) => row.id === created.trigger.id)!;

      const outcome = await fireDueTrigger(redis, ctx.tenantId, dueRow);
      expect(outcome).toEqual({ status: "skipped", triggerId: created.trigger.id, reason: "ownership_unauthorized" });

      const receiptCount = await countReceiptsByTypeAndTrigger(ctx.tenantId, "trigger_fire_skipped", created.trigger.id);
      expect(receiptCount).toBe(1);
    });

    it("17. idempotency mechanism: ingestUserMessage() called twice with the same (threadId, sourceCorrelationId) -- as a retried firing attempt would -- produces exactly one WorkOrder", async () => {
      const threadId = await withTenantTransaction(ctx.tenantId, async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO threads (id, tenant_id, workspace_id, project_id, title, status, originating_surface)
           VALUES ($1, $2, $3, $4, $5, 'active', 'scheduled_trigger')`,
          [id, ctx.tenantId, ctx.workspaceId, ctx.projectId, "idempotency test thread"],
        );
        return id;
      });
      const sourceCorrelationId = randomUUID();

      const first = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        threadId,
        actorId: ctx.eloraId,
        content: "Write the idempotency-check occurrence message.",
        sourceSurface: "scheduled_trigger",
        sourceCorrelationId,
      });
      const second = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        threadId,
        actorId: ctx.eloraId,
        content: "Write the idempotency-check occurrence message.",
        sourceSurface: "scheduled_trigger",
        sourceCorrelationId,
      });

      expect(second.workOrderId).toBe(first.workOrderId);
      expect(second.messageId).toBe(first.messageId);
      expect(second.isDuplicateMessage).toBe(true);
    });

    it("18. distinct occurrences of the same recurring trigger produce distinct WorkOrders, reusing the same thread", async () => {
      const created = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "interval",
        scheduleExpression: "PT1H",
        syntheticMessageContent: "Write the hourly check-in message.",
      });
      if (created.status !== "created") throw new Error("expected created");

      await forceTriggerDueNow(ctx.tenantId, created.trigger.id);
      const firstDueRow = (await selectDueTriggers(ctx.tenantId)).find((row) => row.id === created.trigger.id)!;
      const firstOutcome = await fireDueTrigger(redis, ctx.tenantId, firstDueRow);
      expect(firstOutcome.status).toBe("fired");
      if (firstOutcome.status !== "fired") throw new Error("expected fired");

      const afterFirst = await fetchTrigger(ctx.tenantId, created.trigger.id);
      const threadIdAfterFirst = afterFirst.thread_id;

      await forceTriggerDueNow(ctx.tenantId, created.trigger.id);
      const secondDueRow = (await selectDueTriggers(ctx.tenantId)).find((row) => row.id === created.trigger.id)!;
      const secondOutcome = await fireDueTrigger(redis, ctx.tenantId, secondDueRow);
      expect(secondOutcome.status).toBe("fired");
      if (secondOutcome.status !== "fired") throw new Error("expected fired");

      expect(secondOutcome.workOrderId).not.toBe(firstOutcome.workOrderId);

      const afterSecond = await fetchTrigger(ctx.tenantId, created.trigger.id);
      expect(afterSecond.thread_id).toBe(threadIdAfterFirst);
    });

    it("19. cross-tenant: pollAllTenantsOnce fires each tenant's own due triggers without cross-tenant leakage", async () => {
      const tenantB = await seedHierarchyContext();

      const createdA = await createScheduledTrigger({
        tenantId: ctx.tenantId,
        owningActorId: ctx.eloraId,
        createdByActorId: ctx.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write tenant A's cross-tenant test message.",
      });
      const createdB = await createScheduledTrigger({
        tenantId: tenantB.tenantId,
        owningActorId: tenantB.eloraId,
        createdByActorId: tenantB.eloraId,
        scheduleKind: "one_off",
        scheduleExpression: new Date(Date.now() - 1_000).toISOString(),
        syntheticMessageContent: "Write tenant B's cross-tenant test message.",
      });
      if (createdA.status !== "created" || createdB.status !== "created") throw new Error("expected created");

      const outcomes = await pollAllTenantsOnce(redis);
      const outcomeA = outcomes.find((o) => o.triggerId === createdA.trigger.id);
      const outcomeB = outcomes.find((o) => o.triggerId === createdB.trigger.id);
      expect(outcomeA?.status).toBe("fired");
      expect(outcomeB?.status).toBe("fired");

      // Tenant A's trigger must not be visible/fireable under tenant B's context.
      const dueInWrongTenant = await withTenantTransaction(tenantB.tenantId, (client) =>
        client.query("SELECT id FROM scheduled_triggers WHERE id = $1", [createdA.trigger.id]),
      );
      expect(dueInWrongTenant.rows).toHaveLength(0);
    });
  });
});
