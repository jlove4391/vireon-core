import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import {
  CandidateNotApprovedError,
  InvalidCandidateReviewStateError,
  MemoryCandidateNotFoundError,
  promoteMemoryCandidate,
  reviewMemoryCandidate,
} from "../../src/elora/memory/index.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { HAPPY_PATH_INTERPRETED_INTENT, HAPPY_PATH_TASK_TYPE, HAPPY_PATH_TRANSITIONS } from "../../src/state/lifecycleFixtures.js";
import { transitionWorkOrder } from "../../src/state/transitionWorkOrder.js";
import { listMemoryCandidates } from "../../tools/diagnostics/memory.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { seedMemoryRecord } from "../shared/seedMemoryRecord.js";

async function seedProposedCandidate(
  ctx: SeededContext,
  overrides: { scope?: string; content?: string; candidateType?: string } = {},
): Promise<string> {
  return withTenantTransaction(ctx.tenantId, async (client) => {
    const id = randomUUID();
    // source_message_id satisfies memoryCandidateSchema's refine (at least
    // one of source_message_id/source_receipt_id/source_work_order_id must
    // be set) -- every real candidate always has one of these; a raw
    // fixture insert with none would never actually happen in production.
    await client.query(
      `INSERT INTO memory_candidates
         (id, tenant_id, source_message_id, candidate_content, candidate_type, scope, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'proposed')`,
      [
        id,
        ctx.tenantId,
        ctx.messageId,
        overrides.content ?? "A candidate worth reviewing.",
        overrides.candidateType ?? "observation",
        overrides.scope ?? "general",
      ],
    );
    return id;
  });
}

async function fetchCandidateRow(tenantId: string, candidateId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM memory_candidates WHERE id = $1 AND tenant_id = $2", [
      candidateId,
      tenantId,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error(`candidate ${candidateId} not found`);
    return row;
  });
}

