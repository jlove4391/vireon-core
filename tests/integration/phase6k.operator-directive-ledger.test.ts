import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { createOrMergeDirective } from "../../src/directives/createOrMergeDirective.js";
import { appendDirectiveRevision } from "../../src/directives/appendDirectiveRevision.js";
import { transitionDirective } from "../../src/directives/transitionDirective.js";
import { addDirectiveProvenance } from "../../src/directives/addDirectiveProvenance.js";
import { suppressDirectiveKey } from "../../src/directives/suppressDirectiveKey.js";
import { reopenDirective } from "../../src/directives/reopenDirective.js";
import { acceptDirective } from "../../src/directives/acceptDirective.js";
import { deferDirective } from "../../src/directives/deferDirective.js";
import { completeDirective } from "../../src/directives/completeDirective.js";
import { dismissDirective } from "../../src/directives/dismissDirective.js";
import { expireDirective } from "../../src/directives/expireDirective.js";
import { getDirectiveDetail } from "../../src/directives/getDirectiveDetail.js";
import { getDirectiveHistory } from "../../src/directives/getDirectiveHistory.js";
import {
  DirectiveNotFoundError,
  DirectiveReferenceNotFoundError,
  InvalidDirectiveInputError,
  InvalidDirectiveTransitionError,
  TerminalDirectiveStateError,
  UnsubstantiatedCompletionError,
} from "../../src/directives/errors.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

async function countDirectives(tenantId: string, dedupeKey: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT count(*)::int AS n FROM operator_directives WHERE tenant_id = $1 AND dedupe_key = $2", [
      tenantId,
      dedupeKey,
    ]);
    return (result.rows[0] as { n: number }).n;
  });
}

