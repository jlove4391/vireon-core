import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BriefingIssueDTOSchema, IssueBriefingResponseSchema, LatestBriefingResponseSchema } from "@vireon/contracts";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { acceptDirective } from "../../src/directives/acceptDirective.js";
import { createOrMergeDirective } from "../../src/directives/createOrMergeDirective.js";
import { getLatestBriefingIssue } from "../../src/briefing/getLatestBriefingIssue.js";
import { issueBriefing } from "../../src/briefing/issueBriefing.js";
import { toBriefingIssueDTO } from "../../src/http/contracts/briefingIssueResponse.js";
import { briefingsRouter } from "../../src/http/routes/briefings.js";
import { createWorkOrder } from "../../src/state/createWorkOrder.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

let ctx: SeededContext;

describe("Phase 6M: Operator Deck Vertical Slice acceptance", () => {
  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1. getLatestBriefingIssue returns null when no issue exists yet for this tenant/type", async () => {
    const result = await getLatestBriefingIssue(ctx.tenantId, `no-issue-yet-${randomUUID()}`);
    expect(result).toBeNull();
  });

  it("2. getLatestBriefingIssue resolves a Directive-sourced entry's title/detail from its frozen directive_revision_id", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "action",
      dedupeKey: `phase6m-directive-display:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Ship the deck read path",
      whyNow: "Operators need to see today's briefing",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: created.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `directive-display-${randomUUID()}`;
    await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-03-01",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    const detail = await getLatestBriefingIssue(ctx.tenantId, briefingType);
    expect(detail).not.toBeNull();
    const entry = detail!.entries.find((e) => e.directive_id === created.directive!.id);
    expect(entry).toBeDefined();
    const display = detail!.displayByEntryId.get(entry!.id);
    expect(display?.title).toBe("Ship the deck read path");
    expect(display?.detail).toBe("Operators need to see today's briefing");
  });

  it("3. getLatestBriefingIssue resolves a WorkOrder-sourced entry's title/detail", async () => {
    const { workOrder } = await createWorkOrder({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      actorId: ctx.actorId,
      taskType: "analysis",
      interpretedIntent: "Phase 6M work-order display check",
    });

    const briefingType = `wo-display-${randomUUID()}`;
    await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-03-02",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    const detail = await getLatestBriefingIssue(ctx.tenantId, briefingType);
    const entry = detail!.entries.find((e) => e.work_order_id === workOrder.id);
    expect(entry).toBeDefined();
    const display = detail!.displayByEntryId.get(entry!.id);
    expect(display?.title).toBe("Phase 6M work-order display check");
    expect(display?.detail).toContain("analysis");
  });

  it("4. entry_status = 'removed' entries are excluded from getLatestBriefingIssue -- constructed directly via SQL since no service writes that value", async () => {
    const created = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "watch",
      dedupeKey: `phase6m-removed-filter:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "Watch that gets marked removed",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: created.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `removed-filter-${randomUUID()}`;
    const issued = await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-03-03",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });
    const entry = issued.entries.find((e) => e.directive_id === created.directive!.id);
    expect(entry).toBeDefined();

    await withTenantTransaction(ctx.tenantId, (client) =>
      client.query("UPDATE briefing_issue_entries SET entry_status = 'removed' WHERE id = $1 AND tenant_id = $2", [
        entry!.id,
        ctx.tenantId,
      ]),
    );

    const detail = await getLatestBriefingIssue(ctx.tenantId, briefingType);
    expect(detail!.entries.some((e) => e.id === entry!.id)).toBe(false);
  });

  it("5. toBriefingIssueDTO produces a schema-valid DTO with correct firstMoveEntryId/laneOrder/laneLabels", async () => {
    const blocker = await createOrMergeDirective({
      tenantId: ctx.tenantId,
      directiveType: "blocker",
      dedupeKey: `phase6m-dto-blocker:${randomUUID()}`,
      issuingActorId: ctx.actorId,
      owningActorId: ctx.actorId,
      title: "A blocking issue for the DTO check",
    });
    await acceptDirective({ tenantId: ctx.tenantId, directiveId: blocker.directive!.id, actorId: ctx.actorId, reason: "accept" });

    const briefingType = `dto-check-${randomUUID()}`;
    await issueBriefing({
      tenantId: ctx.tenantId,
      briefingType,
      localIssueDate: "2026-03-04",
      timezone: "UTC",
      issuedByActorId: ctx.actorId,
    });

    const detail = await getLatestBriefingIssue(ctx.tenantId, briefingType);
    const dto = toBriefingIssueDTO(detail!);

    expect(() => BriefingIssueDTOSchema.parse(dto)).not.toThrow();
    expect(dto.laneOrder).toEqual(["decision", "focus", "action", "blocker", "watch", "completed", "evidence"]);
    expect(dto.laneLabels.blocker).toBe("Blocked or Held");

    const firstMoveEntry = dto.entries.find((e) => e.id === dto.firstMoveEntryId);
    expect(firstMoveEntry).toBeDefined();
    expect(firstMoveEntry!.lane).toBe("blocker");
    expect(firstMoveEntry!.title).toBe("A blocking issue for the DTO check");

    // Internal-only fields must not leak onto the DTO.
    expect(dto).not.toHaveProperty("tenantId");
    expect(dto.entries[0]).not.toHaveProperty("directiveId");
    expect(dto.entries[0]).not.toHaveProperty("workOrderId");
    expect(dto.entries[0]).not.toHaveProperty("entryStatus");
  });

  describe("HTTP routes", () => {
    let server: import("node:http").Server;
    let baseUrl: string;
    const originalEnv = {
      tenantId: process.env.VIREON_DEV_TENANT_ID,
      actorId: process.env.VIREON_DEV_ACTOR_ID,
      workspaceId: process.env.VIREON_DEV_WORKSPACE_ID,
      projectId: process.env.VIREON_DEV_PROJECT_ID,
    };

    beforeAll(async () => {
      // Self-contained dev identity for these route tests -- does not
      // depend on a real .env having been seeded via seedDevIdentity.ts.
      process.env.VIREON_DEV_TENANT_ID = ctx.tenantId;
      process.env.VIREON_DEV_ACTOR_ID = ctx.actorId;
      process.env.VIREON_DEV_WORKSPACE_ID = ctx.workspaceId;
      process.env.VIREON_DEV_PROJECT_ID = ctx.projectId;

      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(briefingsRouter);
      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
      process.env.VIREON_DEV_TENANT_ID = originalEnv.tenantId;
      process.env.VIREON_DEV_ACTOR_ID = originalEnv.actorId;
      process.env.VIREON_DEV_WORKSPACE_ID = originalEnv.workspaceId;
      process.env.VIREON_DEV_PROJECT_ID = originalEnv.projectId;
    });

    it("6. GET /api/briefings/latest returns the empty-state shape (200, issue: null), not a 404, when nothing has been issued yet", async () => {
      const briefingType = `http-empty-${randomUUID()}`;
      const response = await fetch(`${baseUrl}/api/briefings/latest?briefingType=${briefingType}&timezone=UTC`);
      expect(response.status).toBe(200);
      const body = await response.json();
      const parsed = LatestBriefingResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.issue).toBeNull();
      }
    });

    it("7. POST /api/briefings/issue creates a real issue, and GET /api/briefings/latest then returns it", async () => {
      const briefingType = `http-issue-${randomUUID()}`;
      const postResponse = await fetch(`${baseUrl}/api/briefings/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefingType, localIssueDate: "2026-03-05", timezone: "UTC" }),
      });
      expect(postResponse.status).toBe(200);
      const postBody = await postResponse.json();
      const postParsed = IssueBriefingResponseSchema.safeParse(postBody);
      expect(postParsed.success).toBe(true);
      if (postParsed.success) {
        expect(postParsed.data.alreadyIssued).toBe(false);
        expect(postParsed.data.issue.briefingType).toBe(briefingType);
      }

      const getResponse = await fetch(`${baseUrl}/api/briefings/latest?briefingType=${briefingType}&timezone=UTC`);
      const getBody = await getResponse.json();
      const getParsed = LatestBriefingResponseSchema.safeParse(getBody);
      expect(getParsed.success).toBe(true);
      if (getParsed.success && postParsed.success) {
        expect(getParsed.data.issue?.id).toBe(postParsed.data.issue.id);
      }
    });

    it("8. POST /api/briefings/issue is idempotent -- a repeat call for the same day returns the same issue with alreadyIssued: true", async () => {
      const briefingType = `http-idempotent-${randomUUID()}`;
      const body = { briefingType, localIssueDate: "2026-03-06", timezone: "UTC" };

      const first = await fetch(`${baseUrl}/api/briefings/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const firstParsed = IssueBriefingResponseSchema.parse(await first.json());

      const second = await fetch(`${baseUrl}/api/briefings/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const secondParsed = IssueBriefingResponseSchema.parse(await second.json());

      expect(secondParsed.alreadyIssued).toBe(true);
      expect(secondParsed.issue.id).toBe(firstParsed.issue.id);
    });

    it("9. POST /api/briefings/issue rejects an invalid body with 400", async () => {
      const response = await fetch(`${baseUrl}/api/briefings/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefingType: "daily", localIssueDate: "not-a-date", timezone: "UTC" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("10. GET /api/briefings/latest rejects a missing timezone with 400", async () => {
      const response = await fetch(`${baseUrl}/api/briefings/latest?briefingType=daily`);
      expect(response.status).toBe(400);
    });

    it("11. missing dev identity produces 500 DEV_IDENTITY_MISSING, not a partial/unhandled failure", async () => {
      delete process.env.VIREON_DEV_TENANT_ID;
      try {
        const response = await fetch(`${baseUrl}/api/briefings/latest?briefingType=daily&timezone=UTC`);
        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("DEV_IDENTITY_MISSING");
      } finally {
        process.env.VIREON_DEV_TENANT_ID = ctx.tenantId;
      }
    });
  });
});
