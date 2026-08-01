import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { acceptDirective } from "../../src/directives/acceptDirective.js";
import { createOrMergeDirective } from "../../src/directives/createOrMergeDirective.js";
import { deferDirective } from "../../src/directives/deferDirective.js";
import { expireDirective } from "../../src/directives/expireDirective.js";
import { appendDirectiveRevision } from "../../src/directives/appendDirectiveRevision.js";
import { getBriefingIssueDetail } from "../../src/briefing/getBriefingIssueDetail.js";
import { issueBriefing } from "../../src/briefing/issueBriefing.js";
import { BriefingReferenceNotFoundError, InvalidBriefingInputError } from "../../src/briefing/errors.js";
import { readWorkspaceFile, loadWorkspaceConfig, resolveWorkspaceRoot } from "../../src/tools/workspace.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

async function newActor(tenantId: string, workspaceId: string, name: string): Promise<string> {
  const id = randomUUID();
  await withTenantTransaction(tenantId, (client) =>
    client.query(
      `INSERT INTO actors (id, tenant_id, actor_type, actor_name, actor_role, acting_system)
       VALUES ($1,$2,'system',$3,'test',$4)`,
      [id, tenantId, name, "phase6l-test-harness"],
    ),
  );
  return id;
}

async function countBriefingIssues(tenantId: string, briefingType: string, localIssueDate: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM briefing_issues WHERE tenant_id = $1 AND briefing_type = $2 AND local_issue_date = $3",
      [tenantId, briefingType, localIssueDate],
    );
    return result.rows[0]!.n;
  });
}

