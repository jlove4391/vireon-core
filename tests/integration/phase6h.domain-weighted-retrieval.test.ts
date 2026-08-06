import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ELORA_PERSONA } from "@vireon/persona-config";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { retrieveRelevantMemory } from "../../src/elora/retrieveRelevantMemory.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { toEloraMessageResponse } from "../../src/http/contracts/eloraMessageResponse.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { seedMemoryRecord as seedMemoryRecordWithVersion } from "../shared/seedMemoryRecord.js";

async function seedMemoryRecord(tenantId: string, content: string, scope: string | null): Promise<string> {
  const record = await seedMemoryRecordWithVersion({ tenantId, content, scope });
  return record.id;
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

    // PR #19 review finding: `scope = $N` is SQL three-valued logic -- a
    // null-scope row evaluates the comparison to NULL, and Postgres's
    // default NULL ordering for DESC is NULLS FIRST, so an unmatched
    // null-scope row would rank ahead of even a genuine domain match.
    // Seeds the null-scope row *more recently* than the match specifically
    // so recency alone can't produce the correct answer by accident --
    // only correct domain-ranking logic gets this right.
    it("3b. a null-scope record never outranks a genuine domain match, even when the null-scope record is more recent", async () => {
      const matching = await seedMemoryRecord(ctx.tenantId, "epsilon omega matching term", "finance");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const nullScoped = await seedMemoryRecord(ctx.tenantId, "epsilon omega null scope term", null);

      const results = await retrieveRelevantMemory({
        tenantId: ctx.tenantId,
        queryText: "epsilon omega",
        requestingPersonaDomain: "finance",
      });
      const ids = results.map((record) => record.id);
      expect(ids.indexOf(matching)).toBeLessThan(ids.indexOf(nullScoped));
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

describe("Phase 6H: retrieveRelevantMemory query construction (unit, no DB)", () => {
  describe("5.1/5.2: the actual guarantee -- query text/params, not just result rows", () => {
    // Tests 1-4 above (DB-backed) prove result rows come back the same way
    // under one seeded dataset -- a real but weaker claim than "the query
    // itself is unaffected." A regression that relies on SQL NULL
    // semantics instead of the TypeScript-level conditional in
    // retrieveRelevantMemory.ts (e.g. always appending a `(scope = $N)`
    // clause bound to null, rather than omitting the clause) would likely
    // still pass those tests -- `scope = NULL` is never true in SQL, so it
    // degrades to a no-op that preserves ordering on a small dataset. This
    // inspects the actual SQL string and params sent to client.query() via
    // a mocked withTenantTransaction, so it fails on that exact regression
    // even if every row-level test above happens not to notice it.
    it("9. omitting requestingPersonaDomain and passing null produce byte-identical SQL and params, with no domain-ranking clause present", async () => {
      vi.resetModules();
      const queryMock = vi.fn().mockResolvedValue({ rows: [] });
      vi.doMock("../../src/db/withTenantTransaction.js", () => ({
        withTenantTransaction: async (
          _tenantId: string,
          callback: (client: { query: typeof queryMock }) => unknown,
        ) => callback({ query: queryMock }),
      }));

      const { retrieveRelevantMemory: mockedRetrieve } = await import("../../src/elora/retrieveRelevantMemory.js");

      await mockedRetrieve({ tenantId: "t1", queryText: "hello world" });
      const omittedCall = queryMock.mock.calls[0];

      queryMock.mockClear();
      await mockedRetrieve({ tenantId: "t1", queryText: "hello world", requestingPersonaDomain: null });
      const nullCall = queryMock.mock.calls[0];

      // Not "produced the same rows" -- the actual SQL text and param
      // array are identical, byte-for-byte, between omitted and null.
      expect(omittedCall?.[0]).toBe(nullCall?.[0]);
      expect(omittedCall?.[1]).toEqual(nullCall?.[1]);

      // And the guarantee itself, stated directly: no ranking clause on
      // `scope` anywhere in that SQL, and the ORDER BY is exactly what it
      // was before 6H.
      expect(omittedCall?.[0]).not.toMatch(/scope\s*=/);
      expect(omittedCall?.[0]).toMatch(/ORDER BY created_at DESC/);

      // Contrast case: a real domain DOES change the query -- proves the
      // mock/assertions above are actually sensitive to this, not just
      // trivially true regardless of input.
      queryMock.mockClear();
      await mockedRetrieve({ tenantId: "t1", queryText: "hello world", requestingPersonaDomain: "finance" });
      const domainCall = queryMock.mock.calls[0];
      expect(domainCall?.[0]).toMatch(/COALESCE\(scope = \$\d+, false\) DESC, created_at DESC/);
      expect((domainCall?.[1] as unknown[])?.length).toBe(((nullCall?.[1] as unknown[])?.length ?? 0) + 1);

      vi.doUnmock("../../src/db/withTenantTransaction.js");
      vi.resetModules();
    });
  });
});

describe("Phase 6H: token budget and prompt caching (unit, no DB)", () => {
  describe("5.4: token budget hook", () => {
    it("7. buildPrompt() truncates a user message over the 100,000-char budget rather than sending it unbounded", async () => {
      const { buildPrompt } = await import("../../src/elora/llm/anthropicProvider.js");
      // 150,000 -- clear of the 100,000-char cap, not just clear of the
      // old 8,000-char one. 20,000 (the old fixture length) is now well
      // *under* the cap and would silently stop exercising truncation at
      // all after the cap was raised.
      const oversized = "x".repeat(150_000);

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

      expect(user.length).toBeLessThan(150_000);
      expect(user).toContain("truncated");
    });

    // PR #19 review finding: the original implementation bounded the fully
    // *assembled* user string, so a userMessageContent long enough to
    // exceed the budget on its own truncated the string before the fixed
    // control fields (task type, decided outcome, reason, final status,
    // closing instruction) were ever reached -- silently dropping the
    // decided authority outcome and the closing instruction from what the
    // model actually sees. Test 7 above didn't catch this: it only checked
    // that truncation happened and contained the word "truncated," not
    // that the fixed fields survived it.
    it("7c. a user message over the 100,000-char budget never drops the decided outcome or closing instruction -- only the raw message content is bounded, not the whole assembled prompt", async () => {
      const { buildPrompt } = await import("../../src/elora/llm/anthropicProvider.js");
      const oversized = "x".repeat(150_000);

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

      expect(user).toContain("Decided outcome: act_and_report");
      expect(user).toContain("Task type: planning");
      expect(user).toContain("Final status: READY_TO_ACT");
      expect(user).toContain("Write the in-character reply now, describing only the above.");
    });

    // Raising the cap from 8,000 to 100,000 chars is only a real fix if
    // messages that fit comfortably under the new cap actually pass
    // through whole -- this pins that down explicitly, not just inferred
    // from 7b's much smaller fixture never having been at risk either way.
    it("7d. a user message just under the 100,000-char budget passes through completely unbounded, not truncated", async () => {
      const { buildPrompt } = await import("../../src/elora/llm/anthropicProvider.js");
      const justUnderCap = "y".repeat(99_999);

      const { user } = buildPrompt({
        persona: ELORA_PERSONA,
        userMessageContent: justUnderCap,
        taskType: "planning",
        authorityOutcome: "act_and_report",
        reason: "test reason",
        finalWorkOrderStatus: "READY_TO_ACT",
        toolResult: null,
        retrievedMemorySnippets: [],
      });

      expect(user).not.toContain("truncated");
      expect(user).toContain(justUnderCap);
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
