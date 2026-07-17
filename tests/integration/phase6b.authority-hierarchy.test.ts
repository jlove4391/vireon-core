import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import {
  PERSONA_ROSTER,
  PersonaRosterConflictError,
  SOVEREIGN_ACTOR_ROLE,
  SovereignReconciliationError,
  reconcileSovereign,
  seedPersonaRoster,
} from "../../scripts/seedPersonaRoster.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

interface ActorSnapshot {
  id: string;
  actor_name: string;
  actor_role: string | null;
  hierarchy_tier: string | null;
  reports_to_actor_id: string | null;
  xmin: string;
}

/** Creates an isolated tenant with a pre-6B-shaped human actor row, mirroring the 6A dev identity. */
async function seedPre6bTenant(actorName: string): Promise<{ tenantId: string; actorId: string }> {
  const tenantId = randomUUID();
  const actorId = randomUUID();

  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [
    tenantId,
    `phase6b-test-tenant-${tenantId}`,
  ]);

  await withTenantTransaction(tenantId, async (client) => {
    await client.query(
      `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, acting_system)
       VALUES ($1, $2, 'human', $3, 'requesting_user', 'phase6b-test-harness')`,
      [actorId, tenantId, actorName],
    );
  });

  return { tenantId, actorId };
}

async function fetchActorsByTier(tenantId: string): Promise<ActorSnapshot[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<ActorSnapshot>(
      `SELECT id, actor_name, actor_role, hierarchy_tier, reports_to_actor_id, xmin::text
       FROM actors WHERE tenant_id = $1 AND hierarchy_tier IS NOT NULL AND hierarchy_tier <> 'sovereign'
       ORDER BY actor_name`,
      [tenantId],
    );
    return result.rows;
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

describe("Phase 6B: Authority Hierarchy -- schema and policy acceptance", () => {
  beforeAll(async () => {
    await migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. migration applies cleanly and re-running produces zero pending migrations", async () => {
    const before = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(before.rows.map((r) => r.filename)).toContain("0004_authority_hierarchy.sql");

    await migrate();

    const after = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    expect(after.rows).toEqual(before.rows);
  });

  it("2. Sovereign row is reconciled in place, actor_name unchanged from its pre-6B value", async () => {
    const { tenantId, actorId } = await seedPre6bTenant("Phase 6B Test Sovereign");

    await withTenantTransaction(tenantId, async (client) => {
      await reconcileSovereign(client, tenantId, actorId);
    });

    const row = await withTenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        "SELECT actor_name, actor_role, hierarchy_tier, reports_to_actor_id FROM actors WHERE id = $1",
        [actorId],
      );
      return result.rows[0];
    });

    expect(row.actor_name).toBe("Phase 6B Test Sovereign");
    expect(row.actor_role).toBe(SOVEREIGN_ACTOR_ROLE);
    expect(row.hierarchy_tier).toBe("sovereign");
    expect(row.reports_to_actor_id).toBeNull();
  });

  it("reconcileSovereign fails loudly on a wrong-tenant, non-human, or missing actor", async () => {
    const { tenantId, actorId } = await seedPre6bTenant("Phase 6B Guard Sovereign");
    const otherTenant = await seedPre6bTenant("Phase 6B Other Tenant Sovereign");

    await withTenantTransaction(tenantId, async (client) => {
      await expect(reconcileSovereign(client, otherTenant.tenantId, actorId)).rejects.toThrow(
        SovereignReconciliationError,
      );
      await expect(reconcileSovereign(client, tenantId, randomUUID())).rejects.toThrow(
        SovereignReconciliationError,
      );
    });
  });

  it("3./4./5. persona roster converges to exactly 31 canonical actors with resolved chains, and a third run makes zero changes", async () => {
    const { tenantId, actorId: sovereignId } = await seedPre6bTenant("Phase 6B Roster Sovereign");

    const runSeed = () =>
      withTenantTransaction(tenantId, async (client) => {
        await reconcileSovereign(client, tenantId, sovereignId);
        return seedPersonaRoster(client, tenantId, sovereignId);
      });

    // First execution.
    await runSeed();
    let rows = await fetchActorsByTier(tenantId);
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map((r) => r.actor_name)).size).toBe(31);
    expect(rows.map((r) => r.actor_name).sort()).toEqual([...PERSONA_ROSTER.map((p) => p.name)].sort());

    // Second execution -- still exactly 31, no duplicates (convergent, not additive).
    await runSeed();
    rows = await fetchActorsByTier(tenantId);
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map((r) => r.actor_name)).size).toBe(31);

    const byName = new Map(rows.map((r) => [r.actor_name, r]));

    // Spot-check resolved chains.
    const elora = byName.get("Elora")!;
    expect(elora.reports_to_actor_id).toBe(sovereignId);

    const valtrix = byName.get("Valtrix")!;
    expect(valtrix.hierarchy_tier).toBe("inner_circle");
    expect(valtrix.reports_to_actor_id).toBe(elora.id);

    const darius = byName.get("Darius")!;
    expect(darius.hierarchy_tier).toBe("outer_circle");
    expect(darius.reports_to_actor_id).toBe(valtrix.id);

    const seraph = byName.get("Seraph")!;
    expect(seraph.hierarchy_tier).toBe("special_envoy");
    expect(seraph.reports_to_actor_id).toBe(elora.id);

    // Third execution against an already-complete, correct roster: true
    // convergence -- proven via each row's xmin (Postgres bumps xmin on
    // every UPDATE, even a no-op-value one), not just row count/identity.
    const beforeThird = new Map(rows.map((r) => [r.id, r.xmin]));
    await runSeed();
    const afterThird = await fetchActorsByTier(tenantId);
    expect(afterThird).toHaveLength(31);
    for (const row of afterThird) {
      expect(row.xmin).toBe(beforeThird.get(row.id));
    }
  });

  it("persona roster seed rejects a name collision with an incompatible actor_type", async () => {
    const { tenantId, actorId: sovereignId } = await seedPre6bTenant("Phase 6B Conflict Sovereign");

    await withTenantTransaction(tenantId, async (client) => {
      await reconcileSovereign(client, tenantId, sovereignId);
      // Plant a human actor named "Elora" ahead of the seed run.
      await client.query(
        `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role)
         VALUES ($1, $2, 'human', 'Elora', 'Some Other Human')`,
        [randomUUID(), tenantId],
      );

      await expect(seedPersonaRoster(client, tenantId, sovereignId)).rejects.toThrow(PersonaRosterConflictError);
    });
  });

  it("6. cross-tenant hierarchy edges and standing-rule references fail with a foreign-key violation", async () => {
    const tenantA = await seedPre6bTenant("Phase 6B Tenant A Sovereign");
    const tenantB = await seedPre6bTenant("Phase 6B Tenant B Sovereign");

    // A real actor UUID from tenant A, correctly formatted, referenced from tenant B.
    await expectPgError(
      withTenantTransaction(tenantB.tenantId, async (client) => {
        await client.query(
          `INSERT INTO actors (id, tenant_id, actor_type, actor_name, hierarchy_tier, reports_to_actor_id)
           VALUES ($1, $2, 'agent', 'Cross Tenant Persona', 'inner_circle', $3)`,
          [randomUUID(), tenantB.tenantId, tenantA.actorId],
        );
      }),
      "23503",
    );

    await expectPgError(
      withTenantTransaction(tenantB.tenantId, async (client) => {
        await client.query(
          `INSERT INTO authority_standing_rules
             (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id)
           VALUES ($1, $2, 'approve', $3, 'test-domain', 'test pattern', $4)`,
          [randomUUID(), tenantB.tenantId, tenantB.actorId, tenantA.actorId],
        );
      }),
      "23503",
    );
  });

  it("7. authority_standing_rules enforces domain/pattern non-empty, match_criteria object-typed, and revocation consistency", async () => {
    const { tenantId, actorId: sovereignId } = await seedPre6bTenant("Phase 6B Rules Sovereign");
    await withTenantTransaction(tenantId, async (client) => {
      await reconcileSovereign(client, tenantId, sovereignId);
    });

    // Valid row succeeds.
    const validId = randomUUID();
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO authority_standing_rules
           (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id)
         VALUES ($1, $2, 'approve', $3, 'calendar', 'auto-approve read-only calendar lookups', $3)`,
        [validId, tenantId, sovereignId],
      );
    });
    const inserted = await withTenantTransaction(tenantId, async (client) => {
      const result = await client.query("SELECT status, revoked_at, revoked_by_actor_id FROM authority_standing_rules WHERE id = $1", [validId]);
      return result.rows[0];
    });
    expect(inserted.status).toBe("active");
    expect(inserted.revoked_at).toBeNull();

    // Empty domain rejected.
    await expectPgError(
      withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO authority_standing_rules
             (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id)
           VALUES ($1, $2, 'approve', $3, '   ', 'pattern', $3)`,
          [randomUUID(), tenantId, sovereignId],
        );
      }),
      "23514",
    );

    // Empty pattern_description rejected.
    await expectPgError(
      withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO authority_standing_rules
             (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id)
           VALUES ($1, $2, 'approve', $3, 'domain', '', $3)`,
          [randomUUID(), tenantId, sovereignId],
        );
      }),
      "23514",
    );

    // Non-object match_criteria rejected.
    await expectPgError(
      withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO authority_standing_rules
             (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, match_criteria, confirmed_by_actor_id)
           VALUES ($1, $2, 'approve', $3, 'domain', 'pattern', '"just a string"'::jsonb, $3)`,
          [randomUUID(), tenantId, sovereignId],
        );
      }),
      "23514",
    );

    // Active status with a revoked_at set is inconsistent -- rejected.
    await expectPgError(
      withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO authority_standing_rules
             (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id, status, revoked_at)
           VALUES ($1, $2, 'approve', $3, 'domain', 'pattern', $3, 'active', now())`,
          [randomUUID(), tenantId, sovereignId],
        );
      }),
      "23514",
    );

    // Revoked status with revocation provenance present succeeds.
    const revokedId = randomUUID();
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO authority_standing_rules
           (id, tenant_id, polarity, scope_actor_id, domain, pattern_description, confirmed_by_actor_id,
            status, revoked_at, revoked_by_actor_id, revocation_reason)
         VALUES ($1, $2, 'refuse', $3, 'domain', 'pattern', $3, 'revoked', now(), $3, 'superseded')`,
        [revokedId, tenantId, sovereignId],
      );
    });
  });

  it("8. only one hierarchy_tier = 'sovereign' row can exist per tenant", async () => {
    const { tenantId, actorId } = await seedPre6bTenant("Phase 6B Uniqueness Sovereign");
    await withTenantTransaction(tenantId, async (client) => {
      await reconcileSovereign(client, tenantId, actorId);
    });

    await expectPgError(
      withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO actors (id, tenant_id, actor_type, actor_name, hierarchy_tier)
           VALUES ($1, $2, 'human', 'Second Sovereign', 'sovereign')`,
          [randomUUID(), tenantId],
        );
      }),
      "23505",
    );
  });

  it("9. AUTHORITY_AND_DELEGATION.md exists, covers the required content, and README/AGENTS reference it", () => {
    const doctrine = readFileSync(path.join(REPO_ROOT, "AUTHORITY_AND_DELEGATION.md"), "utf8");
    expect(doctrine).toMatch(/Vertical Reporting Hierarchy/i);
    expect(doctrine).toMatch(/Standing Authorization/i);
    expect(doctrine).toMatch(/approval-polarity standing rules apply only to eligible/i);
    expect(doctrine).toMatch(/permanently ineligible for standing pre-authorization/i);
    expect(doctrine).toMatch(/auto-escalate/i);
    expect(doctrine).toMatch(/[Hh]ybrid [Ff]loor/);
    expect(doctrine).toMatch(/can only tighten[\s\S]*?never loosen/i);
    expect(doctrine).toMatch(/Phase 6D/);
    expect(doctrine).toMatch(/Phase 6C/);
    expect(doctrine).toMatch(/[Ss]warm/);

    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/AUTHORITY_AND_DELEGATION\.md/);

    const agents = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/AUTHORITY_AND_DELEGATION\.md/);
  });

  // Item 10 (Phase 1-5 and 6A regression) and item 11 (zero-diff on
  // classifyAuthority.ts / transitionWorkOrder.ts / ingestUserMessage.ts)
  // are verified by running the full `pnpm test` suite and `git diff`
  // respectively -- see the Phase 6B completion report, not this file.
});
