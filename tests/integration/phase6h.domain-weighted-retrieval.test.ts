import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ELORA_PERSONA } from "@vireon/persona-config";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { retrieveRelevantMemory } from "../../src/elora/retrieveRelevantMemory.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { toEloraMessageResponse } from "../../src/http/contracts/eloraMessageResponse.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

async function seedMemoryRecord(tenantId: string, content: string, scope: string | null): Promise<string> {
  return withTenantTransaction(tenantId, async (client) => {
    const id = randomUUID();
    await client.query(`INSERT INTO memory_records (id, tenant_id, content, scope) VALUES ($1, $2, $3, $4)`, [
      id,
      tenantId,
      content,
      scope,
    ]);
    return id;
  });
}

describe("Phase 6H: Domain-Weighted Retrieval & Exposure acceptance (DB-backed)", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("5.1: domain-weighted ranking", () => {
    it("1. with no requestingPersonaDomain, ordering is unaffected -- byte-identical to the pre-6H query (pure recency)", async () => {
      const older = await seedMemoryRecord(ctx.tenantId, "alpha widget older term", "finance");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = await seedMemoryRecord(ctx.tenantId, "alpha widget newer term", "general");

      const results = await retrieveRelevantMemory({ tenantId: ctx.tenantId, queryText: "alpha widget" });
      const ids = results.map((record) => record.id);
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    });

    it("2. with a requestingPersonaDomain, scope-matching records rank first regardless of recency", async () => {
      const olderMatching = await seedMemoryRecord(ctx.tenantId, "beta gizmo older matching term", "finance");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newerNonMatching = await seedMemoryRecord(ctx.tenantId, "beta gizmo newer nonmatching term", "general");

      const results = await retrieveRelevantMemory({
        tenantId: ctx.tenantId,
        queryText: "beta gizmo",
        requestingPersonaDomain: "finance",
      });
      const ids = results.map((record) => record.id);
      expect(ids.indexOf(olderMatching)).toBeLessThan(ids.indexOf(newerNonMatching));
    });

    it("3. domain affects ranking, not access: a non-matching-scope record is still returned, never filtered out", async () => {
      const nonMatching = await seedMemoryRecord(ctx.tenantId, "gamma zephyr unique term", "general");

      const results = await retrieveRelevantMemory({
        tenantId: ctx.tenantId,
        queryText: "gamma zephyr",
        requestingPersonaDomain: "finance",
      });
      expect(results.map((record) => record.id)).toContain(nonMatching);
    });
  });

  describe("5.2: Elora's unweighted access", () => {
    it("4. ELORA_PERSONA.domain is null -- her real ingestion call path produces the same retrieval as omitting requestingPersonaDomain entirely", async () => {
      expect(ELORA_PERSONA.domain).toBeNull();

      const a = await seedMemoryRecord(ctx.tenantId, "delta quorra shared term one", "finance");
      const b = await seedMemoryRecord(ctx.tenantId, "delta quorra shared term two", "general");

      const withEloraDomain = await retrieveRelevantMemory({
        tenantId: ctx.tenantId,
        queryText: "delta quorra",
        requestingPersonaDomain: ELORA_PERSONA.domain,
      });
      const withFieldOmitted = await retrieveRelevantMemory({
        tenantId: ctx.tenantId,
        queryText: "delta quorra",
      });

      expect(withEloraDomain.map((record) => record.id)).toEqual(withFieldOmitted.map((record) => record.id));
      expect(withEloraDomain.map((record) => record.id).sort()).toEqual([a, b].sort());
    });

    it("5. the real ingestUserMessage() pipeline (Elora, domain null) is unaffected end-to-end by the 6H retrieval change", async () => {
      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        content: "Draft a quick summary for the team.",
        sourceSurface: "phase6h-test-harness",
        sourceCorrelationId: randomUUID(),
      });
      expect(result.retrievedMemoryCount).toBe(result.retrievedMemoryIds.length);
    });
  });

  describe("5.3: shared contract exposure", () => {
    it("6. retrievedMemoryCount round-trips through the backend transform into the shared contract shape", async () => {
      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        content: "Draft a quick summary for the team, referencing anything relevant.",
        sourceSurface: "phase6h-test-harness",
        sourceCorrelationId: randomUUID(),
      });

      const response = toEloraMessageResponse(result);
      expect(response.retrievedMemoryCount).toBe(result.retrievedMemoryCount);
      // Still deliberately excluded -- no UI consumer, no ranking internals on the wire.
      expect(response).not.toHaveProperty("retrievedMemoryIds");
    });
  });
});

describe("Phase 6H: token budget and prompt caching (unit, no DB)", () => {
  describe("5.4: token budget hook", () => {
    it("7. buildPrompt() truncates an oversized user message rather than sending it unbounded", async () => {
      const { buildPrompt } = await import("../../src/elora/llm/anthropicProvider.js");
      const oversized = "x".repeat(20_000);

      const { user } = buildPrompt({
        persona: ELORA_PERSONA,
        userMessageContent: oversized,
        taskType: "planning",
        authorityOutcome: "act_and_report",
        reason: "test reason",
        finalWorkOrderStatus: "READY_TO_ACT",
        toolResult: null,
        retrievedMemorySnippets: [],
      });

      expect(user.length).toBeLessThan(20_000);
      expect(user).toContain("truncated");
    });

    it("7b. buildPrompt() leaves an ordinary-sized message untouched", async () => {
      const { buildPrompt } = await import("../../src/elora/llm/anthropicProvider.js");

      const { user } = buildPrompt({
        persona: ELORA_PERSONA,
        userMessageContent: "A short, ordinary request.",
        taskType: "planning",
        authorityOutcome: "act_and_report",
        reason: "test reason",
        finalWorkOrderStatus: "READY_TO_ACT",
        toolResult: null,
        retrievedMemorySnippets: [],
      });

      expect(user).not.toContain("truncated");
      expect(user).toContain("A short, ordinary request.");
    });
  });

  describe("5.5: prompt caching", () => {
    it("8. the Anthropic call's system param is the content-block array form with cache_control: ephemeral, not a plain string", async () => {
      vi.resetModules();
      const createMock = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "mocked reply" }] });
      vi.doMock("@anthropic-ai/sdk", () => ({
        default: vi.fn().mockImplementation(() => ({ messages: { create: createMock } })),
      }));

      const { AnthropicProvider } = await import("../../src/elora/llm/anthropicProvider.js");
      const provider = new AnthropicProvider("test-key");

      await provider.generateResponse(
        {
          persona: ELORA_PERSONA,
          userMessageContent: "hello",
          taskType: "planning",
          authorityOutcome: "act_and_report",
          reason: "test reason",
          finalWorkOrderStatus: "READY_TO_ACT",
          toolResult: null,
          retrievedMemorySnippets: [],
        },
        5000,
      );

      expect(createMock).toHaveBeenCalledTimes(1);
      const callArgs = createMock.mock.calls[0]?.[0];
      expect(Array.isArray(callArgs.system)).toBe(true);
      expect(callArgs.system[0]).toMatchObject({
        type: "text",
        cache_control: { type: "ephemeral" },
      });
      expect(typeof callArgs.system[0].text).toBe("string");

      vi.doUnmock("@anthropic-ai/sdk");
      vi.resetModules();
    });
  });
});
