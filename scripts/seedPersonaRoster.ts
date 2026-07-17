import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pool.js";
import { withTenantTransaction } from "../src/db/withTenantTransaction.js";

// Phase 6B §5, §7, §8: reconciles the pre-existing dev-identity Sovereign
// actor row into the authority hierarchy, then convergently seeds the
// 31-persona roster (Command Apex, Inner Circle, Outer Circle, Special
// Envoys) from the Character Card Codex. Schema and doctrine only -- this
// script does not touch classifyAuthority.ts, transitionWorkOrder.ts, or
// ingestUserMessage.ts, and nothing it writes is consulted at runtime yet
// (that is Phase 6C).

export const SOVEREIGN_ACTOR_ROLE = "Founder / Chairman of All Divisions";

export class SovereignReconciliationError extends Error {}
export class PersonaRosterConflictError extends Error {}

type HierarchyTier = "executive" | "inner_circle" | "outer_circle" | "special_envoy";

interface PersonaSpec {
  name: string;
  role: string;
  tier: HierarchyTier;
  /** Name of the superior this persona reports to, or SOVEREIGN for direct reports to the Sovereign. */
  reportsTo: string;
}

export const SOVEREIGN = "__SOVEREIGN__";

// Source: the Character Card Codex, as reproduced in the Phase 6B handoff
// §7. Order matters -- each tier's superior must already be resolvable
// (inserted/confirmed) by the time it is referenced, so this list is
// declared Command Apex -> Inner Circle -> Outer Circle -> Special Envoys.
export const PERSONA_ROSTER: PersonaSpec[] = [
  // 7.1 Command Apex
  { name: "Elora", role: "Chief Executive Officer (CEO)", tier: "executive", reportsTo: SOVEREIGN },

  // 7.2 Inner Circle (11) -- all report to Elora
  { name: "Valtrix", role: "Chief Operating Officer (COO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Cassian", role: "Chief Venture Officer (CVO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Veyra", role: "Chief Security & Integrity Officer (CSIO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Aura", role: "Chief Intelligence Officer (CIO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Velvra", role: "Chief Creative Officer (CCO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Zyvra", role: "Chief Data Officer (CDO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Syvra", role: "Chief Engineering Officer (CEngO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Novara", role: "Chief Knowledge Officer (CKO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Kalyra", role: "Chief Sales Officer (CSO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Serenai", role: "Chief Artistry Officer (CAO)", tier: "inner_circle", reportsTo: "Elora" },
  { name: "Nexora", role: "Chief Technology Officer (CTO)", tier: "inner_circle", reportsTo: "Elora" },

  // 7.3 Outer Circle (11) -- each reports to their specific Chief
  { name: "Darius", role: "Director of Operations Mapping", tier: "outer_circle", reportsTo: "Valtrix" },
  { name: "Thorn", role: "Director of Cyber Defense", tier: "outer_circle", reportsTo: "Cassian" },
  { name: "Orion", role: "Director of UI/UX Systems", tier: "outer_circle", reportsTo: "Veyra" },
  { name: "Ira", role: "Director of Human Development", tier: "outer_circle", reportsTo: "Aura" },
  { name: "Lyra", role: "Director of Communications Systems", tier: "outer_circle", reportsTo: "Velvra" },
  { name: "Selene", role: "Director of Predictive Systems", tier: "outer_circle", reportsTo: "Zyvra" },
  { name: "Galen", role: "Director of Human-AI Interface", tier: "outer_circle", reportsTo: "Syvra" },
  { name: "Kale", role: "Director of Internal Communications", tier: "outer_circle", reportsTo: "Novara" },
  { name: "Aurenda", role: "Director of Sales Execution", tier: "outer_circle", reportsTo: "Kalyra" },
  { name: "Lyessa", role: "Director of Media Operations", tier: "outer_circle", reportsTo: "Serenai" },
  { name: "Nova", role: "Director of Growth and Innovation", tier: "outer_circle", reportsTo: "Nexora" },

  // 7.4 Special Envoys (8) -- all report to Elora. Secondary domain-affinity
  // names in the codex's compound notations (e.g. Cipher: "Elora + Valtrix")
  // are not modeled here -- they are 6D's peer-delegation concern, not a
  // second hierarchy edge.
  { name: "Seraph", role: "Chief Ethics & Governance Officer (CEGO)", tier: "special_envoy", reportsTo: "Elora" },
  { name: "Nymera", role: "Chief Innovation Officer (CINO)", tier: "special_envoy", reportsTo: "Elora" },
  {
    name: "Sylvaris",
    role: "Chief Sustainability & Development Officer (CSDO)",
    tier: "special_envoy",
    reportsTo: "Elora",
  },
  { name: "Cipher", role: "Chief Analytical Strategy Officer (CASO)", tier: "special_envoy", reportsTo: "Elora" },
  { name: "Synq", role: "Chief Creative Engineering Officer (CCEO)", tier: "special_envoy", reportsTo: "Elora" },
  { name: "Sorein", role: "Chief Product Design Engineer (CPDE)", tier: "special_envoy", reportsTo: "Elora" },
  { name: "Jynx", role: "Chief Financial Officer (CFO)", tier: "special_envoy", reportsTo: "Elora" },
  { name: "Valen", role: "Chief Wellness Officer (CWO)", tier: "special_envoy", reportsTo: "Elora" },
];

