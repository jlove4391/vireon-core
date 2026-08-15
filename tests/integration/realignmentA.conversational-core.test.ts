import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import type { EloraRoute } from "../../src/elora/types.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

/**
 * ADR 0008 Realignment A acceptance suite. §116's own bar for this phase:
 * "normal conversation, follow-up reference resolution, factual/direct
 * answers, and drafting should all work with zero WorkOrders created,
 * before delegation semantics or tool calling are touched at all" -- plus
 * the implementation prompt's extension of that bar to every EloraRoute an
 * ordinary (non-system-initiated) conversational turn can resolve to:
 * converse, direct_answer, clarify, delegate, durable_work,
 * consequential_action must all produce a real, honest response and never
 * create a WorkOrder. (setup_required/capability_missing/refuse routes are
 * already covered end-to-end by phase3/phase4's isSystemInitiated-aware
 * suites and parseIntent.test.ts's degraded-mode unit tests -- not
 * duplicated here.)
 *
 * These routes (other than the two explicit structural exceptions --
 * artifact creation and "have Nexora...") are only ever produced by a live
 * model. This environment has no real ANTHROPIC_API_KEY (confirmed empty in
 * .env), so degraded mode is what every other suite in this repo actually
 * exercises by default. This file is the one place that drives a
 * MODEL-sourced route through the real ingestion pipeline, using the same
 * mocked-Anthropic-transport pattern phase6f/pr4 already established
 * (mock generateResponse AND interpretIntent -- the pr4 suite's mocks only
 * implement generateResponse, which is precisely why that entire file runs
 * in degraded mode regardless of its own API-key setup).
 */

const mockState = vi.hoisted(() => ({
  nextIntentOutput: null as Record<string, unknown> | null,
  responseCalls: [] as Array<{ context: { userMessageContent: string; taskType: string; reason: string } }>,
  responseText: "A helpful, in-character reply.",
}));

vi.mock("../../src/elora/llm/anthropicProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/elora/llm/anthropicProvider.js")>();
  class MockAnthropicProvider {
    readonly providerId = "anthropic";
    readonly modelId = "test-mock-model";
    constructor(_apiKey: string) {}
    async generateResponse(context: { userMessageContent: string; taskType: string; reason: string }): Promise<string> {
      mockState.responseCalls.push({ context });
      return mockState.responseText;
    }
    async interpretIntent(): Promise<{ output: unknown; usage: { inputTokens: number; outputTokens: number } }> {
      if (!mockState.nextIntentOutput) {
        throw new Error("realignmentA test: mockState.nextIntentOutput was not set before this call");
      }
      return { output: mockState.nextIntentOutput, usage: { inputTokens: 10, outputTokens: 10 } };
    }
  }
  return { ...actual, AnthropicProvider: MockAnthropicProvider };
});

function intentOutput(route: EloraRoute, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route,
    interpretedIntent: "test-provided interpretation",
    confidence: 0.85,
    taskDomain: null,
    requestedCapabilities: [],
    proposedDelegationTarget: null,
    requiresDurableWork: false,
    proposedToolNeeds: [],
    externalSideEffect: false,
    requiresClarification: false,
    clarifyingQuestion: null,
    ...overrides,
  };
}

