import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { classifyAuthority, type ClassifyAuthorityInput } from "../../src/elora/classifyAuthority.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import {
  resolveAuthorityWithHierarchy,
  type StandingRuleMatchCriteria,
} from "../../src/elora/resolveAuthorityWithHierarchy.js";
import { reconcileSovereign, seedPersonaRoster } from "../../scripts/seedPersonaRoster.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

interface HierarchyContext extends SeededContext {
  sovereignId: string;
  eloraId: string;
}

/** Layers the Phase 6B hierarchy (Sovereign + full persona roster) on top of the standard Phase 1 base context. */
async function seedHierarchyContext(): Promise<HierarchyContext> {
  const ctx = await seedBaseContext();
  const eloraId = await withTenantTransaction(ctx.tenantId, async (client) => {
    await reconcileSovereign(client, ctx.tenantId, ctx.actorId);
    const idByName = await seedPersonaRoster(client, ctx.tenantId, ctx.actorId);
    const id = idByName.get("Elora");
    if (!id) throw new Error("seedHierarchyContext: Elora not resolved by seedPersonaRoster");
    return id;
  });
  return { ...ctx, sovereignId: ctx.actorId, eloraId };
}

interface StandingRuleOverrides {
  scopeActorId: string;
  confirmedByActorId: string;
  domain?: string;
  patternDescription?: string;
  matchCriteria: StandingRuleMatchCriteria;
  polarity?: "approve" | "refuse";
  status?: "active" | "revoked";
  revokedByActorId?: string;
  revocationReason?: string;
}