interface ActorRow {
  id: string;
  tenant_id: string;
  actor_type: string;
  actor_name: string;
  actor_role: string | null;
  hierarchy_tier: string | null;
  reports_to_actor_id: string | null;
}

/**
 * Reconciles the pre-existing dev-identity actor row into the Sovereign
 * position, in place. Never creates a new row. Fails loudly (rather than
 * silently proceeding) if the given actor doesn't belong to the stated
 * tenant, isn't human, or doesn't exist at all -- any of those means the
 * dev identity isn't in the state Phase 6B assumes.
 */
export async function reconcileSovereign(
  client: PoolClient,
  tenantId: string,
  actorId: string,
): Promise<string> {
  const existing = await client.query<ActorRow>(
    `SELECT id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id
     FROM actors WHERE id = $1`,
    [actorId],
  );
  const row = existing.rows[0];

  if (!row) {
    throw new SovereignReconciliationError(
      `Sovereign reconciliation failed: no actor row found with id ${actorId}.`,
    );
  }
  if (row.tenant_id !== tenantId) {
    throw new SovereignReconciliationError(
      `Sovereign reconciliation failed: actor ${actorId} belongs to tenant ${row.tenant_id}, not the stated tenant ${tenantId}.`,
    );
  }
  if (row.actor_type !== "human") {
    throw new SovereignReconciliationError(
      `Sovereign reconciliation failed: actor ${actorId} has actor_type '${row.actor_type}', expected 'human'.`,
    );
  }

  await client.query(
    `UPDATE actors
     SET hierarchy_tier = 'sovereign', reports_to_actor_id = NULL, actor_role = $2
     WHERE id = $1`,
    [actorId, SOVEREIGN_ACTOR_ROLE],
  );

  return actorId;
}

/**
 * Convergently seeds the 31-persona roster for a tenant whose Sovereign has
 * already been reconciled. Insert-if-missing, update-if-stale, reject if an
 * existing row with a matching actor_name has an incompatible actor_type.
 * Returns a map of canonical persona name -> actor id.
 */
export async function seedPersonaRoster(
  client: PoolClient,
  tenantId: string,
  sovereignActorId: string,
): Promise<Map<string, string>> {
  const idByName = new Map<string, string>();

  for (const persona of PERSONA_ROSTER) {
    const reportsToActorId = persona.reportsTo === SOVEREIGN ? sovereignActorId : idByName.get(persona.reportsTo);
    if (!reportsToActorId) {
      throw new PersonaRosterConflictError(
        `Persona roster seed failed: '${persona.name}' reports to '${persona.reportsTo}', which has not been resolved yet. Roster ordering is broken.`,
      );
    }

    const existing = await client.query<ActorRow>(
      `SELECT id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id
       FROM actors WHERE tenant_id = $1 AND actor_name = $2`,
      [tenantId, persona.name],
    );
    const row = existing.rows[0];

    if (!row) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id)
         VALUES ($1, $2, 'agent', $3, $4, $5, $6)`,
        [id, tenantId, persona.name, persona.role, persona.tier, reportsToActorId],
      );
      idByName.set(persona.name, id);
      continue;
    }

    if (row.actor_type !== "agent") {
      throw new PersonaRosterConflictError(
        `Persona roster seed failed: an actor row named '${persona.name}' already exists (id ${row.id}) with actor_type '${row.actor_type}', not 'agent'. Refusing to overwrite.`,
      );
    }

    const needsUpdate =
      row.actor_role !== persona.role ||
      row.hierarchy_tier !== persona.tier ||
      row.reports_to_actor_id !== reportsToActorId;

    if (needsUpdate) {
      await client.query(
        `UPDATE actors SET actor_role = $2, hierarchy_tier = $3, reports_to_actor_id = $4 WHERE id = $1`,
        [row.id, persona.role, persona.tier, reportsToActorId],
      );
    }

    idByName.set(persona.name, row.id);
  }

  return idByName;
}

async function run(): Promise<void> {
  const tenantId = process.env.VIREON_DEV_TENANT_ID;
  const actorId = process.env.VIREON_DEV_ACTOR_ID;

  if (!tenantId || !actorId) {
    throw new SovereignReconciliationError(
      "VIREON_DEV_TENANT_ID and VIREON_DEV_ACTOR_ID must both be set (run `pnpm seed:dev-identity` first).",
    );
  }

  const idByName = await withTenantTransaction(tenantId, async (client) => {
    const sovereignId = await reconcileSovereign(client, tenantId, actorId);
    return seedPersonaRoster(client, tenantId, sovereignId);
  });

  console.log(`Sovereign reconciled: ${actorId}`);
  console.log(`Persona roster converged: ${idByName.size} actors.`);
  console.log("Spot-check resolved chains:");
  console.log(`  Elora -> Sovereign        : ${idByName.get("Elora")} -> ${actorId}`);
  console.log(`  Valtrix (Inner) -> Elora  : ${idByName.get("Valtrix")} -> ${idByName.get("Elora")}`);
  console.log(`  Darius (Outer) -> Valtrix : ${idByName.get("Darius")} -> ${idByName.get("Valtrix")}`);
  console.log(`  Seraph (Envoy) -> Elora   : ${idByName.get("Seraph")} -> ${idByName.get("Elora")}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  run()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