describe("ADR 0008 Realignment A: conversational-core acceptance", () => {
  let ctx: SeededContext;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockState.nextIntentOutput = null;
    mockState.responseCalls = [];
    mockState.responseText = "A helpful, in-character reply.";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("1. ordinary conversation: converse route never creates a WorkOrder and produces a real, substantiated response", async () => {
    mockState.nextIntentOutput = intentOutput("converse");

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "What do you think about switching to Postgres for the new service?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("converse");
    expect(result.workOrderId).toBeNull();
    expect(result.authorityOutcome).toBeNull();
    expect(result.responseType).toBe("direct_answer");
    expect(result.responseText).toBe("A helpful, in-character reply.");
    expect(result.cognitiveRunId).not.toBeNull();
    expect(result.modelInvocationId).not.toBeNull();
  });

  it("2. follow-up reference resolution: a pronoun-only second turn gets the first turn's content threaded into the model context, no WorkOrder", async () => {
    mockState.nextIntentOutput = intentOutput("converse");
    const first = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "I'm thinking about migrating the reporting service to Postgres.",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });
    expect(first.workOrderId).toBeNull();

    mockState.nextIntentOutput = intentOutput("converse");
    mockState.responseCalls = [];
    const second = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: first.threadId,
      actorId: ctx.actorId,
      content: "What would be difficult about it?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(second.workOrderId).toBeNull();
    expect(second.threadId).toBe(first.threadId);
    // ADR §6: assembleThreadContext.ts pulled the first turn's content into
    // the second turn's synthesis call -- the model never sees "What would
    // be difficult about it?" in isolation.
    expect(mockState.responseCalls).toHaveLength(1);
    expect(mockState.responseCalls[0]!.context.userMessageContent).toContain(
      "migrating the reporting service to Postgres",
    );
    expect(mockState.responseCalls[0]!.context.userMessageContent).toContain("What would be difficult about it?");
  });

  it("3. thread-context-dependent answer: a second turn can reference ELORA's own prior reply (persistAssistantReply round-trip)", async () => {
    mockState.nextIntentOutput = intentOutput("converse");
    mockState.responseText = "I'd recommend Postgres for its strong JSONB and full-text search support.";
    const first = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Postgres or MySQL for the new service?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });
    expect(first.workOrderId).toBeNull();

    mockState.nextIntentOutput = intentOutput("converse");
    mockState.responseText = "A helpful, in-character reply.";
    mockState.responseCalls = [];
    const second = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: first.threadId,
      actorId: ctx.actorId,
      content: "Why did you recommend that?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(second.workOrderId).toBeNull();
    // The prior turn's own reply (persisted via persistAssistantReply) is
    // present in the second turn's assembled thread context -- proving the
    // round-trip, not just the user-message half of it.
    expect(mockState.responseCalls[0]!.context.userMessageContent).toContain("JSONB and full-text search");
  });

  it("4. clarify: an ambiguous request gets a clarifying-question response, never a WorkOrder", async () => {
    mockState.nextIntentOutput = intentOutput("clarify", {
      requiresClarification: true,
      clarifyingQuestion: "Which project did you mean?",
    });

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Can you update the doc?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("clarify");
    expect(result.workOrderId).toBeNull();
    expect(result.responseType).toBe("clarification_required");
  });

  it("5. delegate (model-inferred, ordinary phrasing): honest acknowledgment, never a WorkOrder", async () => {
    mockState.nextIntentOutput = intentOutput("delegate", {
      taskDomain: "engineering",
      proposedDelegationTarget: "nexora",
      requiresDurableWork: true,
    });

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Someone should build an audit script for the auth code.",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("delegate");
    expect(result.workOrderId).toBeNull();
    expect(result.responseType).toBe("direct_answer");
    expect(result.cognitiveRunId).not.toBeNull();
  });

  it("6. durable_work on an ordinary (non-system-initiated) user turn: honest acknowledgment, never a WorkOrder -- the core ADR 0008 semantic change", async () => {
    mockState.nextIntentOutput = intentOutput("durable_work", { requiresDurableWork: true });

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Plan out the Q3 launch across engineering, marketing, and support.",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
      // Deliberately omitted: isSystemInitiated. The same content, the same
      // model-proposed durable_work route -- but because this is an
      // ordinary live-user turn, §4's WorkOrder gate stays closed. Only a
      // fireDueTrigger()-originated call (isSystemInitiated: true) reaches
      // the WorkOrder pipeline for this route -- see
      // phase4.receipts-authority.test.ts's act_and_report test for that
      // branch.
    });

    expect(result.intent.route).toBe("durable_work");
    expect(result.workOrderId).toBeNull();
    expect(result.authorityOutcome).toBeNull();
    expect(result.finalWorkOrderStatus).toBeNull();
    expect(result.responseType).toBe("direct_answer");
    expect(result.cognitiveRunId).not.toBeNull();
  });

  it("7. consequential_action on an ordinary user turn: honest acknowledgment, never a WorkOrder or ToolInvocation", async () => {
    mockState.nextIntentOutput = intentOutput("consequential_action", { externalSideEffect: true });

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Send an email to the team about the new schedule.",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("consequential_action");
    expect(result.workOrderId).toBeNull();
    expect(result.toolInvocationId).toBeNull();
    expect(result.actionReceiptId).toBeNull();
    expect(result.responseType).toBe("direct_answer");
  });

  it("8. direct_answer: a factual question never creates a WorkOrder", async () => {
    mockState.nextIntentOutput = intentOutput("direct_answer");

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "How many days are in a leap year?",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("direct_answer");
    expect(result.workOrderId).toBeNull();
    expect(result.responseType).toBe("direct_answer");
  });

  it("9. drafting: composing text on request never creates a WorkOrder", async () => {
    mockState.nextIntentOutput = intentOutput("converse");

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.actorId,
      content: "Draft a two-sentence summary of this week's progress for the team.",
      sourceSurface: "realignmentA-test",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.route).toBe("converse");
    expect(result.workOrderId).toBeNull();
    expect(result.responseType).toBe("direct_answer");
  });
});