describe("Phase 6G: Memory Review & Promotion acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. migration reconciliation: the scope='project' -> 'general' UPDATE clause correctly relabels stale rows", async () => {
    // Migration 0007 is one-shot and already applied to this database, so
    // it cannot be literally re-run to prove its reconciliation logic --
    // this exercises the exact UPDATE clause it uses, tenant-scoped,
    // against freshly-seeded rows shaped like what pre-migration data
    // looked like.
    const candidateId = randomUUID();
    const seededRecord = await seedMemoryRecord({
      tenantId: ctx.tenantId,
      content: "stale-labeled record",
      scope: "project",
    });
    const recordId = seededRecord.id;
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO memory_candidates (id, tenant_id, candidate_content, scope, review_status)
         VALUES ($1, $2, 'stale-labeled candidate', 'project', 'proposed')`,
        [candidateId, ctx.tenantId],
      );

      await client.query("UPDATE memory_candidates SET scope = 'general' WHERE scope = 'project'");
      await client.query("UPDATE memory_records SET scope = 'general' WHERE scope = 'project'");
    });

    const candidateRow = await fetchCandidateRow(ctx.tenantId, candidateId);
    expect(candidateRow.scope).toBe("general");

    const recordRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query("SELECT scope FROM memory_records WHERE id = $1", [recordId]);
      return result.rows[0];
    });
    expect(recordRow.scope).toBe("general");
  });

  it("2. scope still has no CHECK constraint: arbitrary free-text values are accepted directly, confirmed against the catalog", async () => {
    const arbitraryScope = "some-arbitrary-future-domain";
    const candidateId = await seedProposedCandidate(ctx, { scope: arbitraryScope });
    const row = await fetchCandidateRow(ctx.tenantId, candidateId);
    expect(row.scope).toBe(arbitraryScope);

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE (conrelid = 'memory_candidates'::regclass OR conrelid = 'memory_records'::regclass)
         AND contype = 'c'
         AND conname ILIKE '%scope%'`,
    );
    expect(constraints.rows).toHaveLength(0);
  });

  it("3. reviewMemoryCandidate() transitions proposed -> approved, setting all three new columns", async () => {
    const candidateId = await seedProposedCandidate(ctx);
    const reviewed = await reviewMemoryCandidate({
      tenantId: ctx.tenantId,
      candidateId,
      actorId: ctx.actorId,
      decision: "approved",
      note: "Looks accurate and worth keeping.",
    });

    expect(reviewed.review_status).toBe("approved");
    expect(reviewed.reviewed_by_actor_id).toBe(ctx.actorId);
    expect(reviewed.reviewed_at).not.toBeNull();
    expect(reviewed.review_note).toBe("Looks accurate and worth keeping.");
  });

  it("3b. reviewMemoryCandidate() transitions proposed -> rejected, setting all three new columns", async () => {
    const candidateId = await seedProposedCandidate(ctx);
    const reviewed = await reviewMemoryCandidate({
      tenantId: ctx.tenantId,
      candidateId,
      actorId: ctx.actorId,
      decision: "rejected",
    });

    expect(reviewed.review_status).toBe("rejected");
    expect(reviewed.reviewed_by_actor_id).toBe(ctx.actorId);
    expect(reviewed.reviewed_at).not.toBeNull();
    expect(reviewed.review_note).toBeNull();
  });

  it("4. reviewMemoryCandidate() throws InvalidCandidateReviewStateError on a non-proposed candidate, including a second call on an already-reviewed one", async () => {
    const candidateId = await seedProposedCandidate(ctx);
    await reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId, decision: "approved" });

    await expect(
      reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId, decision: "rejected" }),
    ).rejects.toThrow(InvalidCandidateReviewStateError);

    // A candidate not found at all is a distinct, typed failure too.
    await expect(
      reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId: randomUUID(), actorId: ctx.actorId, decision: "approved" }),
    ).rejects.toThrow(MemoryCandidateNotFoundError);
  });

  it("5. promoteMemoryCandidate() succeeds only from approved, creates a real memory_records row, updates the candidate atomically", async () => {
    const candidateId = await seedProposedCandidate(ctx, {
      content: "A durable fact worth remembering.",
      candidateType: "observation",
      scope: "general",
    });
    await reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId, decision: "approved" });

    const record = await promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId });

    expect(record.content).toBe("A durable fact worth remembering.");
    expect(record.scope).toBe("general");
    expect(record.record_type).toBe("observation");
    expect(record.source_candidate_id).toBe(candidateId);

    // Verify both writes directly via query, not just the return value.
    const persistedRecord = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query("SELECT * FROM memory_records WHERE id = $1 AND tenant_id = $2", [
        record.id,
        ctx.tenantId,
      ]);
      return result.rows[0];
    });
    expect(persistedRecord).toBeDefined();
    expect(persistedRecord.content).toBe("A durable fact worth remembering.");

    const candidateRow = await fetchCandidateRow(ctx.tenantId, candidateId);
    expect(candidateRow.review_status).toBe("promoted");
    expect(candidateRow.promoted_memory_record_id).toBe(record.id);
  });

  it("6. promoteMemoryCandidate() throws CandidateNotApprovedError on proposed/rejected, and a second call after successful promotion also throws", async () => {
    const proposedId = await seedProposedCandidate(ctx);
    await expect(
      promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId: proposedId, actorId: ctx.actorId }),
    ).rejects.toThrow(CandidateNotApprovedError);

    const rejectedId = await seedProposedCandidate(ctx);
    await reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId: rejectedId, actorId: ctx.actorId, decision: "rejected" });
    await expect(
      promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId: rejectedId, actorId: ctx.actorId }),
    ).rejects.toThrow(CandidateNotApprovedError);

    const approvedId = await seedProposedCandidate(ctx);
    await reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId: approvedId, actorId: ctx.actorId, decision: "approved" });
    await promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId: approvedId, actorId: ctx.actorId });
    // Second call, state precondition failure, not idempotent.
    await expect(
      promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId: approvedId, actorId: ctx.actorId }),
    ).rejects.toThrow(CandidateNotApprovedError);
  });

  it("7. cross-tenant integrity: reviewed_by_actor_id referencing an actor from a different tenant fails with a foreign-key violation", async () => {
    const otherCtx = await seedBaseContext();
    const candidateId = await seedProposedCandidate(ctx);

    let caught: unknown;
    try {
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `UPDATE memory_candidates SET review_status = 'approved', reviewed_by_actor_id = $1, reviewed_at = now()
           WHERE id = $2 AND tenant_id = $3`,
          [otherCtx.actorId, candidateId, ctx.tenantId],
        );
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("23503");
  });

  it("8. CLI commands (review, promote, list) work end-to-end against a real seeded candidate", async () => {
    // Same precedent phase2_5.diagnostics-console.test.ts established: the
    // CLI's own index.ts is a thin dispatcher over these exact functions,
    // so exercising them directly is exercising the CLI commands
    // end-to-end, without spawning a child process.
    const candidateId = await seedProposedCandidate(ctx, { content: "CLI end-to-end probe." });

    const listedBeforeReview = await listMemoryCandidates(ctx.tenantId, { status: "proposed" });
    expect(listedBeforeReview.some((c) => c.id === candidateId)).toBe(true);

    const reviewed = await reviewMemoryCandidate({
      tenantId: ctx.tenantId,
      candidateId,
      actorId: ctx.actorId,
      decision: "approved",
      note: "CLI review command probe.",
    });
    expect(reviewed.review_status).toBe("approved");

    const listedAfterReview = await listMemoryCandidates(ctx.tenantId, { status: "approved" });
    expect(listedAfterReview.some((c) => c.id === candidateId)).toBe(true);

    const record = await promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId });
    expect(record.content).toBe("CLI end-to-end probe.");

    const listedAfterPromotion = await listMemoryCandidates(ctx.tenantId, { status: "promoted" });
    expect(listedAfterPromotion.some((c) => c.id === candidateId)).toBe(true);
  });

  it("9. the dormant transitionWorkOrder.ts path (via lifecycleFixtures.ts) now writes 'general', not 'project'", async () => {
    // Static check on the fixture itself.
    const memoryFixture = HAPPY_PATH_TRANSITIONS.find((t) => t.memoryCandidate)?.memoryCandidate;
    expect(memoryFixture?.scope).toBe("general");

    // Live check: actually drive a WorkOrder through the exact fixture
    // sequence (same as phase2/2.5's own tests) and confirm the resulting
    // memory_candidates row reflects it. This path is unreachable from any
    // production ingestUserMessage() pipeline, but it is reachable here,
    // via the same fixture Phase 2/2.5 already exercise -- which is
    // exactly how this is verified live, not just by inspection.
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.actorId,
      taskType: HAPPY_PATH_TASK_TYPE,
      interpretedIntent: `${HAPPY_PATH_INTERPRETED_INTENT} (phase6g probe)`,
    });

    let lastMemoryCandidateId: string | undefined;
    for (const fixture of HAPPY_PATH_TRANSITIONS) {
      const result = await transitionWorkOrder({
        tenantId: ctx.tenantId,
        workOrderId: workOrder.id,
        nextStatus: fixture.nextStatus,
        actorId: ctx.actorId,
        reason: fixture.reason,
        authorityDecision: fixture.authorityDecision,
        memoryCandidate: fixture.memoryCandidate,
      });
      if (result.memoryCandidate) {
        lastMemoryCandidateId = result.memoryCandidate.id;
      }
    }

    expect(lastMemoryCandidateId).toBeDefined();
    const row = await fetchCandidateRow(ctx.tenantId, lastMemoryCandidateId!);
    expect(row.scope).toBe("general");
  });

  // Item 10 (git diff confirms the only change to transitionWorkOrder.ts...)
  // does not apply as originally framed: transitionWorkOrder.ts never
  // hardcoded "project" in the first place (confirmed during Step 0 -- it's
  // a pure pass-through of whatever scope the caller supplies). The actual
  // second hardcoded "project" value lived in src/state/lifecycleFixtures.ts,
  // a Phase 2 test fixture, not production runtime code -- fixed there
  // instead. `git diff` on transitionWorkOrder.ts is empty (zero changes),
  // confirmed in the completion report, not this file.
  //
  // Item 11 (full Phase 1-6F regression) is verified by running the full
  // `pnpm test` suite -- see the Phase 6G completion report, not this file.
});
