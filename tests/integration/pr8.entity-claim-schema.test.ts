import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createEntity } from "../../src/elora/world-state/createEntity.js";
import {
  ClaimEvidenceSourceNotFoundError,
  ClaimNotFoundError,
  EntityNotFoundError,
  InvalidClaimInputError,
} from "../../src/elora/world-state/errors.js";
import { recordClaim, type ClaimEvidenceSource, type RecordClaimInput } from "../../src/elora/world-state/recordClaim.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { seedMemoryRecord } from "../shared/seedMemoryRecord.js";

// =========================================================================
// Shared fixture helpers.
// =========================================================================

interface EvidenceSourceIds {
  messageId: string;
  workOrderId: string;
  authorityDecisionId: string;
  actionReceiptId: string;
  directiveId: string;
  briefingIssueId: string;
  triggerId: string;
  memoryRecordId: string;
}

/**
 * Constructs one real, tenant-owned row per claim_evidence source kind.
 * Reuses ctx.messageId (already seeded by seedBaseContext) and
 * seedMemoryRecord() (a proper existing test helper) where a full row
 * already exists cheaply; direct-inserts the other six, which is acceptable
 * here per PR 8 §48 -- standing up createWorkOrder/resolveAuthority/
 * recordActionReceipt/createOrMergeDirective/assembleBriefingIssue/
 * createScheduledTrigger's full lifecycles solely to obtain one FK-able row
 * each would drag six unrelated service lifecycles into this PR.
 */
async function seedEvidenceSources(ctx: SeededContext): Promise<EvidenceSourceIds> {
  const memoryRecord = await seedMemoryRecord({ tenantId: ctx.tenantId, content: "PR 8 evidence probe memory record." });

  return withTenantTransaction(ctx.tenantId, async (client) => {
    const workOrderId = randomUUID();
    await client.query(
      `INSERT INTO work_orders (id, tenant_id, workspace_id, project_id, thread_id, message_id, owner_actor_id, task_type, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'note','RECEIVED',$8)`,
      [workOrderId, ctx.tenantId, ctx.workspaceId, ctx.projectId, ctx.threadId, ctx.messageId, ctx.actorId, `pr8-evidence-wo:${workOrderId}`],
    );

    const authorityDecisionId = randomUUID();
    await client.query(
      `INSERT INTO authority_decisions (id, tenant_id, outcome, deciding_actor_id, work_order_id)
       VALUES ($1,$2,'act',$3,$4)`,
      [authorityDecisionId, ctx.tenantId, ctx.actorId, workOrderId],
    );

    const actionReceiptId = randomUUID();
    await client.query(
      `INSERT INTO action_receipts (id, tenant_id, receipt_type, actor_id, acting_system, work_order_id, idempotency_key)
       VALUES ($1,$2,'note',$3,'pr8-test-harness',$4,$5)`,
      [actionReceiptId, ctx.tenantId, ctx.actorId, workOrderId, `pr8-evidence-ar:${actionReceiptId}`],
    );

    const directiveId = randomUUID();
    await client.query(
      `INSERT INTO operator_directives (id, tenant_id, directive_type, dedupe_key, issuing_actor_id, owning_actor_id)
       VALUES ($1,$2,'action',$3,$4,$4)`,
      [directiveId, ctx.tenantId, `pr8-evidence-directive:${directiveId}`, ctx.actorId],
    );

    const briefingIssueId = randomUUID();
    await client.query(
      `INSERT INTO briefing_issues (id, tenant_id, briefing_type, local_issue_date, timezone, issued_by_actor_id, idempotency_key)
       VALUES ($1,$2,'daily',CURRENT_DATE,'UTC',$3,$4)`,
      [briefingIssueId, ctx.tenantId, ctx.actorId, `pr8-evidence-briefing:${briefingIssueId}`],
    );

    const triggerId = randomUUID();
    await client.query(
      `INSERT INTO scheduled_triggers
         (id, tenant_id, owning_actor_id, created_by_actor_id, authority_decision_id, schedule_kind, schedule_expression, synthetic_message_content, idempotency_key)
       VALUES ($1,$2,$3,$3,$4,'one_off','2030-01-01T00:00:00.000Z','PR 8 evidence probe trigger.',$5)`,
      [triggerId, ctx.tenantId, ctx.actorId, authorityDecisionId, `pr8-evidence-trigger:${triggerId}`],
    );

    return {
      messageId: ctx.messageId,
      workOrderId,
      authorityDecisionId,
      actionReceiptId,
      directiveId,
      briefingIssueId,
      triggerId,
      memoryRecordId: memoryRecord.id,
    };
  });
}