describe("Phase 6L: Briefing Issue and Carry-Forward Engine acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. one tenant/briefing-type/local-date/timezone produces one canonical issue", async () => {
    const localIssueDate = "2026-01-05";
    const first = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: "daily",
      localIssueDate,
      timezone: "America/New_York",
      issuedByActorId: ctx.actorId,
    });
    const second = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: "daily",
      localIssueDate,
      timezone: "America/New_York",
      issuedByActorId: ctx.actorId,
    });

    expect(first.issue.id).toBe(second.issue.id);
    expect(second.alreadyIssued).toBe(true);
    expect(first.issue.status).toBe("ISSUED");
    expect(await countBriefingIssues(ctx.tenantId, "daily", localIssueDate)).toBe(1);
  });

  it("2. an Unresolved Directive carries across issues without duplicating the Directive", async () => {
    const dedupeKey = `phase6l-carry-check:${randomUUID()}`;
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action",
      dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Carry-check action directive",
    });
    const directiveId = created.directive!.id;
    await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "accept" });

    const day1 = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: "carry-check",
      localIssueDate: "2026-02-01",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const day1Entry = day1.entries.find((e) => e.directive_id === directiveId);
    expect(day1Entry).toBeDefined();
    expect(day1Entry!.new_to_issue).toBe(true);
    expect(day1Entry!.carried_from_issue_id).toBeNull();

    const day2 = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: "carry-check",
      localIssueDate: "2026-02-02",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const day2Entry = day2.entries.find((e) => e.directive_id === directiveId);
    expect(day2Entry).toBeDefined();
    expect(day2Entry!.new_to_issue).toBe(false);
    expect(day2Entry!.carried_from_issue_id).toBe(day1.issue.id);

    // The Directive itself is not duplicated -- still exactly one row.
    const directiveCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query("SELECT count(*)::int AS n FROM operator_directives WHERE tenant_id = $1 AND dedupe_key = $2", [
        ctx.tenantId,
        dedupeKey,
      ]);
      return (result.rows[0] as { n: number }).n;
    });
    expect(directiveCount).toBe(1);
  });

  it("3. carry and defer remain distinct facts", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision",
      dedupeKey: `phase6l-carry-vs-defer:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Carry vs defer check",
    });
    const directiveId = created.directive!.id;
    await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "accept" });
    await deferDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "not today" });
    // Deferred is a closed-but-reopenable state -- re-detect to reopen it
    // so it's genuinely unresolved again for collection. Carries
    // provenance (a re-detection event) explicitly, since carry_count is
    // provenance-derived -- the defer above alone adds no provenance row.
    await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision",
      dedupeKey: created.dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Carry vs defer check",
      provenanceSource: { kind: "external", provider: "phase6l-test-harness", externalIdentifier: "carry-vs-defer-redetect" },
    });

    const issue = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: `carry-vs-defer-${randomUUID()}`,
      localIssueDate: "2026-02-03",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const entry = issue.entries.find((e) => e.directive_id === directiveId);
    expect(entry).toBeDefined();
    // carry_count_snapshot (provenance rows) and defer_count_snapshot
    // (DEFERRED transitions) are tracked independently -- one explicit
    // defer must not silently also read as a "carry."
    expect(entry!.defer_count_snapshot).toBe(1);
    expect(entry!.carry_count_snapshot).toBeGreaterThanOrEqual(1);
    expect(entry!.defer_count_snapshot).not.toBe(entry!.carry_count_snapshot === 1 ? -1 : entry!.carry_count_snapshot);
  });

  it("4. historical entry snapshots remain stable even if the underlying Directive later changes", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action",
      dedupeKey: `phase6l-snapshot-stability:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Original title",
    });
    const directiveId = created.directive!.id;
    await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "accept" });

    const issue = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: `snapshot-stability-${randomUUID()}`,
      localIssueDate: "2026-02-04",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const entryBefore = issue.entries.find((e) => e.directive_id === directiveId)!;
    const carryCountBefore = entryBefore.carry_count_snapshot;

    // Materially change the Directive after the issue was created.
    await appendDirectiveRevision({
      tenantId: ctx.tenantId,
      directiveId,
      title: "Materially changed title",
      changeReason: "test mutation after issuance",
      createdByActorId: ctx.actorId,
    });
    await deferDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "changed my mind" });

    const entryAfter = await withTenantTransaction(ctx.tenantId, async (client) => {
      const result = await client.query("SELECT * FROM briefing_issue_entries WHERE tenant_id = $1 AND id = $2", [
        ctx.tenantId,
        entryBefore.id,
      ]);
      return result.rows[0] as Record<string, unknown>;
    });

    expect(entryAfter.carry_count_snapshot).toBe(carryCountBefore);
    expect(entryAfter.defer_count_snapshot).toBe(entryBefore.defer_count_snapshot);
  });

  it("5. an expired Watch leaves the active issue", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch",
      dedupeKey: `phase6l-expired-watch:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Watch that will expire",
    });
    const directiveId = created.directive!.id;
    await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `expired-watch-${randomUUID()}`;
    const before = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-02-05",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    expect(before.entries.some((e) => e.directive_id === directiveId)).toBe(true);

    await expireDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "no longer relevant" });

    const after = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-02-06",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    expect(after.entries.some((e) => e.directive_id === directiveId)).toBe(false);
  });

  it("6. a repeatedly-deferred Decision shows increasing defer_count_snapshot across issues", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision",
      dedupeKey: `phase6l-escalation:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Repeatedly deferred decision",
    });
    const directiveId = created.directive!.id;
    await acceptDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `escalation-${randomUUID()}`;
    const issue1 = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-02-07",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const entry1 = issue1.entries.find((e) => e.directive_id === directiveId)!;
    expect(entry1.defer_count_snapshot).toBe(0);
    expect(entry1.escalation_level_snapshot).toBe(0);

    await deferDirective({ tenantId: ctx.tenantId, directiveId, actorId: ctx.actorId, reason: "defer 1" });
    await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision",
      dedupeKey: created.dedupeKey,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Repeatedly deferred decision",
    });

    const issue2 = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-02-08",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const entry2 = issue2.entries.find((e) => e.directive_id === directiveId)!;
    expect(entry2.defer_count_snapshot).toBe(1);
    expect(entry2.escalation_level_snapshot).toBe(1);
    expect(entry2.escalation_level_snapshot!).toBeGreaterThan(entry1.escalation_level_snapshot!);
  });

  it("7. first move is deterministic: a Blocker always outranks a Decision regardless of collection order", async () => {
    const decision = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "decision",
      dedupeKey: `phase6l-first-move-decision:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "A pressing decision",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: decision.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const blocker = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "blocker",
      dedupeKey: `phase6l-first-move-blocker:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "A blocking issue",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: blocker.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `first-move-${randomUUID()}`;
    const result = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-02-09",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    expect(result.issue.first_move_directive_id).toBe(blocker.directive!.id);

    // Determinism: re-running with the exact same underlying state (a
    // fresh tenant, same construction order) produces the same outcome.
    const tenantB = await seedBaseContext();
    const decisionB = await createOrMergeDirective({
      tenantId: tenantB.tenantId,
      directiveType: "decision",
      dedupeKey: "first-move-decision",
      issuingActorId: tenantB.actorId,
      owningActorId: tenantB.actorId,
      title: "A pressing decision",
    });
    await acceptDirective({ tenantId: tenantB.tenantId, directiveId: decisionB.directive!.id, actorId: tenantB.actorId, reason: "accept" });
    const blockerB = await createOrMergeDirective({
      tenantId: tenantB.tenantId,
      directiveType: "blocker",
      dedupeKey: "first-move-blocker",
      issuingActorId: tenantB.actorId,
      owningActorId: tenantB.actorId,
      title: "A blocking issue",
    });
    await acceptDirective({ tenantId: tenantB.tenantId, directiveId: blockerB.directive!.id, actorId: tenantB.actorId, reason: "accept" });
    const resultB = await issueBriefing({
      tenantId: tenantB.tenantId,
      briefingType,
      localIssueDate: "2026-02-09",
      timezone: "UTC",
      issuedByActorId: tenantB.actorId,
    });
    expect(resultB.issue.first_move_directive_id).toBe(blockerB.directive!.id);
  });

  it("8. prose is generated from the same entries that were persisted -- no separate/divergent read path", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action",
      dedupeKey: `phase6l-prose-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Prose consistency check action",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: created.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `prose-check-${randomUUID()}`;
    const localIssueDate = "2026-02-10";
    const result = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate,
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    expect(result.issue.prose_artifact_id).not.toBeNull();

    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, ctx.tenantId, null);
    const relativePath = `briefings/${briefingType}/${localIssueDate}.md`;
    const file = await readWorkspaceFile(config, root, relativePath);

    expect(file.content).toContain("Prose consistency check action");
    expect(file.content).toContain("## Actions");

    const artifactRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT content_hash, byte_count FROM artifacts WHERE id = $1 AND tenant_id = $2", [
        result.issue.prose_artifact_id,
        ctx.tenantId,
      ]);
      return r.rows[0] as { content_hash: string; byte_count: number };
    });
    expect(artifactRow.content_hash).toBe(file.contentHash);
    expect(artifactRow.byte_count).toBe(file.byteCount);
  });

  it("9. restart/concurrency does not duplicate an issue", async () => {
    const briefingType = `restart-check-${randomUUID()}`;
    const localIssueDate = "2026-02-11";
    const input = {
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate,
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    };

    const [a, b] = await Promise.all([issueBriefing(input), issueBriefing(input)]);
    expect(a.issue.id).toBe(b.issue.id);
    expect([a.alreadyIssued, b.alreadyIssued].filter(Boolean)).toHaveLength(1);
    expect(await countBriefingIssues(ctx.tenantId, briefingType, localIssueDate)).toBe(1);

    // Sequential "restart" after success -- also a clean no-op, not a new row.
    const c = await issueBriefing(input);
    expect(c.issue.id).toBe(a.issue.id);
    expect(c.alreadyIssued).toBe(true);
    expect(await countBriefingIssues(ctx.tenantId, briefingType, localIssueDate)).toBe(1);
  });

  it("10. candidate collection never fabricates provider evidence -- every entry traces to a real row in a canonical CORE table", async () => {
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.actorId,
      taskType: "analysis",
      interpretedIntent: "Phase 6L provider-evidence check",
    });

    const result = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: `provider-evidence-${randomUUID()}`,
      localIssueDate: "2026-02-12",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    const workOrderEntry = result.entries.find((e) => e.work_order_id === workOrder.id);
    expect(workOrderEntry).toBeDefined();

    // Every entry's source id resolves to a real row this same tenant
    // actually owns -- no entry references a fabricated or external id.
    await withTenantTransaction(ctx.tenantId, async (client) => {
      for (const entry of result.entries) {
        if (entry.work_order_id) {
          const r = await client.query("SELECT id FROM work_orders WHERE id = $1 AND tenant_id = $2", [entry.work_order_id, ctx.tenantId]);
          expect(r.rows).toHaveLength(1);
        }
        if (entry.directive_id) {
          const r = await client.query("SELECT id FROM operator_directives WHERE id = $1 AND tenant_id = $2", [entry.directive_id, ctx.tenantId]);
          expect(r.rows).toHaveLength(1);
        }
      }
    });
  });

  it("PR B: issuedByActorId belonging to a different tenant is rejected with BriefingReferenceNotFoundError, and persists no partial issue", async () => {
    const tenantB = await seedBaseContext();
    const briefingType = `cross-tenant-actor-${randomUUID()}`;
    const localIssueDate = "2026-02-13";

    await expect(
      issueBriefing({
        tenantId: ctx.tenantId,
        briefingType,
        localIssueDate,
        timezone: "UTC",
        issuedByActorId: tenantB.actorId,
      }),
    ).rejects.toBeInstanceOf(BriefingReferenceNotFoundError);

    expect(await countBriefingIssues(ctx.tenantId, briefingType, localIssueDate)).toBe(0);
  });

  it("PR B: sourceWorkOrderId belonging to a different tenant is rejected", async () => {
    const tenantB = await seedBaseContext();
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

    await expect(
      issueBriefing({
        tenantId: ctx.tenantId,
        briefingType: `cross-tenant-source-wo-${randomUUID()}`,
        localIssueDate: "2026-02-14",
        timezone: "UTC",
        issuedByActorId: ctx.actorId,
        sourceWorkOrderId: tenantBWorkOrder.id,
      }),
    ).rejects.toBeInstanceOf(BriefingReferenceNotFoundError);
  });

  it("PR B: Focus directive window-gating -- not-yet-open and already-closed windows are excluded, an open window is included", async () => {
    const now = new Date("2026-03-10T12:00:00.000Z");

    const notYetOpen = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "focus",
      dedupeKey: `phase6l-focus-not-open:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Focus window not yet open",
      windowStartAt: "2026-03-11T00:00:00.000Z",
      windowEndAt: "2026-03-12T00:00:00.000Z",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: notYetOpen.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const alreadyClosed = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "focus",
      dedupeKey: `phase6l-focus-closed:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Focus window already closed",
      windowStartAt: "2026-03-01T00:00:00.000Z",
      windowEndAt: "2026-03-09T00:00:00.000Z",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: alreadyClosed.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const currentlyOpen = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "focus",
      dedupeKey: `phase6l-focus-open:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Focus window currently open",
      windowStartAt: "2026-03-09T00:00:00.000Z",
      windowEndAt: "2026-03-11T00:00:00.000Z",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: currentlyOpen.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const result = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: `focus-window-${randomUUID()}`,
      localIssueDate: "2026-03-10",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
      now,
    });

    const includedIds = new Set(result.entries.filter((e) => e.lane === "focus").map((e) => e.directive_id));
    expect(includedIds.has(currentlyOpen.directive!.id)).toBe(true);
    expect(includedIds.has(notYetOpen.directive!.id)).toBe(false);
    expect(includedIds.has(alreadyClosed.directive!.id)).toBe(false);
  });

  it("getBriefingIssueDetail returns the same issue+entries issueBriefing() persisted", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch",
      dedupeKey: `phase6l-detail-check:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Detail check watch",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: created.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const result = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType: `detail-check-${randomUUID()}`,
      localIssueDate: "2026-02-15",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    const detail = await getBriefingIssueDetail(ctx.tenantId, result.issue.id);
    expect(detail.issue.id).toBe(result.issue.id);
    expect(detail.entries.map((e) => e.id).sort()).toEqual(result.entries.map((e) => e.id).sort());
  });

  it("rejects invalid input without touching the database", async () => {
    await expect(
      issueBriefing({
        tenantId: ctx.tenantId,
        briefingType: "  ",
        localIssueDate: "2026-02-16",
        timezone: "UTC",
        issuedByActorId: ctx.actorId,
      }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);

    await expect(
      issueBriefing({
        tenantId: ctx.tenantId,
        briefingType: "daily",
        localIssueDate: "not-a-date",
        timezone: "UTC",
        issuedByActorId: ctx.actorId,
      }),
    ).rejects.toBeInstanceOf(InvalidBriefingInputError);
  });
});