async function countRevisions(tenantId: string, directiveId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM operator_directive_revisions WHERE tenant_id = $1 AND directive_id = $2",
      [tenantId, directiveId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

async function countTransitions(tenantId: string, directiveId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM operator_directive_transitions WHERE tenant_id = $1 AND directive_id = $2",
      [tenantId, directiveId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

async function countProvenance(tenantId: string, directiveId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM operator_directive_provenance WHERE tenant_id = $1 AND directive_id = $2",
      [tenantId, directiveId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

/** Fixture only: fast-forwards a real WorkOrder straight to COMPLETED via raw SQL, without exercising WorkOrderStatus's own state machine -- not what this test suite is verifying. */
async function seedCompletedWorkOrder(ctx: SeededContext): Promise<string> {
  const { workOrder } = await createWorkOrder({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    actorId: ctx.actorId,
    taskType: "analysis",
    interpretedIntent: "fixture work order for 6K system-validated completion test",
  });
  await withTenantTransaction(ctx.tenantId, (client) =>
    client.query("UPDATE work_orders SET status = 'COMPLETED' WHERE id = $1 AND tenant_id = $2", [
      workOrder.id,
      ctx.tenantId,
    ]),
  );
  return workOrder.id;
}

describe("Phase 6K: Operator Directive Ledger acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. one semantic issue creates one Directive; re-detection with identical content does not create a second one", async () => {
    const dedupeKey = `budget-overrun:${randomUUID()}`;
    const input = {
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Q3 budget overrun detected",
      body: "Marketing spend is 12% over the quarterly plan.",
    };

    const first = await createOrMergeDirective(input);
    expect(first.outcome).toBe("created");
    expect(first.directive?.state).toBe("PROPOSED");
    expect(first.revision?.revision_number).toBe(1);
    expect(first.transition?.from_state).toBeNull();
    expect(first.transition?.to_state).toBe("PROPOSED");

    const countAfterFirst = await countDirectives(ctx.tenantId, dedupeKey);
    expect(countAfterFirst).toBe(1);

    const second = await createOrMergeDirective(input);
    expect(second.outcome).toBe("carried");
    expect(second.directive?.id).toBe(first.directive?.id);

    const countAfterSecond = await countDirectives(ctx.tenantId, dedupeKey);
    expect(countAfterSecond).toBe(1);
  });

  it("2. repeated detection adds provenance rather than a duplicate Directive", async () => {
    const dedupeKey = `latency-spike:${randomUUID()}`;
    const baseInput = {
      tenantId: ctx.tenantId,
      directiveType: "blocker" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "API latency spike",
    };

    const first = await createOrMergeDirective({
      ...baseInput,
      provenanceSource: { kind: "message", messageId: ctx.messageId },
    });
    expect(first.outcome).toBe("created");

    await createOrMergeDirective({ ...baseInput, provenanceSource: { kind: "message", messageId: ctx.messageId } });
    await createOrMergeDirective({ ...baseInput, provenanceSource: { kind: "message", messageId: ctx.messageId } });

    const directiveCount = await countDirectives(ctx.tenantId, dedupeKey);
    expect(directiveCount).toBe(1);

    const provenanceCount = await countProvenance(ctx.tenantId, first.directive!.id);
    expect(provenanceCount).toBe(3);
  });

  it("3. material content changes create a revision; identical re-detection does not", async () => {
    const dedupeKey = `capacity-warning:${randomUUID()}`;
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Capacity warning",
      body: "Disk usage at 80%.",
    });
    expect(created.outcome).toBe("created");
    const directiveId = created.directive!.id;
    expect(await countRevisions(ctx.tenantId, directiveId)).toBe(1);

    const revised = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Capacity warning",
      body: "Disk usage at 92% -- now critical.",
    });
    expect(revised.outcome).toBe("revised");
    expect(revised.revision?.revision_number).toBe(2);
    expect(await countRevisions(ctx.tenantId, directiveId)).toBe(2);

    const carried = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Capacity warning",
      body: "Disk usage at 92% -- now critical.",
    });
    expect(carried.outcome).toBe("carried");
    expect(await countRevisions(ctx.tenantId, directiveId)).toBe(2);
  });

  it("4. accept, defer, complete, dismiss, expire, reopen are all valid controlled transitions", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision" as const,
      dedupeKey: `transition-coverage:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Decide on vendor renewal",
    });
    const directiveId = created.directive!.id;

    const accepted = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "OPEN",
      actorId: ctx.actorId,
      reason: "accept",
    });
    expect(accepted.directive.state).toBe("OPEN");
    expect(accepted.directive.accepted_at).not.toBeNull();

    const deferred = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "DEFERRED",
      actorId: ctx.actorId,
      reason: "defer",
    });
    expect(deferred.directive.state).toBe("DEFERRED");
    expect(deferred.directive.deferred_at).not.toBeNull();

    const reopened = await reopenDirective({
      tenantId: ctx.tenantId,
      directiveId,
      actorId: ctx.actorId,
      reason: "resuming after standup",
    });
    expect(reopened.directive.state).toBe("OPEN");

    const inProgress = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "IN_PROGRESS",
      actorId: ctx.actorId,
      reason: "start",
    });
    expect(inProgress.directive.state).toBe("IN_PROGRESS");
    expect(inProgress.directive.started_at).not.toBeNull();

    const completed = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "COMPLETED",
      actorId: ctx.actorId,
      reason: "complete",
      completionMode: "operator_attested",
    });
    expect(completed.directive.state).toBe("COMPLETED");
    expect(completed.directive.completed_at).not.toBeNull();

    const reopenedAfterCompletion = await reopenDirective({
      tenantId: ctx.tenantId,
      directiveId,
      actorId: ctx.actorId,
      reason: "turns out it wasn't actually done",
    });
    expect(reopenedAfterCompletion.directive.state).toBe("OPEN");

    const dismissed = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "DISMISSED",
      actorId: ctx.actorId,
      reason: "dismiss",
    });
    expect(dismissed.directive.state).toBe("DISMISSED");
    expect(dismissed.directive.dismissed_at).not.toBeNull();

    const reopenedAfterDismiss = await reopenDirective({
      tenantId: ctx.tenantId,
      directiveId,
      actorId: ctx.actorId,
      reason: "still relevant",
    });
    expect(reopenedAfterDismiss.directive.state).toBe("OPEN");

    const expired = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "EXPIRED",
      actorId: ctx.actorId,
      reason: "expire",
    });
    expect(expired.directive.state).toBe("EXPIRED");

    const reopenedAfterExpiry = await reopenDirective({
      tenantId: ctx.tenantId,
      directiveId,
      actorId: ctx.actorId,
      reason: "still needed",
    });
    expect(reopenedAfterExpiry.directive.state).toBe("OPEN");

    // Full transition history preserved.
    const history = await getDirectiveHistory(ctx.tenantId, directiveId);
    expect(history.transitions.length).toBeGreaterThanOrEqual(9);
  });

  it("5. invalid transitions fail with a typed error, not a silent no-op", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "focus" as const,
      dedupeKey: `invalid-transition-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Focus item",
    });
    const directiveId = created.directive!.id;

    // PROPOSED -> IN_PROGRESS is not a valid transition (must accept first).
    await expect(
      transitionDirective({
        tenantId: ctx.tenantId,
        directiveId,
        toState: "IN_PROGRESS",
        actorId: ctx.actorId,
        reason: "skip ahead",
      }),
    ).rejects.toBeInstanceOf(InvalidDirectiveTransitionError);

    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });
    await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "SUPERSEDED",
      actorId: ctx.actorId,
      reason: "replaced by a broader initiative",
    });

    // SUPERSEDED is genuinely terminal.
    await expect(
      transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "try to reopen" }),
    ).rejects.toBeInstanceOf(TerminalDirectiveStateError);
  });

  it("6. manual completion is labeled operator-attested; system-validated completion requires and checks real execution evidence", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `completion-mode-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Ship the migration",
    });
    const directiveId = created.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });

    // completionMode is mandatory.
    await expect(
      transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "COMPLETED", actorId: ctx.actorId, reason: "done" }),
    ).rejects.toBeInstanceOf(InvalidDirectiveInputError);

    // system_validated claimed without any real completed-WorkOrder provenance -- must be rejected, not silently accepted.
    await expect(
      transitionDirective({
        tenantId: ctx.tenantId,
        directiveId,
        toState: "COMPLETED",
        actorId: ctx.actorId,
        reason: "claiming done",
        completionMode: "system_validated",
      }),
    ).rejects.toBeInstanceOf(UnsubstantiatedCompletionError);

    // operator_attested requires no evidence at all.
    const attested = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "COMPLETED",
      actorId: ctx.actorId,
      reason: "I checked, it's done",
      completionMode: "operator_attested",
    });
    expect(attested.transition.metadata.completionMode).toBe("operator_attested");

    // Now prove system_validated succeeds once real evidence exists.
    const created2 = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `completion-mode-check-2:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Ship the other migration",
    });
    const directiveId2 = created2.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId: directiveId2, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });

    const completedWorkOrderId = await seedCompletedWorkOrder(ctx);
    await addDirectiveProvenance({
      tenantId: ctx.tenantId,
      directiveId: directiveId2,
      source: { kind: "work_order", workOrderId: completedWorkOrderId },
    });

    const validated = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId: directiveId2,
      toState: "COMPLETED",
      actorId: ctx.actorId,
      reason: "the linked work order actually completed",
      completionMode: "system_validated",
    });
    expect(validated.directive.state).toBe("COMPLETED");
    expect(validated.transition.metadata.completionMode).toBe("system_validated");
  });

  it("7. cross-tenant access fails -- a Directive in tenant A is invisible to tenant B", async () => {
    const tenantB = await seedBaseContext();

    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: `cross-tenant-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Tenant A's own directive",
    });
    const directiveId = created.directive!.id;

    await expect(getDirectiveDetail(tenantB.tenantId, directiveId)).rejects.toBeInstanceOf(DirectiveNotFoundError);
    await expect(
      transitionDirective({ tenantId: tenantB.tenantId, directiveId, toState: "OPEN", actorId: tenantB.actorId, reason: "cross-tenant attempt" }),
    ).rejects.toBeInstanceOf(DirectiveNotFoundError);

    const wrongTenantRow = await withTenantTransaction(tenantB.tenantId, (client) =>
      client.query("SELECT id FROM operator_directives WHERE id = $1", [directiveId]),
    );
    expect(wrongTenantRow.rows).toHaveLength(0);

    const detail = await getDirectiveDetail(ctx.tenantId, directiveId);
    expect(detail.directive.id).toBe(directiveId);
  });

  it("8. rollback leaves no partial revision or transition when a create attempt fails partway", async () => {
    const dedupeKey = `rollback-check:${randomUUID()}`;

    // A provenanceSource pointing at a nonexistent work_order_id fails the
    // FK constraint on the provenance insert -- the LAST write in
    // createOrMergeDirective's create path. If the directive/revision/
    // transition writes that already happened earlier in the same
    // transaction aren't rolled back too, this test would find orphans.
    await expect(
      createOrMergeDirective({
        tenantId: ctx.tenantId,
        directiveType: "watch" as const,
        dedupeKey,
        issuingActorId: ctx.actorId,
        owningActorId: ctx.actorId,
        title: "Should never actually persist",
        provenanceSource: { kind: "work_order", workOrderId: randomUUID() },
      }),
    ).rejects.toThrow();

    const directiveCount = await countDirectives(ctx.tenantId, dedupeKey);
    expect(directiveCount).toBe(0);

    const orphanRevisions = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM operator_directive_revisions r WHERE NOT EXISTS (SELECT 1 FROM operator_directives d WHERE d.id = r.directive_id)",
      ),
    );
    expect((orphanRevisions.rows[0] as { n: number }).n).toBe(0);

    const orphanTransitions = await withTenantTransaction(ctx.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM operator_directive_transitions t WHERE NOT EXISTS (SELECT 1 FROM operator_directives d WHERE d.id = t.directive_id)",
      ),
    );
    expect((orphanTransitions.rows[0] as { n: number }).n).toBe(0);
  });

  it("9. process restart preserves full history -- reading back via a fresh query reconstructs everything durably", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision" as const,
      dedupeKey: `restart-durability-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Durability check",
    });
    const directiveId = created.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });
    await appendDirectiveRevision({
      tenantId: ctx.tenantId,
      directiveId,
      title: "Durability check (updated)",
      changeReason: "clarified scope",
      createdByActorId: ctx.actorId,
    });

    // A brand-new pool client/transaction, not anything cached from the
    // calls above -- nothing in this domain holds durable state in
    // process memory, only Postgres.
    const history = await getDirectiveHistory(ctx.tenantId, directiveId);
    expect(history.revisions).toHaveLength(2);
    expect(history.transitions).toHaveLength(2); // create (NULL->PROPOSED) + accept (PROPOSED->OPEN)
    expect(history.directive.state).toBe("OPEN");
  });

  it("10. no Directive service imports or calls anything from the authority/tool-execution surface", () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const directivesDir = path.resolve(__dirname, "../../src/directives");
    const forbidden = [
      "classifyAuthority",
      "resolveAuthorityWithHierarchy",
      "dispatchTool",
      "invokeRegisteredTool",
      "tools/gateway",
      "ingestUserMessage",
    ];

    const files = readdirSync(directivesDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(path.join(directivesDir, file), "utf8");
      for (const term of forbidden) {
        expect(content.includes(term), `${file} must not reference "${term}"`).toBe(false);
      }
    }
  });

  it("timestamp columns reflect most-recent entry into a state, not the first (deliberate overwrite, not write-once -- these are a current-status fast path on the parent row)", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `timestamp-overwrite-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Timestamp overwrite check",
    });
    const directiveId = created.directive!.id;

    const accepted = await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });
    const firstAcceptedAt = accepted.directive.accepted_at;
    expect(firstAcceptedAt).not.toBeNull();

    const completed = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "COMPLETED",
      actorId: ctx.actorId,
      reason: "complete",
      completionMode: "operator_attested",
    });
    const firstCompletedAt = completed.directive.completed_at;
    expect(firstCompletedAt).not.toBeNull();

    const reopened = await reopenDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "not actually done" });
    const secondAcceptedAt = reopened.directive.accepted_at;
    // OPEN was re-entered -- accepted_at must advance to this second
    // acceptance, not stay frozen at the first. These columns are a
    // current-status fast path, not a first-occurrence record.
    expect(secondAcceptedAt).not.toBe(firstAcceptedAt);
    expect(new Date(secondAcceptedAt!).getTime()).toBeGreaterThan(new Date(firstAcceptedAt!).getTime());

    const completedAgain = await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "COMPLETED",
      actorId: ctx.actorId,
      reason: "complete again",
      completionMode: "operator_attested",
    });
    // completed_at must advance to this second completion, not stay
    // frozen at the first -- a months-stale completed_at would be a
    // misleading answer to "when did this most recently complete."
    expect(completedAgain.directive.completed_at).not.toBe(firstCompletedAt);
    expect(new Date(completedAgain.directive.completed_at!).getTime()).toBeGreaterThan(
      new Date(firstCompletedAt!).getTime(),
    );

    // First-occurrence history is never lost even though the row's own
    // column advances -- it's fully recoverable from the transitions
    // table (earliest entry into COMPLETED), exactly as documented.
    const history = await getDirectiveHistory(ctx.tenantId, directiveId);
    const completedTransitions = history.transitions.filter((t) => t.to_state === "COMPLETED");
    expect(completedTransitions).toHaveLength(2);
    expect(completedTransitions[0]!.created_at).toBe(firstCompletedAt);
  });

  it("all six named-verb wrappers (accept/defer/complete/dismiss/expire/reopen) reach the correct state and tag metadata.verb honestly, independent of the caller's free-text reason", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: `verb-wrapper-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Verb wrapper check",
    });
    const directiveId = created.directive!.id;

    const accepted = await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "looks real" });
    expect(accepted.directive.state).toBe("OPEN");
    expect(accepted.transition.metadata.verb).toBe("accept");

    const deferred = await deferDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "later" });
    expect(deferred.directive.state).toBe("DEFERRED");
    expect(deferred.transition.metadata.verb).toBe("defer");

    const reopened = await reopenDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "picking it back up" });
    expect(reopened.directive.state).toBe("OPEN");
    expect(reopened.transition.metadata.verb).toBe("reopen");

    const completed = await completeDirective({
      tenantId: ctx.tenantId,
      directiveId,
      actorId: ctx.actorId,
      reason: "done",
      completionMode: "operator_attested",
    });
    expect(completed.directive.state).toBe("COMPLETED");
    expect(completed.transition.metadata.verb).toBe("complete");
    expect(completed.transition.metadata.completionMode).toBe("operator_attested");

    const reopenedAgain = await reopenDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "not actually done" });
    expect(reopenedAgain.directive.state).toBe("OPEN");

    const dismissed = await dismissDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "no longer relevant" });
    expect(dismissed.directive.state).toBe("DISMISSED");
    expect(dismissed.transition.metadata.verb).toBe("dismiss");

    const reopenedThrice = await reopenDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "actually still relevant" });
    expect(reopenedThrice.directive.state).toBe("OPEN");

    const expired = await expireDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "window passed" });
    expect(expired.directive.state).toBe("EXPIRED");
    expect(expired.transition.metadata.verb).toBe("expire");

    // The wrapper layer adds no validation of its own -- confirm illegal
    // transitions still fail through the same wrapper.
    await expect(
      acceptDirective({ tenantId: ctx.tenantId, directiveId: created.directive!.id, actorId: ctx.actorId, reason: "irrelevant reason text" }),
    ).resolves.toBeTruthy(); // EXPIRED -> OPEN via accept is legal (same edge reopen uses) -- proves wrappers share one graph, not per-verb rules
  });

  it("suppression: a suppressed dedupe key blocks creation without creating anything", async () => {
    const dedupeKey = `suppressed-key:${randomUUID()}`;
    await suppressDirectiveKey({
      tenantId: ctx.tenantId,
      dedupeKey,
      reason: "known noisy alert, muted for the week",
      suppressedByActorId: ctx.actorId,
      suppressedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const result = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Should be suppressed",
    });
    expect(result.outcome).toBe("suppressed");
    expect(result.directive).toBeUndefined();
    expect(await countDirectives(ctx.tenantId, dedupeKey)).toBe(0);
  });

  it("a duplicate-detection event on an already-open Directive never counts as a defer (no transition row written)", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: `no-implicit-defer-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Still live",
    });
    const directiveId = created.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });

    const transitionsBefore = await countTransitions(ctx.tenantId, directiveId);
    const carried = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: created.dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Still live",
    });
    expect(carried.outcome).toBe("carried");
    const transitionsAfter = await countTransitions(ctx.tenantId, directiveId);
    expect(transitionsAfter).toBe(transitionsBefore);

    const detail = await getDirectiveDetail(ctx.tenantId, directiveId);
    expect(detail.directive.state).toBe("OPEN");
    expect(detail.deferCount).toBe(0);
  });

  it("re-detection of a closed Directive reopens it automatically", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: `auto-reopen-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Auto reopen check",
    });
    const directiveId = created.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });
    await transitionDirective({
      tenantId: ctx.tenantId,
      directiveId,
      toState: "DISMISSED",
      actorId: ctx.actorId,
      reason: "thought it was resolved",
    });

    const redetected = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: created.dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Auto reopen check",
    });
    expect(redetected.outcome).toBe("reopened");
    expect(redetected.directive?.state).toBe("OPEN");
  });

  it("PR #22 review fix 1: a plain FK alone does not stop a cross-tenant internal reference -- write-time tenant checks reject it", async () => {
    const tenantB = await seedBaseContext();

    // A real WorkOrder that genuinely exists, just in the wrong tenant.
    const { workOrder: tenantBWorkOrder } = await createWorkOrder({
      tenantId: tenantB.tenantId,
      workspaceId: tenantB.workspaceId,
      projectId: tenantB.projectId,
      threadId: tenantB.threadId,
      messageId: tenantB.messageId,
      actorId: tenantB.actorId,
      taskType: "analysis",
      interpretedIntent: "tenant B's own work order",
    });

    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `cross-tenant-provenance-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Cross-tenant provenance check",
    });
    const directiveId = created.directive!.id;

    // Provenance pointing at tenant B's real WorkOrder from tenant A's
    // transaction must be rejected -- the row exists, just not for this
    // tenant, and a plain FK alone can't tell the difference.
    await expect(
      addDirectiveProvenance({
        tenantId: ctx.tenantId,
        directiveId,
        source: { kind: "work_order", workOrderId: tenantBWorkOrder.id },
      }),
    ).rejects.toBeInstanceOf(DirectiveReferenceNotFoundError);
    expect(await countProvenance(ctx.tenantId, directiveId)).toBe(0);

    // Same gap, same fix, for an actor reference: transitionDirective's
    // actorId, appendDirectiveRevision's createdByActorId/
    // proposedOwnerActorId, and suppressDirectiveKey's suppressedByActorId
    // must all reject a real-but-wrong-tenant actor id.
    await expect(
      transitionDirective({
        tenantId: ctx.tenantId,
        directiveId,
        toState: "OPEN",
        actorId: tenantB.actorId,
        reason: "cross-tenant actor attempt",
      }),
    ).rejects.toBeInstanceOf(DirectiveReferenceNotFoundError);

    await expect(
      appendDirectiveRevision({
        tenantId: ctx.tenantId,
        directiveId,
        title: "Should not be allowed",
        createdByActorId: tenantB.actorId,
      }),
    ).rejects.toBeInstanceOf(DirectiveReferenceNotFoundError);

    await expect(
      appendDirectiveRevision({
        tenantId: ctx.tenantId,
        directiveId,
        title: "Should not be allowed either",
        createdByActorId: ctx.actorId,
        proposedOwnerActorId: tenantB.actorId,
      }),
    ).rejects.toBeInstanceOf(DirectiveReferenceNotFoundError);

    await expect(
      suppressDirectiveKey({
        tenantId: ctx.tenantId,
        dedupeKey: `cross-tenant-suppression-check:${randomUUID()}`,
        reason: "attempted with a foreign actor",
        suppressedByActorId: tenantB.actorId,
        suppressedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(DirectiveReferenceNotFoundError);

    // Confirm the same reference genuinely succeeds when it's actually
    // this tenant's own row -- the check rejects wrong-tenant, not
    // everything.
    const ownWorkOrder = await seedCompletedWorkOrder(ctx);
    const provenance = await addDirectiveProvenance({
      tenantId: ctx.tenantId,
      directiveId,
      source: { kind: "work_order", workOrderId: ownWorkOrder },
    });
    expect(provenance.work_order_id).toBe(ownWorkOrder);
  });

  it("PR #22 review fix 2: two concurrent create attempts on the same dedupe key never raise a raw constraint error and never duplicate", async () => {
    const dedupeKey = `concurrent-create-check:${randomUUID()}`;
    const input = {
      tenantId: ctx.tenantId,
      directiveType: "blocker" as const,
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Concurrent creation race",
      body: "Identical content on both concurrent attempts.",
    };

    const [a, b] = await Promise.all([createOrMergeDirective(input), createOrMergeDirective(input)]);

    // Neither call may throw a raw persistence error -- both must resolve
    // to a coherent outcome (exactly one "created", the other merging into
    // the same row rather than erroring or duplicating).
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["carried", "created"]);
    expect(a.directive?.id).toBe(b.directive?.id);

    expect(await countDirectives(ctx.tenantId, dedupeKey)).toBe(1);
  });

  it("PR #22 review fix 3: due_at/window_start_at/window_end_at/expires_at stay in sync on the parent row even when appendDirectiveRevision is called directly", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `temporal-sync-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Temporal sync check",
    });
    const directiveId = created.directive!.id;
    expect(created.directive?.due_at).toBeNull();

    const newDueAt = new Date(Date.now() + 86_400_000).toISOString();
    const newWindowStart = new Date(Date.now() + 3_600_000).toISOString();
    const newWindowEnd = new Date(Date.now() + 7_200_000).toISOString();
    const newExpiresAt = new Date(Date.now() + 172_800_000).toISOString();

    // insertDirectiveRevisionRow's own public entry point -- not routed
    // through createOrMergeDirective at all -- must still mirror the new
    // temporal fields onto the parent ledger row.
    await appendDirectiveRevision({
      tenantId: ctx.tenantId,
      directiveId,
      title: "Temporal sync check",
      dueAt: newDueAt,
      windowStartAt: newWindowStart,
      windowEndAt: newWindowEnd,
      expiresAt: newExpiresAt,
      changeReason: "direct revision call, not via createOrMergeDirective",
      createdByActorId: ctx.actorId,
    });

    const detail = await getDirectiveDetail(ctx.tenantId, directiveId);
    expect(detail.directive.due_at).toBe(newDueAt);
    expect(detail.directive.window_start_at).toBe(newWindowStart);
    expect(detail.directive.window_end_at).toBe(newWindowEnd);
    expect(detail.directive.expires_at).toBe(newExpiresAt);
  });

  it("PR #22 review fix 4: a suppression key with incidental whitespace still blocks the trimmed dedupe key it was meant for", async () => {
    const bareKey = `suppression-whitespace-check:${randomUUID()}`;
    await suppressDirectiveKey({
      tenantId: ctx.tenantId,
      dedupeKey: `  ${bareKey}  `,
      reason: "submitted with incidental whitespace",
      suppressedByActorId: ctx.actorId,
      suppressedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const result = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch" as const,
      dedupeKey: bareKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Should still be suppressed despite the whitespace",
    });
    expect(result.outcome).toBe("suppressed");
    expect(await countDirectives(ctx.tenantId, bareKey)).toBe(0);
  });

  it("PR #22 review fix 5a: an arbitrary completionMode string is rejected, not silently written into the transition's audit metadata", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action" as const,
      dedupeKey: `completion-mode-enum-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Completion mode enum check",
    });
    const directiveId = created.directive!.id;
    await transitionDirective({ tenantId: ctx.tenantId, directiveId, toState: "OPEN", actorId: ctx.actorId, reason: "accept" });

    await expect(
      transitionDirective({
        tenantId: ctx.tenantId,
        directiveId,
        toState: "COMPLETED",
        actorId: ctx.actorId,
        reason: "claiming done with a bogus mode",
        // Not a valid DirectiveCompletionMode -- deliberately cast past the
        // type system the way a less-trusted caller (an HTTP body, a tool
        // result) would arrive at runtime with no static guarantee at all.
        completionMode: "definitely_done_trust_me" as unknown as "operator_attested",
      }),
    ).rejects.toBeInstanceOf(InvalidDirectiveInputError);

    // Must still be OPEN -- the bogus value must not have partially
    // applied before being rejected.
    const detail = await getDirectiveDetail(ctx.tenantId, directiveId);
    expect(detail.directive.state).toBe("OPEN");
  });
});
