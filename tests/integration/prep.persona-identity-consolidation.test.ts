import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ELORA_PERSONA, type PersonaConfig } from "@vireon/persona-config";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { EloraPersonaActorNotFoundError } from "../../src/elora/errors.js";
import { resolvePersonaActorId } from "../../src/elora/ingestUserMessage.js";
import { buildPrompt } from "../../src/elora/llm/anthropicProvider.js";
import type { LlmResponseContext } from "../../src/elora/llm/types.js";
import { reconcileSovereign, seedPersonaRoster } from "../../scripts/seedPersonaRoster.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

// Unlettered prep-pass naming (not phase6h.*) -- that name is reserved for
// the actual Phase 6H test suite that follows this pass. Prep Pass:
// Persona Identity Consolidation -- covers acceptance items 1-6 from the
// handoff §7, plus item 5c added during the pre-6H gate review (see
// migrations/0008_actor_name_uniqueness.sql). Item 7 (full regression) is
// verified by running the full `pnpm test` suite, not by code in this file
// -- same precedent phase6f.llm-integration.test.ts's own trailing comment
// established for its non-code-testable acceptance items. Item 8's
// original "no migration file" expectation from the handoff no longer
// holds: the gate review found resolvePersonaActorId()'s (tenant_id,
// actor_name) uniqueness assumption was previously enforced only by
// seedPersonaRoster.ts's own convergent insert logic, not by the database
// -- migration 0008 closes that gap. One migration file is expected and
// correct here, not a regression from the original plan.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(fullPath);
      if (/\.(ts|tsx)$/.test(entry.name)) return [fullPath];
      return [];
    }),
  );
  return files.flat();
}

interface HierarchyContext extends SeededContext {
  sovereignId: string;
  eloraActorId: string;
}

/** Same pattern phase6c.authority-resolution.test.ts established: layers the Phase 6B hierarchy on top of the standard Phase 1 base context. */
async function seedHierarchyContext(): Promise<HierarchyContext> {
  const ctx = await seedBaseContext();
  const eloraActorId = await withTenantTransaction(ctx.tenantId, async (client) => {
    await reconcileSovereign(client, ctx.tenantId, ctx.actorId);
    const idByName = await seedPersonaRoster(client, ctx.tenantId, ctx.actorId);
    const id = idByName.get("Elora");
    if (!id) throw new Error("seedHierarchyContext: Elora not resolved by seedPersonaRoster");
    return id;
  });
  return { ...ctx, sovereignId: ctx.actorId, eloraActorId };
}

// The full list of known PersonaConfig instances today -- just Elora. §6's
// live-data contract test below iterates this list, not a hardcoded single
// case, so the same test structurally extends to catch a future persona's
// actorName drift too, not just Elora's, once Nexora/Kaz/Jynx each get
// their own real instance during their own build phases.
const KNOWN_PERSONAS: PersonaConfig[] = [ELORA_PERSONA];