async function insertStandingRule(tenantId: string, overrides: StandingRuleOverrides): Promise<string> {
  const id = randomUUID();
  const status = overrides.status ?? "active";
  const revokedAt = status === "revoked" ? new Date().toISOString() : null;
  const revokedBy = status === "revoked" ? overrides.revokedByActorId ?? overrides.confirmedByActorId : null;
  const revocationReason = status === "revoked" ? overrides.revocationReason ?? "test revocation" : null;

  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `INSERT INTO authority_standing_rules
         (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, match_criteria,
          confirmed_by_actor_id, status, revoked_by_actor_id, revocation_reason, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        tenantId,
        overrides.polarity ?? "approve",
        overrides.scopeActorId,
        overrides.domain ?? "test-domain",
        overrides.patternDescription ?? "test standing rule",
        JSON.stringify(overrides.matchCriteria),
        overrides.confirmedByActorId,
        status,
        revokedBy,
        revocationReason,
        revokedAt,
      ],
    );
  });

  return id;
}

async function fetchResolvedViaStandingRuleId(tenantId: string, authorityDecisionId: string): Promise<string | null> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ resolved_via_standing_rule_id: string | null }>(
      "SELECT resolved_via_standing_rule_id FROM authority_decisions WHERE id = $1",
      [authorityDecisionId],
    );
    return result.rows[0]?.resolved_via_standing_rule_id ?? null;
  });
}

const NEVER_CALL = () => {
  throw new Error("resolveStartingActorId should not be invoked for this outcome -- resolution must short-circuit before it");
};

describe("Phase 6C: Authority Resolution Engine acceptance", () => {
  let ctx: HierarchyContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedHierarchyContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  const BASELINE_CASES: Array<{ label: string; input: ClassifyAuthorityInput }> = [
    {
      label: "refuse",
      input: { content: "Steal credentials from another tenant.", taskType: "unknown", resolvedProjectId: null },
    },
    {
      label: "capability_missing",
      input: {
        content: "Please manufacture a 3D printed prototype part.",
        taskType: "unknown",
        resolvedProjectId: null,
      },
    },
    {
      label: "setup_required",
      input: { content: "Implement a new feature.", taskType: "implementation", resolvedProjectId: null },
    },
    {
      label: "act_and_report",
      input: { content: "Draft a project plan for next quarter.", taskType: "planning", resolvedProjectId: null },
    },
    {
      label: "floor-protected escalate",
      input: {
        content: "Please deploy this change to production.",
        taskType: "unknown",
        resolvedProjectId: null,
      },
    },
  ];

  it.each(BASELINE_CASES)(
    "1. baseline pass-through, no rules exist: $label resolves identically with and without the wrapper",
    async ({ input }) => {
      const baseline = classifyAuthority(input);

      const resolved = await resolveAuthorityWithHierarchy({
        ...input,
        tenantId: ctx.tenantId,
        resolveStartingActorId: NEVER_CALL,
      });

      expect(resolved.outcome).toBe(baseline.outcome);
      expect(resolved.reason).toBe(baseline.reason);
      expect(resolved.reasonCode).toBe(baseline.reasonCode);
      expect(resolved.risk_level).toBe(baseline.risk_level);
      expect(resolved.required_setup).toBe(baseline.required_setup);
      expect(resolved.requires_human_gatekeeper).toBe(baseline.requires_human_gatekeeper);
      expect(resolved.floorProtected).toBe(baseline.floorProtected);
      expect(resolved.resolvedViaStandingRuleId).toBeNull();
    },
  );

  it("2. ordinary escalate, no matching rule: climbs the full chain (ELORA -> Sovereign), finds nothing, genuine unresolved escalate", async () => {
    const input: ClassifyAuthorityInput = {
      content: "Please send an email to the team about the schedule.",
      taskType: "unknown",
      resolvedProjectId: null,
    };
    const baseline = classifyAuthority(input);
    expect(baseline.outcome).toBe("escalate");
    expect(baseline.floorProtected).toBe(false);

    const resolved = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: async () => ctx.eloraId,
    });

    expect(resolved.outcome).toBe("escalate");
    expect(resolved.reason).toBe(baseline.reason);
    expect(resolved.floorProtected).toBe(false);
    expect(resolved.resolvedViaStandingRuleId).toBeNull();
  });

  it(
    "2b. a genuine cycle in reports_to_actor_id (application-level convention only, not DB-enforced -- verified directly against pg_constraint/pg_trigger, same finding as isOwnershipAssignmentAuthorized.ts's own doc comment for this column) terminates with the same genuine-unresolved-escalation shape as reaching the Sovereign, rather than hanging",
    async () => {
      // actors carries no CHECK constraint or trigger preventing a cycle --
      // only the tenant-scoped composite FK and tier-vocabulary CHECKs.
      // Constructed via two INSERTs plus a closing UPDATE, same technique
      // as phase6j's test 5b (a single INSERT can't point at a
      // not-yet-existing row).
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

      // "calendar event", not "send an email" -- test 3 (below) leaves an
      // active approve rule matching "send (an )?email" in this shared
      // tenant; same avoidance already used by tests 5/6 in this file.
      const input: ClassifyAuthorityInput = {
        content: "Please schedule a calendar event for the cycle-guard-marker topic.",
        taskType: "unknown",
        resolvedProjectId: null,
      };
      const baseline = classifyAuthority(input);
      expect(baseline.outcome).toBe("escalate");
      expect(baseline.floorProtected).toBe(false);

      const resolved = await resolveAuthorityWithHierarchy({
        ...input,
        tenantId: ctx.tenantId,
        resolveStartingActorId: async () => cycleActorA,
      });

      expect(resolved.outcome).toBe(baseline.outcome);
      expect(resolved.reason).toBe(baseline.reason);
      expect(resolved.floorProtected).toBe(baseline.floorProtected);
      expect(resolved.resolvedViaStandingRuleId).toBeNull();
    },
    5_000,
  );

  it("3. ordinary escalate, matching rule at the immediate superior: resolves to act_and_report, resolved_via_standing_rule_id populated (in-process and persisted)", async () => {
    const ruleId = await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "send (an )?email" },
    });

    const input: ClassifyAuthorityInput = {
      content: "Please send an email to the team about the schedule.",
      taskType: "unknown",
      resolvedProjectId: null,
    };

    const resolved = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: async () => ctx.eloraId,
    });

    expect(resolved.outcome).toBe("act_and_report");
    expect(resolved.requires_human_gatekeeper).toBe(false);
    expect(resolved.resolvedViaStandingRuleId).toBe(ruleId);
    expect(resolved.reason).toContain(ruleId);
    expect(resolved.reason).toContain(ctx.sovereignId);

    // End-to-end: the same resolution, driven through the real ingestion
    // pipeline, persists resolved_via_standing_rule_id onto the
    // authority_decisions row -- not just the in-process return value.
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Please send an email to the team about the schedule.",
      sourceSurface: "phase6c-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    expect(result.authorityOutcome).toBe("act_and_report");
    expect(result.authorityDecisionId).not.toBeNull();
    const persisted = await fetchResolvedViaStandingRuleId(ctx.tenantId, result.authorityDecisionId!);
    expect(persisted).toBe(ruleId);
  });

  it("4. floor-protected escalate never resolves via standing rule, even when a matching rule exists", async () => {
    const ruleId = await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "payment" },
    });

    const input: ClassifyAuthorityInput = {
      content: "Please send a payment to the vendor.",
      taskType: "unknown",
      resolvedProjectId: null,
    };
    const baseline = classifyAuthority(input);
    expect(baseline.outcome).toBe("escalate");
    expect(baseline.floorProtected).toBe(true);

    const resolved = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: NEVER_CALL,
    });

    expect(resolved.outcome).toBe("escalate");
    expect(resolved.floorProtected).toBe(true);
    expect(resolved.resolvedViaStandingRuleId).toBeNull();
    expect(resolved.reason).toBe(baseline.reason);
    void ruleId; // the rule exists and would match -- proven irrelevant since floor-protected short-circuits before any lookup
  });

  it("5. inactive/revoked rules are never matched", async () => {
    await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "revoked-rule-marker" },
      status: "revoked",
    });

    // "calendar event" (not "send an email") -- test 3 already left an
    // active approve rule matching "send (an )?email" in this shared
    // tenant, and this test must not accidentally match it.
    const input: ClassifyAuthorityInput = {
      content: "Please schedule a calendar event for the revoked-rule-marker topic.",
      taskType: "unknown",
      resolvedProjectId: null,
    };

    const resolved = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: async () => ctx.eloraId,
    });

    expect(resolved.outcome).toBe("escalate");
    expect(resolved.resolvedViaStandingRuleId).toBeNull();
  });

  it("6. refuse-polarity rows are never consulted -- zero effect on any outcome", async () => {
    await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "refuse-polarity-marker" },
      polarity: "refuse",
    });

    // Same reasoning as test 5 -- avoid the "send (an )?email" rule already active in this tenant.
    const input: ClassifyAuthorityInput = {
      content: "Please schedule a calendar event for the refuse-polarity-marker topic.",
      taskType: "unknown",
      resolvedProjectId: null,
    };

    const resolved = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: async () => ctx.eloraId,
    });

    // A refuse-polarity rule can never resolve anything in 6C -- the query
    // only ever selects polarity = 'approve'. Outcome stays a genuine,
    // unresolved ordinary escalate, not 'refuse' and not 'act_and_report'.
    expect(resolved.outcome).toBe("escalate");
    expect(resolved.resolvedViaStandingRuleId).toBeNull();
  });

  it("7. cross-tenant isolation: a standing rule in tenant A never resolves a request in tenant B", async () => {
    const tenantB = await seedHierarchyContext();

    // Tenant A's rule, scoped to tenant A's own Sovereign -- actors.id is a
    // global primary key, so a literal cross-tenant id collision on
    // scope_actor_id is structurally impossible; two independently seeded
    // tenants with the same rule pattern is the strongest constructible
    // proxy for "coincidentally reused" isolation proof.
    await insertStandingRule(ctx.tenantId, {
      scopeActorId: ctx.sovereignId,
      confirmedByActorId: ctx.sovereignId,
      matchCriteria: { contentPattern: "send (an )?email" },
    });

    const input: ClassifyAuthorityInput = {
      content: "Please send an email to the team about the schedule.",
      taskType: "unknown",
      resolvedProjectId: null,
    };

    const resolvedInTenantB = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: tenantB.tenantId,
      resolveStartingActorId: async () => tenantB.eloraId,
    });

    expect(resolvedInTenantB.outcome).toBe("escalate");
    expect(resolvedInTenantB.resolvedViaStandingRuleId).toBeNull();

    // Sanity check: the same content resolves in tenant A, proving the
    // rule itself is valid and matchable -- isolation, not a broken rule.
    const resolvedInTenantA = await resolveAuthorityWithHierarchy({
      ...input,
      tenantId: ctx.tenantId,
      resolveStartingActorId: async () => ctx.eloraId,
    });
    expect(resolvedInTenantA.outcome).toBe("act_and_report");
    expect(resolvedInTenantA.resolvedViaStandingRuleId).not.toBeNull();
  });

  // Item 8 (Phase 1-5 and 6A/6B regression) is verified by running the full
  // `pnpm test` suite, and item 9 (git diff scope on classifyAuthority.ts)
  // by `git diff` -- see the Phase 6C completion report, not this file.
});