async function fetchRow(tenantId: string, sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(sql, params);
    return result.rows[0] as Record<string, unknown> | undefined;
  });
}

async function fetchRows(tenantId: string, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
}

describe("PR 8: Entity / Claim / World-State Schema acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  // =======================================================================
  // §36: migration structure
  // =======================================================================
  describe("migration structure", () => {
    it("all five tables exist", async () => {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [["entities", "entity_aliases", "claims", "claim_evidence", "claim_conflicts"]],
      );
      expect(result.rows.map((row) => row.table_name).sort()).toEqual(
        ["claim_conflicts", "claim_evidence", "claims", "entities", "entity_aliases"].sort(),
      );
    });

    it("claims has recorded_at and does not have created_at -- protects the bitemporal decision from accidental drift", async () => {
      const result = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims'`,
      );
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).toContain("recorded_at");
      expect(columns).toContain("valid_from");
      expect(columns).toContain("valid_to");
      expect(columns).not.toContain("created_at");
    });
  });

  // =======================================================================
  // §37/§38: entity creation and no automatic resolution
  // =======================================================================
  describe("entity creation", () => {
    it("creates one entity row and its explicit aliases atomically, all Zod-parsed and tenant-scoped", async () => {
      const result = await createEntity({
        tenantId: ctx.tenantId,
        entityType: "organization",
        canonicalName: "Acme Corporation",
        aliases: ["Acme", "Acme Corp"],
      });

      expect(result.entity.entity_type).toBe("organization");
      expect(result.entity.canonical_name).toBe("Acme Corporation");
      expect(result.entity.tenant_id).toBe(ctx.tenantId);
      expect(result.aliases).toHaveLength(2);
      expect(result.aliases.map((alias) => alias.alias).sort()).toEqual(["Acme", "Acme Corp"].sort());
      for (const alias of result.aliases) {
        expect(alias.entity_id).toBe(result.entity.id);
        expect(alias.tenant_id).toBe(ctx.tenantId);
      }

      const persistedEntity = await fetchRow(ctx.tenantId, "SELECT * FROM entities WHERE id = $1", [result.entity.id]);
      expect(persistedEntity).toBeDefined();
      const persistedAliases = await fetchRows(ctx.tenantId, "SELECT * FROM entity_aliases WHERE entity_id = $1", [result.entity.id]);
      expect(persistedAliases).toHaveLength(2);
    });

    it("rejects exact duplicate aliases within a single request rather than silently dropping them", async () => {
      await expect(
        createEntity({
          tenantId: ctx.tenantId,
          entityType: "organization",
          canonicalName: "Duplicate Alias Test Corp",
          aliases: ["Dup", "Dup"],
        }),
      ).rejects.toBeInstanceOf(Error);

      const persisted = await fetchRows(ctx.tenantId, "SELECT * FROM entities WHERE canonical_name = $1", [
        "Duplicate Alias Test Corp",
      ]);
      expect(persisted).toHaveLength(0);
    });

    it("rejects empty entityType, canonicalName, and alias", async () => {
      await expect(createEntity({ tenantId: ctx.tenantId, entityType: "  ", canonicalName: "X" })).rejects.toThrow();
      await expect(createEntity({ tenantId: ctx.tenantId, entityType: "person", canonicalName: "  " })).rejects.toThrow();
      await expect(
        createEntity({ tenantId: ctx.tenantId, entityType: "person", canonicalName: "X", aliases: ["  "] }),
      ).rejects.toThrow();
    });
  });

  describe("no automatic entity resolution", () => {
    it("two createEntity() calls with an identical canonicalName produce two distinct entities -- nothing merges them", async () => {
      const first = await createEntity({ tenantId: ctx.tenantId, entityType: "person", canonicalName: "Acme" });
      const second = await createEntity({ tenantId: ctx.tenantId, entityType: "person", canonicalName: "Acme" });

      expect(first.entity.id).not.toBe(second.entity.id);
      expect(first.entity.canonical_name).toBe(second.entity.canonical_name);

      const rows = await fetchRows(ctx.tenantId, "SELECT id FROM entities WHERE canonical_name = $1 AND entity_type = 'person'", [
        "Acme",
      ]);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =======================================================================
  // §39/§40: entity-valued and literal-valued claims
  // =======================================================================
  describe("entity-valued claim", () => {
    it("subject Alice works_for object Acme Corp -- object_entity_id set, object_value null", async () => {
      const alice = await createEntity({ tenantId: ctx.tenantId, entityType: "person", canonicalName: "Alice" });
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (claim test)" });

      const result = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: alice.entity.id,
        predicate: "works_for",
        objectEntityId: acme.entity.id,
        claimKind: "observed",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      expect(result.claim.object_entity_id).toBe(acme.entity.id);
      expect(result.claim.object_value).toBeNull();
      expect(result.claim.subject_entity_id).toBe(alice.entity.id);
      expect(result.claim.tenant_id).toBe(ctx.tenantId);
    });
  });

  describe("literal-valued claim", () => {
    it("subject Acme Corp employee_count = 125 -- object_entity_id null, object_value = 125", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (literal test)" });

      const result = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "employee_count",
        objectValue: 125,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      expect(result.claim.object_entity_id).toBeNull();
      expect(result.claim.object_value).toBe(125);
    });

    it("supports structured JSON object values", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (json test)" });

      const result = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "annual_revenue",
        objectValue: { currency: "USD", amount: 1000000 },
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      expect(result.claim.object_value).toEqual({ currency: "USD", amount: 1000000 });

      const persisted = await fetchRow(ctx.tenantId, "SELECT object_value FROM claims WHERE id = $1", [result.claim.id]);
      expect(persisted?.object_value).toEqual({ currency: "USD", amount: 1000000 });
    });
  });

  // =======================================================================
  // §41: exactly-one claim object -- application and database guards
  // =======================================================================
  describe("exactly-one claim object", () => {
    it("recordClaim() throws InvalidClaimInputError for both objectEntityId and objectValue supplied", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (xor test A)" });

      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate: "test_predicate",
          claimKind: "observed",
          validFrom: "2026-01-01T00:00:00.000Z",
          objectEntityId: acme.entity.id,
          objectValue: 1,
        } as unknown as RecordClaimInput),
      ).rejects.toBeInstanceOf(InvalidClaimInputError);
    });

    it("recordClaim() throws InvalidClaimInputError for neither objectEntityId nor objectValue supplied", async () => {
      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate: "test_predicate",
          claimKind: "observed",
          validFrom: "2026-01-01T00:00:00.000Z",
        } as unknown as RecordClaimInput),
      ).rejects.toBeInstanceOf(InvalidClaimInputError);
    });

    it("the database CHECK independently rejects both-present and neither-present, proven via direct SQL", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (xor test B)" });

      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, object_entity_id, object_value, valid_from)
             VALUES ($1,$2,'both_test','observed',$3,'1'::jsonb,now())`,
            [randomUUID(), ctx.tenantId, acme.entity.id],
          ),
        ),
      ).rejects.toThrow(/chk_claims_exactly_one_object/);

      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, valid_from)
             VALUES ($1,$2,'neither_test','observed',now())`,
            [randomUUID(), ctx.tenantId],
          ),
        ),
      ).rejects.toThrow(/chk_claims_exactly_one_object/);
    });
  });

  // =======================================================================
  // §42: claim-kind vocabulary
  // =======================================================================
  describe("claim-kind vocabulary", () => {
    const CLAIM_KINDS = ["observed", "user_asserted", "retrieved", "inferred", "predicted", "planned", "hypothetical"] as const;

    it.each(CLAIM_KINDS)("insertion succeeds for claim_kind = %s", async (claimKind) => {
      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: `vocabulary_test_${claimKind}`,
        claimKind,
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      expect(result.claim.claim_kind).toBe(claimKind);
    });

    it("direct SQL with an invalid claim_kind fails the CHECK -- vocabulary is not open text", async () => {
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, object_value, valid_from)
             VALUES ($1,$2,'bad_kind_test','made_up_kind','1'::jsonb,now())`,
            [randomUUID(), ctx.tenantId],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // =======================================================================
  // §43: confidence
  // =======================================================================
  describe("confidence", () => {
    it.each([0, 0.5, 1, null])("accepts confidence = %s", async (confidence) => {
      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "confidence_valid_test",
        claimKind: "observed",
        objectValue: "ok",
        confidence,
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      expect(result.claim.confidence).toBe(confidence);
    });

    it.each([-0.01, 1.01])("recordClaim() rejects confidence = %s", async (confidence) => {
      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate: "confidence_invalid_test",
          claimKind: "observed",
          objectValue: "ok",
          confidence,
          validFrom: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(InvalidClaimInputError);
    });

    it.each([-0.01, 1.01])("the database CHECK independently rejects confidence = %s via direct SQL", async (confidence) => {
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, object_value, confidence, valid_from)
             VALUES ($1,$2,'confidence_db_test','observed','1'::jsonb,$3,now())`,
            [randomUUID(), ctx.tenantId, confidence],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // =======================================================================
  // §44: temporal validity
  // =======================================================================
  describe("temporal validity", () => {
    it("valid_to = null is accepted", async () => {
      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "temporal_open_ended",
        claimKind: "observed",
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      expect(result.claim.valid_to).toBeNull();
    });

    it("valid_to > valid_from is accepted", async () => {
      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "temporal_window",
        claimKind: "observed",
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-02-01T00:00:00.000Z",
      });
      expect(new Date(result.claim.valid_to!).getTime()).toBeGreaterThan(new Date(result.claim.valid_from).getTime());
    });

    it("recordClaim() rejects valid_to = valid_from and valid_to < valid_from", async () => {
      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate: "temporal_equal",
          claimKind: "observed",
          objectValue: "ok",
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(InvalidClaimInputError);

      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate: "temporal_before",
          claimKind: "observed",
          objectValue: "ok",
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2025-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(InvalidClaimInputError);
    });

    it("the database CHECK independently rejects valid_to <= valid_from via direct SQL", async () => {
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, object_value, valid_from, valid_to)
             VALUES ($1,$2,'temporal_db_test','observed','1'::jsonb,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
            [randomUUID(), ctx.tenantId],
          ),
        ),
      ).rejects.toThrow(/chk_claims_valid_window/);
    });
  });

  // =======================================================================
  // §45: recorded transaction time
  // =======================================================================
  describe("recorded transaction time", () => {
    it("recorded_at is a valid, distinct-from-valid_from timestamp; no created_at column exists", async () => {
      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "recorded_at_test",
        claimKind: "observed",
        objectValue: "ok",
        validFrom: "2020-01-01T00:00:00.000Z",
      });

      expect(result.claim.recorded_at).toBeDefined();
      expect(Number.isNaN(new Date(result.claim.recorded_at).getTime())).toBe(false);
      // recorded_at (transaction time, "now") and valid_from (valid time, an
      // arbitrary caller-supplied fact-applies-at date) are different
      // temporal dimensions -- not expected to coincide, and here provably
      // don't, since valid_from was deliberately backdated.
      expect(result.claim.recorded_at).not.toBe(result.claim.valid_from);
      expect("created_at" in result.claim).toBe(false);
    });
  });

  // =======================================================================
  // §46/§47: supersession and the self-supersession DB guard
  // =======================================================================
  describe("supersession", () => {
    it("claim B.supersedes_claim_id = claim A.id, and claim A remains byte-for-byte unchanged", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme Corp (supersede test)" });

      const claimA = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "employee_count",
        objectValue: 100,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      const beforeRow = await fetchRow(ctx.tenantId, "SELECT * FROM claims WHERE id = $1", [claimA.claim.id]);

      const claimB = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "employee_count",
        objectValue: 110,
        claimKind: "user_asserted",
        validFrom: "2026-02-01T00:00:00.000Z",
        supersedesClaimId: claimA.claim.id,
      });

      expect(claimB.claim.supersedes_claim_id).toBe(claimA.claim.id);

      const afterRow = await fetchRow(ctx.tenantId, "SELECT * FROM claims WHERE id = $1", [claimA.claim.id]);
      expect(afterRow).toEqual(beforeRow);
      // In particular: A's status was never flipped to 'superseded' merely
      // because B points to it. That interpretation belongs to a later
      // projector (PR 9+), not to recordClaim() itself.
      expect(afterRow?.status).toBe("active");
    });
  });

  describe("self-supersession DB guard", () => {
    it("a claim cannot supersede itself -- rejected by the database CHECK via direct SQL", async () => {
      const id = randomUUID();
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claims (id, tenant_id, predicate, claim_kind, object_value, valid_from, supersedes_claim_id)
             VALUES ($1,$2,'self_supersede_test','observed','1'::jsonb,now(),$1)`,
            [id, ctx.tenantId],
          ),
        ),
      ).rejects.toThrow(/chk_claims_not_self_superseding/);
    });
  });

  // =======================================================================
  // §48/§49/§50: evidence creation and its two integrity constraints
  // =======================================================================
  describe("evidence creation", () => {
    it("creates one evidence row per representative source kind, each with the correct source_kind, matching FK, and all other FKs null", async () => {
      const sources = await seedEvidenceSources(ctx);

      const evidenceSources: ClaimEvidenceSource[] = [
        { kind: "message", messageId: sources.messageId },
        { kind: "work_order", workOrderId: sources.workOrderId },
        { kind: "authority_decision", authorityDecisionId: sources.authorityDecisionId },
        { kind: "action_receipt", actionReceiptId: sources.actionReceiptId },
        { kind: "directive", directiveId: sources.directiveId },
        { kind: "briefing_issue", briefingIssueId: sources.briefingIssueId },
        { kind: "trigger", triggerId: sources.triggerId },
        { kind: "memory_record", memoryRecordId: sources.memoryRecordId },
      ];

      const result = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "evidence_test",
        claimKind: "observed",
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
        evidence: evidenceSources,
      });

      expect(result.evidence).toHaveLength(8);

      const fkColumnBySourceKind: Record<string, string> = {
        message: "message_id",
        work_order: "work_order_id",
        authority_decision: "authority_decision_id",
        action_receipt: "action_receipt_id",
        directive: "directive_id",
        briefing_issue: "briefing_issue_id",
        trigger: "trigger_id",
        memory_record: "memory_record_id",
      };
      const allFkColumns = Object.values(fkColumnBySourceKind);

      for (const evidenceRow of result.evidence) {
        expect(evidenceRow.claim_id).toBe(result.claim.id);
        expect(evidenceRow.tenant_id).toBe(ctx.tenantId);
        const expectedColumn = fkColumnBySourceKind[evidenceRow.source_kind];
        for (const column of allFkColumns) {
          const value = (evidenceRow as unknown as Record<string, string | null>)[column];
          if (column === expectedColumn) {
            expect(value, `${evidenceRow.source_kind} should populate ${column}`).not.toBeNull();
          } else {
            expect(value, `${evidenceRow.source_kind} should leave ${column} null`).toBeNull();
          }
        }
      }

      const persistedEvidence = await fetchRows(ctx.tenantId, "SELECT * FROM claim_evidence WHERE claim_id = $1", [result.claim.id]);
      expect(persistedEvidence).toHaveLength(8);
    });

    it("an empty or omitted evidence array is valid -- no fabricated evidence row is ever created", async () => {
      const withoutEvidenceKey = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "no_evidence_omitted",
        claimKind: "hypothetical",
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      expect(withoutEvidenceKey.evidence).toHaveLength(0);

      const withEmptyEvidenceArray = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "no_evidence_empty_array",
        claimKind: "predicted",
        objectValue: "ok",
        validFrom: "2026-01-01T00:00:00.000Z",
        evidence: [],
      });
      expect(withEmptyEvidenceArray.evidence).toHaveLength(0);

      const persisted = await fetchRows(ctx.tenantId, "SELECT * FROM claim_evidence WHERE claim_id = ANY($1)", [
        [withoutEvidenceKey.claim.id, withEmptyEvidenceArray.claim.id],
      ]);
      expect(persisted).toHaveLength(0);
    });
  });

  async function seedBareClaim(tenantId: string, predicate: string): Promise<string> {
    const result = await recordClaim({
      tenantId,
      predicate,
      claimKind: "observed",
      objectValue: "ok",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    return result.claim.id;
  }

  describe("evidence exactly-one constraint", () => {
    it("direct SQL with zero source FKs fails the CHECK", async () => {
      const claimId = await seedBareClaim(ctx.tenantId, `evidence_zero_fk_test_${randomUUID()}`);
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claim_evidence (id, tenant_id, claim_id, source_kind) VALUES ($1,$2,$3,'message')`,
            [randomUUID(), ctx.tenantId, claimId],
          ),
        ),
      ).rejects.toThrow(/chk_claim_evidence_exactly_one_source/);
    });

    it("direct SQL with two source FKs fails the CHECK", async () => {
      const sources = await seedEvidenceSources(ctx);
      const claimId = await seedBareClaim(ctx.tenantId, `evidence_two_fk_test_${randomUUID()}`);
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claim_evidence (id, tenant_id, claim_id, source_kind, message_id, work_order_id)
             VALUES ($1,$2,$3,'message',$4,$5)`,
            [randomUUID(), ctx.tenantId, claimId, sources.messageId, sources.workOrderId],
          ),
        ),
      ).rejects.toThrow(/chk_claim_evidence_exactly_one_source/);
    });
  });

  describe("source-kind correspondence", () => {
    it("source_kind = message with only work_order_id populated fails, even though exactly one FK is set", async () => {
      const sources = await seedEvidenceSources(ctx);
      const claimId = await seedBareClaim(ctx.tenantId, `source_kind_mismatch_test_${randomUUID()}`);
      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claim_evidence (id, tenant_id, claim_id, source_kind, work_order_id)
             VALUES ($1,$2,$3,'message',$4)`,
            [randomUUID(), ctx.tenantId, claimId, sources.workOrderId],
          ),
        ),
      ).rejects.toThrow(/chk_claim_evidence_source_kind_matches_reference/);
    });

    it("control: source_kind = message with message_id populated succeeds", async () => {
      const sources = await seedEvidenceSources(ctx);
      const claimId = await seedBareClaim(ctx.tenantId, `source_kind_control_test_${randomUUID()}`);
      const inserted = await withTenantTransaction(ctx.tenantId, (client) =>
        client.query(
          `INSERT INTO claim_evidence (id, tenant_id, claim_id, source_kind, message_id)
           VALUES ($1,$2,$3,'message',$4) RETURNING *`,
          [randomUUID(), ctx.tenantId, claimId, sources.messageId],
        ),
      );
      expect(inserted.rows).toHaveLength(1);
    });
  });

  // =======================================================================
  // §51: claim/evidence atomicity
  // =======================================================================
  describe("claim/evidence atomicity", () => {
    it("a failing evidence reference rolls back the whole request -- no claim row and no claim_evidence row are committed", async () => {
      const predicate = `atomicity_test_${randomUUID()}`;
      await expect(
        recordClaim({
          tenantId: ctx.tenantId,
          predicate,
          claimKind: "observed",
          objectValue: "ok",
          validFrom: "2026-01-01T00:00:00.000Z",
          evidence: [{ kind: "message", messageId: randomUUID() }],
        }),
      ).rejects.toBeInstanceOf(ClaimEvidenceSourceNotFoundError);

      const persistedClaims = await fetchRows(ctx.tenantId, "SELECT id FROM claims WHERE predicate = $1", [predicate]);
      expect(persistedClaims).toHaveLength(0);
    });
  });

  // =======================================================================
  // §52/§53/§54: tenant-safe references
  // =======================================================================
  describe("tenant-safe entity references", () => {
    it("tenant B's recordClaim() referencing tenant A's entity is rejected with a typed error, and nothing is persisted", async () => {
      const ctxA = await seedBaseContext();
      const ctxB = await seedBaseContext();
      const entityA = await createEntity({ tenantId: ctxA.tenantId, entityType: "organization", canonicalName: "Tenant A Only Corp" });

      const predicate = `cross_tenant_entity_test_${randomUUID()}`;
      await expect(
        recordClaim({
          tenantId: ctxB.tenantId,
          subjectEntityId: entityA.entity.id,
          predicate,
          objectValue: "ok",
          claimKind: "observed",
          validFrom: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);

      const persisted = await fetchRows(ctxB.tenantId, "SELECT id FROM claims WHERE predicate = $1", [predicate]);
      expect(persisted).toHaveLength(0);
    });
  });

  describe("tenant-safe supersession", () => {
    it("tenant B's recordClaim() with supersedesClaimId pointing at tenant A's claim is rejected", async () => {
      const ctxA = await seedBaseContext();
      const ctxB = await seedBaseContext();

      const claimA = await recordClaim({
        tenantId: ctxA.tenantId,
        predicate: "tenant_a_original_claim",
        objectValue: "ok",
        claimKind: "observed",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      const predicate = `cross_tenant_supersede_test_${randomUUID()}`;
      await expect(
        recordClaim({
          tenantId: ctxB.tenantId,
          predicate,
          objectValue: "ok2",
          claimKind: "observed",
          validFrom: "2026-02-01T00:00:00.000Z",
          supersedesClaimId: claimA.claim.id,
        }),
      ).rejects.toBeInstanceOf(ClaimNotFoundError);

      const persisted = await fetchRows(ctxB.tenantId, "SELECT id FROM claims WHERE predicate = $1", [predicate]);
      expect(persisted).toHaveLength(0);
    });
  });

  describe("tenant-safe evidence references", () => {
    it("tenant B's recordClaim() with evidence pointing at tenant A's message is rejected through the application boundary", async () => {
      const ctxA = await seedBaseContext();
      const ctxB = await seedBaseContext();

      const predicate = `cross_tenant_evidence_test_${randomUUID()}`;
      await expect(
        recordClaim({
          tenantId: ctxB.tenantId,
          predicate,
          objectValue: "ok",
          claimKind: "observed",
          validFrom: "2026-01-01T00:00:00.000Z",
          evidence: [{ kind: "message", messageId: ctxA.messageId }],
        }),
      ).rejects.toBeInstanceOf(ClaimEvidenceSourceNotFoundError);

      const persisted = await fetchRows(ctxB.tenantId, "SELECT id FROM claims WHERE predicate = $1", [predicate]);
      expect(persisted).toHaveLength(0);
    });
  });

  // =======================================================================
  // §55/§56: claim conflicts remain schema-only
  // =======================================================================
  describe("claim conflicts", () => {
    it("an explicit conflict row persists correctly; distinct-claims and resolution-status vocabulary are enforced", async () => {
      const claimA = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "conflict_test_employee_count",
        objectValue: 100,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      const claimB = await recordClaim({
        tenantId: ctx.tenantId,
        predicate: "conflict_test_employee_count",
        objectValue: 200,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      const inserted = await withTenantTransaction(ctx.tenantId, (client) =>
        client.query(
          `INSERT INTO claim_conflicts (id, tenant_id, claim_a_id, claim_b_id, resolution_status)
           VALUES ($1,$2,$3,$4,'unresolved') RETURNING *`,
          [randomUUID(), ctx.tenantId, claimA.claim.id, claimB.claim.id],
        ),
      );
      expect(inserted.rows).toHaveLength(1);
      expect(inserted.rows[0].resolution_status).toBe("unresolved");

      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claim_conflicts (id, tenant_id, claim_a_id, claim_b_id) VALUES ($1,$2,$3,$3)`,
            [randomUUID(), ctx.tenantId, claimA.claim.id],
          ),
        ),
      ).rejects.toThrow(/chk_claim_conflicts_distinct_claims/);

      await expect(
        withTenantTransaction(ctx.tenantId, (client) =>
          client.query(
            `INSERT INTO claim_conflicts (id, tenant_id, claim_a_id, claim_b_id, resolution_status)
             VALUES ($1,$2,$3,$4,'made_up_status')`,
            [randomUUID(), ctx.tenantId, claimA.claim.id, claimB.claim.id],
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe("no automatic conflict detection", () => {
    it("creating two obviously contradictory claims never inserts a claim_conflicts row -- proving the non-goal structurally", async () => {
      const acme = await createEntity({ tenantId: ctx.tenantId, entityType: "organization", canonicalName: "Acme (no-auto-conflict test)" });

      const claimA = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "employee_count_no_auto_conflict",
        objectValue: 100,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      const claimB = await recordClaim({
        tenantId: ctx.tenantId,
        subjectEntityId: acme.entity.id,
        predicate: "employee_count_no_auto_conflict",
        objectValue: 200,
        claimKind: "user_asserted",
        validFrom: "2026-01-01T00:00:00.000Z",
      });

      const conflicts = await fetchRows(
        ctx.tenantId,
        "SELECT id FROM claim_conflicts WHERE claim_a_id = ANY($1) OR claim_b_id = ANY($1)",
        [[claimA.claim.id, claimB.claim.id]],
      );
      expect(conflicts).toHaveLength(0);
    });
  });

  // =======================================================================
  // §57/§58: row-level security, run through the normal non-superuser role
  // =======================================================================
  describe("row-level security", () => {
    it("all five tables have RLS enabled and forced", async () => {
      const result = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`,
        [["entities", "entity_aliases", "claims", "claim_evidence", "claim_conflicts"]],
      );
      expect(result.rows).toHaveLength(5);
      for (const row of result.rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    });

    it("tenant isolation holds for entities, entity_aliases, claims, claim_evidence, and claim_conflicts under the non-superuser vireon role", async () => {
      const ctxA = await seedBaseContext();
      const ctxB = await seedBaseContext();

      const entity = await createEntity({
        tenantId: ctxA.tenantId,
        entityType: "organization",
        canonicalName: "RLS Probe Corp",
        aliases: ["RLS Probe"],
      });
      const claim = await recordClaim({
        tenantId: ctxA.tenantId,
        subjectEntityId: entity.entity.id,
        predicate: "rls_probe_predicate",
        objectValue: "ok",
        claimKind: "observed",
        validFrom: "2026-01-01T00:00:00.000Z",
        evidence: [{ kind: "message", messageId: ctxA.messageId }],
      });
      const conflictClaim = await recordClaim({
        tenantId: ctxA.tenantId,
        predicate: "rls_probe_predicate",
        objectValue: "other",
        claimKind: "observed",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      const conflict = await withTenantTransaction(ctxA.tenantId, (client) =>
        client.query(
          `INSERT INTO claim_conflicts (id, tenant_id, claim_a_id, claim_b_id) VALUES ($1,$2,$3,$4) RETURNING id`,
          [randomUUID(), ctxA.tenantId, claim.claim.id, conflictClaim.claim.id],
        ),
      );
      const conflictId = conflict.rows[0]!.id as string;

      const probes: Array<{ table: string; id: string }> = [
        { table: "entities", id: entity.entity.id },
        { table: "entity_aliases", id: entity.aliases[0]!.id },
        { table: "claims", id: claim.claim.id },
        { table: "claim_evidence", id: claim.evidence[0]!.id },
        { table: "claim_conflicts", id: conflictId },
      ];

      for (const probe of probes) {
        // Case 1: tenant context left entirely unset.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const unsetResult = await client.query(`SELECT id FROM ${probe.table} WHERE id = $1`, [probe.id]);
          expect(unsetResult.rows, probe.table).toHaveLength(0);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }

        // Case 2: the wrong tenant sees zero rows.
        const wrongTenantResult = await withTenantTransaction(ctxB.tenantId, (txClient) =>
          txClient.query(`SELECT id FROM ${probe.table} WHERE id = $1`, [probe.id]),
        );
        expect(wrongTenantResult.rows, probe.table).toHaveLength(0);

        // Control: the correct tenant still sees its own row.
        const correctTenantResult = await withTenantTransaction(ctxA.tenantId, (txClient) =>
          txClient.query(`SELECT id FROM ${probe.table} WHERE id = $1`, [probe.id]),
        );
        expect(correctTenantResult.rows, probe.table).toHaveLength(1);
      }
    });
  });
});