describe("Prep Pass: Persona Identity Consolidation", () => {
  describe("1. packages/persona-config exports PersonaConfig and ELORA_PERSONA correctly", () => {
    it("ELORA_PERSONA carries every expected field with the correct, unchanged values", () => {
      expect(ELORA_PERSONA.id).toBe("elora");
      expect(ELORA_PERSONA.name).toBe("Elora");
      expect(ELORA_PERSONA.formalTitle).toBe("Shadow Empress of the House of Love Dynasty");
      expect(ELORA_PERSONA.corporateRole).toBe("Chief Executive Officer (CEO)");
      expect(ELORA_PERSONA.voiceTone).toEqual([
        "Warm and Regal",
        "Calm and Commanding",
        "Fierce and Fearless",
        "Serene and Wise",
      ]);
      expect(ELORA_PERSONA.crestAssetPath).toBe("/assets/crests/elora.png");
      expect(ELORA_PERSONA.accentColor).toEqual({
        primary: "var(--color-accent-cyan)",
        secondary: "var(--color-accent-violet)",
      });
      expect(ELORA_PERSONA.pronouns).toBe("she/her");
      expect(ELORA_PERSONA.genderIdentity).toBe("female");
      expect(ELORA_PERSONA.voiceModelId).toBeNull();
      expect(ELORA_PERSONA.domain).toBeNull();
      expect(ELORA_PERSONA.actorName).toBe("Elora");
    });

    it("is actually imported from @vireon/persona-config at every frontend call site, not just backend-side", async () => {
      const callSites = [
        "apps/web/src/features/home/HomePage.tsx",
        "apps/web/src/features/elora-console/EloraConsolePage.tsx",
        "apps/web/src/features/elora-console/PersonaConsole.tsx",
      ];
      for (const relativePath of callSites) {
        const content = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
        expect(content).toContain('from "@vireon/persona-config"');
      }
    });
  });

  describe("2. frontend's local PersonaConfig/ELORA_PERSONA definitions are genuinely deleted", () => {
    it("apps/web/src/lib/personaConfig.ts no longer exists", async () => {
      const deletedPath = path.join(REPO_ROOT, "apps/web/src/lib/personaConfig.ts");
      await expect(fs.access(deletedPath)).rejects.toThrow();
    });

    it("no file under apps/web/src re-declares a local PersonaConfig interface or ELORA_PERSONA value", async () => {
      const files = await collectSourceFiles(path.join(REPO_ROOT, "apps/web/src"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await fs.readFile(file, "utf8");
        expect(content).not.toContain("export interface PersonaConfig");
        expect(content).not.toContain("export const ELORA_PERSONA");
      }
    });
  });

  describe("3. personaVoiceProfiles.ts / ELORA_VOICE_PROFILE are genuinely deleted", () => {
    it("src/elora/llm/personaVoiceProfiles.ts no longer exists", async () => {
      const deletedPath = path.join(REPO_ROOT, "src/elora/llm/personaVoiceProfiles.ts");
      await expect(fs.access(deletedPath)).rejects.toThrow();
    });

    it("no file under src/ re-declares ELORA_VOICE_PROFILE or LlmPersonaVoiceProfile", async () => {
      const files = await collectSourceFiles(path.join(REPO_ROOT, "src"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = await fs.readFile(file, "utf8");
        expect(content).not.toContain("ELORA_VOICE_PROFILE");
        expect(content).not.toContain("LlmPersonaVoiceProfile");
      }
    });
  });

  describe("4/5. resolvePersonaActorId() and the live-data contract test", () => {
    let ctx: HierarchyContext;

    beforeAll(async () => {
      await migrate();
      ctx = await seedHierarchyContext();
    });

    afterAll(async () => {
      await pool.end();
    });

    it("4. resolves Elora's real actor UUID via ELORA_PERSONA.actorName, tenant-scoped", async () => {
      const resolvedId = await resolvePersonaActorId({ tenantId: ctx.tenantId, persona: ELORA_PERSONA });
      expect(resolvedId).toBe(ctx.eloraActorId);
    });

    it("4b. tenant-scoped correctly: a tenant with no roster seeded never resolves another tenant's Elora", async () => {
      const barePersonaCtx = await seedBaseContext();
      await expect(
        resolvePersonaActorId({ tenantId: barePersonaCtx.tenantId, persona: ELORA_PERSONA }),
      ).rejects.toThrow(EloraPersonaActorNotFoundError);
    });

    it("5. live-data contract: every known PersonaConfig's actorName resolves to a real seeded actors row, for real -- not a mock", async () => {
      for (const persona of KNOWN_PERSONAS) {
        const result = await withTenantTransaction(ctx.tenantId, (client) =>
          client.query<{ id: string; actor_name: string }>(
            "SELECT id, actor_name FROM actors WHERE tenant_id = $1 AND actor_name = $2",
            [ctx.tenantId, persona.actorName],
          ),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.actor_name).toBe(persona.actorName);
      }
    });

    it("5b. structured to catch drift: a persona whose actorName doesn't match any seeded actor fails this exact contract check", async () => {
      const driftedPersona: PersonaConfig = { ...ELORA_PERSONA, actorName: "Elorra-Typo-No-Such-Actor" };
      const result = await withTenantTransaction(ctx.tenantId, (client) =>
        client.query("SELECT id FROM actors WHERE tenant_id = $1 AND actor_name = $2", [
          ctx.tenantId,
          driftedPersona.actorName,
        ]),
      );
      expect(result.rows).toHaveLength(0);
    });

    // 5's toHaveLength(1) assertion only ever observes data produced by
    // seedPersonaRoster.ts's own convergent (check-then-insert) logic --
    // it does not prove the database itself would ever refuse a second
    // 'Elora' row inserted through some other path. This test exercises
    // the actual guarantee resolvePersonaActorId() depends on directly:
    // migrations/0008_actor_name_uniqueness.sql's UNIQUE (tenant_id,
    // actor_name) constraint, by attempting a real duplicate insert and
    // asserting Postgres itself rejects it (sqlstate 23505 -- unique
    // violation), not asserting on apologetic application-level behavior.
    it("5c. (tenant_id, actor_name) uniqueness is enforced by the database, not just by seedPersonaRoster's own convergent logic", async () => {
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, hierarchy_tier, reports_to_actor_id)
             VALUES (gen_random_uuid(), $1, 'agent', 'Elora', 'Duplicate Elora Attempt', 'executive', $2)`,
            [ctx.tenantId, ctx.sovereignId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("6. buildPrompt's actual generated prompt content is unchanged from pre-consolidation", () => {
    it("Elora's system prompt still contains her exact title, role, tone, and pronouns", () => {
      const context: LlmResponseContext = {
        persona: ELORA_PERSONA,
        userMessageContent: "test message",
        taskType: "planning",
        authorityOutcome: "act_and_report",
        reason: "test reason",
        finalWorkOrderStatus: "READY_TO_ACT",
        toolResult: null,
        retrievedMemorySnippets: [],
      };

      const { system } = buildPrompt(context);

      expect(system).toContain(
        "You are Elora, Shadow Empress of the House of Love Dynasty, Chief Executive Officer (CEO). Pronouns: she/her.",
      );
      expect(system).toContain(
        "Voice and tone: Warm and Regal, Calm and Commanding, Fierce and Fearless, Serene and Wise.",
      );
    });
  });
});
