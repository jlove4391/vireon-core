import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EloraMessageResponseSchema } from "@vireon/contracts";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { registerCoreTools } from "../../src/tools/index.js";
import { toEloraMessageResponse } from "../../src/http/contracts/eloraMessageResponse.js";
import { eloraMessagesRouter } from "../../src/http/routes/eloraMessages.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

let testWorkspaceRoot: string;
let ctx: SeededContext;

describe("Phase 6E: Stable UI-Facing Contract Layer acceptance", () => {
  beforeAll(async () => {
    testWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vireon-phase6e-"));
    process.env.ELORA_WORKSPACE_ROOT = testWorkspaceRoot;

    await migrate();
    registerCoreTools();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await fs.rm(testWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    await pool.end();
  });

  it("3. backend transform round-trip: a real act_and_report result maps correctly and validates", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Help me draft a project plan for CORE memory v1.",
      sourceSurface: "phase6e-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    const response = toEloraMessageResponse(result);

    // Validates -- toEloraMessageResponse() already .parse()s internally,
    // but confirm independently too, same as a real client would.
    expect(() => EloraMessageResponseSchema.parse(response)).not.toThrow();

    // Every included field maps correctly from the real internal result.
    expect(response.schemaVersion).toBe("1");
    expect(response.threadId).toBe(result.threadId);
    expect(response.messageId).toBe(result.messageId);
    expect(response.isDuplicateMessage).toBe(result.isDuplicateMessage);
    expect(response.responseType).toBe(result.responseType);
    expect(response.responseText).toBe(result.responseText);
    expect(response.workOrderId).toBe(result.workOrderId);
    expect(response.authorityOutcome).toBe(result.authorityOutcome);
    expect(response.finalWorkOrderStatus).toBe(result.finalWorkOrderStatus);
    expect(response.actionReceiptId).toBe(result.actionReceiptId);
    expect(response.blockedReceiptId).toBe(result.blockedReceiptId);
    expect(response.toolInvocationId).toBe(result.toolInvocationId);
    expect(response.artifactId).toBe(result.artifactId);
    expect(response.artifactFilename).toBe(result.intent.artifactRequest?.filename ?? null);
    expect(response.memoryCandidateIds).toEqual(result.memoryCandidateIds);
    // 6H §5.3: retrievedMemoryCount is now deliberately included (a bare
    // count, decided as the "minimum safe" retrieval metadata) -- moved
    // out of the "excluded fields" block below, which is exactly why this
    // assertion belongs here now instead of there.
    expect(response.retrievedMemoryCount).toBe(result.retrievedMemoryCount);

    // Excluded fields genuinely absent from the DTO, not just unchecked --
    // confirms the flattening/narrowing actually happened.
    expect(response).not.toHaveProperty("tenantId");
    expect(response).not.toHaveProperty("authorityDecisionId");
    expect(response).not.toHaveProperty("transitionPath");
    expect(response).not.toHaveProperty("retrievedMemoryIds");
    expect(response).not.toHaveProperty("intent");
  });

  it("3b. backend transform round-trip: a real blocked (escalate) result maps correctly and validates", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Send an email to the team and deploy this to production.",
      sourceSurface: "phase6e-test-harness",
      sourceCorrelationId: randomUUID(),
      isSystemInitiated: true,
    });

    const response = toEloraMessageResponse(result);
    expect(() => EloraMessageResponseSchema.parse(response)).not.toThrow();
    expect(response.authorityOutcome).toBe("escalate");
    expect(response.blockedReceiptId).toBe(result.blockedReceiptId);
    expect(response.blockedReceiptId).not.toBeNull();
    expect(response.actionReceiptId).toBeNull();
    expect(response.artifactFilename).toBeNull();
  });

  it("5. artifactFilename flattening carries the real filename (not null) on the artifact-creation acceptance path", async () => {
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Create a local markdown artifact named phase6e-contract.md containing: contract layer probe.",
      sourceSurface: "phase6e-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.task_type).toBe("artifact_creation");
    expect(result.intent.artifactRequest?.filename).toBe("phase6e-contract.md");
    expect(result.artifactId).not.toBeNull();

    const response = toEloraMessageResponse(result);
    expect(() => EloraMessageResponseSchema.parse(response)).not.toThrow();
    expect(response.artifactFilename).toBe("phase6e-contract.md");
    expect(response.artifactId).toBe(result.artifactId);
  });

  it("4. real HTTP route response validates end-to-end against EloraMessageResponseSchema", async () => {
    // Real dev identity, same as the actual frontend uses -- VIREON_DEV_*
    // must be set in .env (scripts/seedDevIdentity.ts). Not the isolated
    // per-test tenant used above; this specifically exercises the real
    // route's real request path, not just the transform function.
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(eloraMessagesRouter);

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const httpResponse = await fetch(`http://127.0.0.1:${port}/api/elora/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Draft a short status update for the team.",
          clientRequestId: randomUUID(),
        }),
      });

      expect(httpResponse.status).toBe(200);
      const body = await httpResponse.json();

      const parsed = EloraMessageResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.schemaVersion).toBe("1");
        expect(typeof parsed.data.responseText).toBe("string");
      }

      // The raw internal shape must not have leaked onto the wire.
      expect(body).not.toHaveProperty("tenantId");
      expect(body).not.toHaveProperty("intent");
      expect(body).not.toHaveProperty("transitionPath");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
