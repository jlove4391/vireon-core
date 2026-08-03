import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ELORA_PERSONA } from "@vireon/persona-config";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createCognitiveRun } from "../../src/cognition/createCognitiveRun.js";
import { CognitiveRunCompletionUnsubstantiatedError } from "../../src/cognition/errors.js";
import { runInformationalCognitiveRun } from "../../src/cognition/runInformationalCognitiveRun.js";
import { transitionCognitiveRun } from "../../src/cognition/transitionCognitiveRun.js";
import { ingestUserMessage } from "../../src/elora/ingestUserMessage.js";
import { buildPrompt } from "../../src/elora/llm/anthropicProvider.js";
import type { LlmResponseContext } from "../../src/elora/llm/types.js";
import { seedBaseContext } from "../../test-utils/dbTestContext.js";

// Hoisted mutable mock state -- vi.mock factories are hoisted above imports,
// so state they close over must be created via vi.hoisted(). Mocking the
// provider *classes* (not the raw SDK transport, unlike pr2/pr3's tests)
// is the right seam here: this suite proves the cognitive-coordinator
// contract (state transitions, completion substantiation, response
// linkage), not provider-internal prompt/JSON-parsing behavior -- that's
// already covered by pr2.structured-model-operations.test.ts and
// pr3.openai-provider.test.ts. selectLlmProvider() (providerSelection.ts)
// imports AnthropicProvider/OpenAIProvider directly from these two modules,
// so mocking them here is picked up transitively by the real, unmodified
// coordinator and providerSelection.ts code.
type ProviderScenario = "valid" | "throws";

const providerMockState = vi.hoisted(() => ({
  anthropic: {
    scenario: "valid" as ProviderScenario,
    constructedCount: 0,
    calls: [] as unknown[],
    responseText: "A genuine, memory-grounded reply from the mocked Anthropic provider.",
  },
  openai: {
    scenario: "valid" as ProviderScenario,
    constructedCount: 0,
    calls: [] as unknown[],
    responseText: "A genuine, memory-grounded reply from the mocked OpenAI provider.",
  },
}));

vi.mock("../../src/elora/llm/anthropicProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/elora/llm/anthropicProvider.js")>();
  class MockAnthropicProvider {
    readonly providerId = "anthropic";
    readonly modelId = "mock-anthropic-model";
    constructor(_apiKey: string) {
      providerMockState.anthropic.constructedCount++;
    }
    async generateResponse(context: unknown, _timeoutMs: number): Promise<string> {
      providerMockState.anthropic.calls.push(context);
      if (providerMockState.anthropic.scenario === "throws") {
        throw new Error("simulated Anthropic provider failure");
      }
      return providerMockState.anthropic.responseText;
    }
  }
  return { ...actual, AnthropicProvider: MockAnthropicProvider };
});

vi.mock("../../src/elora/llm/openaiProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/elora/llm/openaiProvider.js")>();
  class MockOpenAIProvider {
    readonly providerId = "openai";
    readonly modelId = "mock-openai-model";
    constructor(_apiKey: string) {
      providerMockState.openai.constructedCount++;
    }
    async generateResponse(context: unknown, _timeoutMs: number): Promise<string> {
      providerMockState.openai.calls.push(context);
      if (providerMockState.openai.scenario === "throws") {
        throw new Error("simulated OpenAI provider failure");
      }
      return providerMockState.openai.responseText;
    }
  }
  return { ...actual, OpenAIProvider: MockOpenAIProvider };
});

const ABSOLUTE_FALLBACK_TEXT = "I need more information to proceed with this request.";

async function seedMemoryRecord(tenantId: string, content: string): Promise<string> {
  return withTenantTransaction(tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      "INSERT INTO memory_records (id, tenant_id, content, record_type, scope) VALUES ($1, $2, $3, $4, $5)",
      [id, tenantId, content, "note", "project"],
    );
    return id;
  });
}

async function fetchCognitiveRun(tenantId: string, cognitiveRunId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM cognitive_runs WHERE id = $1", [cognitiveRunId]);
    return result.rows[0];
  });
}

async function fetchTransitionPath(tenantId: string, cognitiveRunId: string): Promise<string[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT to_state FROM cognitive_run_transitions WHERE tenant_id = $1 AND cognitive_run_id = $2 ORDER BY created_at ASC",
      [tenantId, cognitiveRunId],
    );
    return result.rows.map((row) => row.to_state as string);
  });
}

async function fetchModelInvocation(tenantId: string, id: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM model_invocations WHERE id = $1", [id]);
    return result.rows[0];
  });
}

async function countModelInvocations(tenantId: string, cognitiveRunId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id = $1 AND cognitive_run_id = $2",
      [tenantId, cognitiveRunId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

async function countCognitiveRuns(tenantId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT count(*)::int AS n FROM cognitive_runs WHERE tenant_id = $1", [tenantId]);
    return (result.rows[0] as { n: number }).n;
  });
}

describe("PR 4: cognitive coordinator acceptance", () => {
  let originalEnv: { modelProvider?: string; anthropicKey?: string; openaiKey?: string };

  beforeAll(async () => {
    await migrate();
    originalEnv = {
      modelProvider: process.env.MODEL_PROVIDER,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      openaiKey: process.env.OPENAI_API_KEY,
    };
  });

  afterAll(async () => {
    if (originalEnv.modelProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = originalEnv.modelProvider;
    if (originalEnv.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv.anthropicKey;
    if (originalEnv.openaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv.openaiKey;
    await pool.end();
  });

  beforeEach(() => {
    process.env.MODEL_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    providerMockState.anthropic.scenario = "valid";
    providerMockState.anthropic.constructedCount = 0;
    providerMockState.anthropic.calls = [];
    providerMockState.openai.scenario = "valid";
    providerMockState.openai.constructedCount = 0;
    providerMockState.openai.calls = [];
  });

  afterEach(() => {
    // Belt-and-suspenders: some tests intentionally mutate MODEL_PROVIDER
    // mid-test (13.2, 13.8) -- the next test's beforeEach always resets it,
    // but restoring here too means a test that throws before its own
    // cleanup still leaves the suite's env in a known state.
    process.env.MODEL_PROVIDER = "anthropic";
  });

  it("13.1: a successful informational request produces a durable, substantiated COMPLETED cognitive run (also proves the §7 direct_answer mapping)", async () => {
    const ctx = await seedBaseContext();
    const memoryContent = "zephyr project notes: " + "the migration timeline shifted twice. ".repeat(8);
    await seedMemoryRecord(ctx.tenantId, memoryContent);

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      actorId: ctx.actorId,
      content: "Can you tell me about the zephyr project status?",
      sourceSurface: "pr4-test-harness",
      sourceCorrelationId: randomUUID(),
    });

    expect(result.intent.intent_type).toBe("informational");
    expect(result.workOrderId).toBeNull();
    expect(result.authorityDecisionId).toBeNull();
    expect(result.finalWorkOrderStatus).toBeNull();
    expect(result.responseType).toBe("direct_answer");
    expect(result.cognitiveRunId).not.toBeNull();
    expect(result.modelInvocationId).not.toBeNull();
    expect(result.responseText).toBe(providerMockState.anthropic.responseText);

    const run = await fetchCognitiveRun(ctx.tenantId, result.cognitiveRunId!);
    expect(run.objective_kind).toBe("informational_response");
    expect(run.status).toBe("COMPLETED");

    const transitions = await fetchTransitionPath(ctx.tenantId, result.cognitiveRunId!);
    expect(transitions).toEqual(["PENDING", "RUNNING", "COMPLETED"]);

    const invocation = await fetchModelInvocation(ctx.tenantId, result.modelInvocationId!);
    expect(invocation.operation_kind).toBe("response_synthesis");
    expect(invocation.cognitive_run_id).toBe(result.cognitiveRunId);
    expect(invocation.status).toBe("SUCCEEDED");
    expect(invocation.provider).toBe("anthropic");

    const calls = providerMockState.anthropic.calls as LlmResponseContext[];
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1]!;
    expect(lastCall.retrievedMemorySnippets.length).toBeGreaterThan(0);
    for (const snippet of lastCall.retrievedMemorySnippets) {
      expect(snippet.length).toBeLessThanOrEqual(200);
    }
    expect(lastCall.retrievedMemorySnippets[0]).toBe(memoryContent.slice(0, 200));
  });

  it("13.2: provider selection uses only the configured provider, never the other one", async () => {
    const anthropicCtx = await seedBaseContext();
    process.env.MODEL_PROVIDER = "anthropic";
    const anthropicResult = await ingestUserMessage({
      tenantId: anthropicCtx.tenantId,
      workspaceId: anthropicCtx.workspaceId,
      projectId: anthropicCtx.projectId,
      threadId: anthropicCtx.threadId,
      actorId: anthropicCtx.actorId,
      content: "What can you tell me about our onboarding checklist?",
    });
    expect(providerMockState.anthropic.constructedCount).toBeGreaterThan(0);
    expect(providerMockState.openai.constructedCount).toBe(0);
    const anthropicInvocation = await fetchModelInvocation(anthropicCtx.tenantId, anthropicResult.modelInvocationId!);
    expect(anthropicInvocation.provider).toBe("anthropic");

    providerMockState.anthropic.constructedCount = 0;
    providerMockState.openai.constructedCount = 0;

    const openaiCtx = await seedBaseContext();
    process.env.MODEL_PROVIDER = "openai";
    const openaiResult = await ingestUserMessage({
      tenantId: openaiCtx.tenantId,
      workspaceId: openaiCtx.workspaceId,
      projectId: openaiCtx.projectId,
      threadId: openaiCtx.threadId,
      actorId: openaiCtx.actorId,
      content: "What can you tell me about our onboarding checklist?",
    });
    expect(providerMockState.openai.constructedCount).toBeGreaterThan(0);
    expect(providerMockState.anthropic.constructedCount).toBe(0);
    const openaiInvocation = await fetchModelInvocation(openaiCtx.tenantId, openaiResult.modelInvocationId!);
    expect(openaiInvocation.provider).toBe("openai");
  });

  it("13.3: provider failure after invocation creation falls back to a deterministic, substantiated COMPLETED answer", async () => {
    const ctx = await seedBaseContext();
    providerMockState.anthropic.scenario = "throws";

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      actorId: ctx.actorId,
      content: "What's the latest on the customer feedback review?",
    });

    expect(result.responseType).toBe("direct_answer");
    expect(result.cognitiveRunId).not.toBeNull();
    expect(result.modelInvocationId).not.toBeNull();
    expect(result.responseText).not.toBe(ABSOLUTE_FALLBACK_TEXT);
    expect(result.responseText.length).toBeGreaterThan(0);

    const run = await fetchCognitiveRun(ctx.tenantId, result.cognitiveRunId!);
    expect(run.status).toBe("COMPLETED");

    const invocation = await fetchModelInvocation(ctx.tenantId, result.modelInvocationId!);
    expect(["FAILED", "TIMED_OUT"]).toContain(invocation.status);

    const completedTransition = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        "SELECT metadata FROM cognitive_run_transitions WHERE tenant_id = $1 AND cognitive_run_id = $2 AND to_state = 'COMPLETED'",
        [ctx.tenantId, result.cognitiveRunId],
      );
      return r.rows[0];
    });
    expect(completedTransition.metadata.responseSource).toBe("DETERMINISTIC_FALLBACK");
    expect(completedTransition.metadata.modelInvocationId).toBe(result.modelInvocationId);
  });

  it("13.4: a persistence failure before invocation creation does not substantiate COMPLETED", async () => {
    const ctx = await seedBaseContext();
    const { cognitiveRun } = await createCognitiveRun({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      initiatedByActorId: ctx.actorId,
      objectiveKind: "informational_response",
    });
    expect(cognitiveRun.status).toBe("PENDING");

    // Deliberately collide with the exact invocation key the coordinator
    // will compute for this run (tenantId:cognitiveRunId:response_synthesis:1),
    // forcing executeModelOperation.ts's own STARTED-row insert to violate
    // the (tenant_id, invocation_key, attempt_number) unique constraint --
    // a genuine PERSISTENCE_FAILURE with no invocation ever created for
    // *this* attempt.
    const collidingInvocationKey = `${ctx.tenantId}:${cognitiveRun.id}:response_synthesis:1`;
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO model_invocations
           (tenant_id, cognitive_run_id, operation_kind, provider, model, status, invocation_key, attempt_number)
         VALUES ($1, $2, 'response_synthesis', 'preexisting', 'preexisting-model', 'STARTED', $3, 1)`,
        [ctx.tenantId, cognitiveRun.id, collidingInvocationKey],
      );
    });

    const result = await runInformationalCognitiveRun({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      initiatedByActorId: ctx.actorId,
      userMessageContent: "Anything on the vendor renewal timeline?",
      retrievedMemory: [],
    });

    expect(result.finalStatus).toBe("FAILED");
    expect(result.modelInvocationId).toBeNull();
    expect(result.responseText).toBe(ABSOLUTE_FALLBACK_TEXT);

    const run = await fetchCognitiveRun(ctx.tenantId, cognitiveRun.id);
    expect(run.status).toBe("FAILED");

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT status FROM model_invocations WHERE tenant_id = $1 AND cognitive_run_id = $2", [
        ctx.tenantId,
        cognitiveRun.id,
      ]);
      return r.rows;
    });
    // Only the pre-planted STARTED row exists -- the coordinator's own
    // attempt never got far enough to create a real row of its own.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("STARTED");
  });

  it("13.5: content-policy denial blocks the provider call before invocation creation", async () => {
    const ctx = await seedBaseContext();
    const sensitiveContent = `Can you look at this for me: Bearer ${"A".repeat(30)}`;

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      actorId: ctx.actorId,
      content: sensitiveContent,
    });

    expect(result.intent.intent_type).toBe("informational");
    expect(result.responseType).toBe("clarification_required");
    expect(result.responseText).toBe(ABSOLUTE_FALLBACK_TEXT);
    expect(result.modelInvocationId).toBeNull();
    expect(result.cognitiveRunId).not.toBeNull();

    // The provider was constructed (selection happens before the
    // content-policy check), but generateResponse -- the actual outbound
    // call -- was never invoked.
    expect(providerMockState.anthropic.constructedCount).toBeGreaterThan(0);
    expect(providerMockState.anthropic.calls).toHaveLength(0);

    const run = await fetchCognitiveRun(ctx.tenantId, result.cognitiveRunId!);
    expect(run.status).toBe("FAILED");

    const invocationCount = await countModelInvocations(ctx.tenantId, result.cognitiveRunId!);
    expect(invocationCount).toBe(0);
  });

  it("13.6: the completion substantiation gate lives inside transitionCognitiveRun.ts and blocks COMPLETED without evidence", async () => {
    const ctx = await seedBaseContext();
    const { cognitiveRun } = await createCognitiveRun({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      initiatedByActorId: ctx.actorId,
      objectiveKind: "pr4_gate_fixture",
    });

    await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "RUNNING",
      actorId: ctx.actorId,
      reason: "begin",
    });

    await expect(
      transitionCognitiveRun({
        tenantId: ctx.tenantId,
        cognitiveRunId: cognitiveRun.id,
        nextStatus: "COMPLETED",
        actorId: ctx.actorId,
        reason: "attempt without evidence",
      }),
    ).rejects.toBeInstanceOf(CognitiveRunCompletionUnsubstantiatedError);

    const midway = await fetchCognitiveRun(ctx.tenantId, cognitiveRun.id);
    expect(midway.status).toBe("RUNNING");
    expect(midway.ended_at).toBeNull();

    const completedTransitionCount = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        "SELECT count(*)::int AS n FROM cognitive_run_transitions WHERE tenant_id = $1 AND cognitive_run_id = $2 AND to_state = 'COMPLETED'",
        [ctx.tenantId, cognitiveRun.id],
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(completedTransitionCount).toBe(0);

    // Attach a real terminal invocation and prove completion now succeeds.
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO model_invocations
           (tenant_id, cognitive_run_id, operation_kind, provider, model, status, invocation_key, completed_at, duration_ms)
         VALUES ($1, $2, 'response_synthesis', 'fake', 'fake-model', 'SUCCEEDED', $3, now(), 5)`,
        [ctx.tenantId, cognitiveRun.id, `pr4-gate-evidence:${cognitiveRun.id}`],
      );
    });

    const completed = await transitionCognitiveRun({
      tenantId: ctx.tenantId,
      cognitiveRunId: cognitiveRun.id,
      nextStatus: "COMPLETED",
      actorId: ctx.actorId,
      reason: "now substantiated",
    });
    expect(completed.cognitiveRun.status).toBe("COMPLETED");
  });

  it("13.8 & 13.10 (FAILED branch): an unexpected coordinator-boundary failure (provider misconfiguration) transitions RUNNING -> FAILED and never leaks a raw exception", async () => {
    const ctx = await seedBaseContext();
    // readProviderKindFromEnv() throws a plain Error here -- this happens
    // entirely outside executeModelOperation.ts's own try/catch boundary
    // (no operation has even started yet), so it exercises the
    // coordinator's own outer catch, not the operation executor's typed
    // { ok: false } failure path already covered by 13.3/13.4/13.5.
    delete process.env.MODEL_PROVIDER;

    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      actorId: ctx.actorId,
      content: "Any update on the office relocation plans?",
    });

    expect(result.intent.intent_type).toBe("informational");
    expect(result.responseType).toBe("clarification_required");
    expect(result.responseText).toBe(ABSOLUTE_FALLBACK_TEXT);
    expect(result.modelInvocationId).toBeNull();
    expect(result.cognitiveRunId).not.toBeNull();
    expect(providerMockState.anthropic.constructedCount).toBe(0);
    expect(providerMockState.openai.constructedCount).toBe(0);

    const run = await fetchCognitiveRun(ctx.tenantId, result.cognitiveRunId!);
    expect(run.status).toBe("FAILED");
    expect(run.ended_at).not.toBeNull();
  });

  it("13.9: the work_order_candidate path is unchanged -- no cognitive run is created for it", async () => {
    const ctx = await seedBaseContext();
    const result = await ingestUserMessage({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      actorId: ctx.actorId,
      content: "Help me create a project plan for the Q3 rollout",
    });

    expect(result.intent.intent_type).toBe("work_order_candidate");
    expect(result.workOrderId).not.toBeNull();
    expect(result.cognitiveRunId).toBeNull();
    expect(result.modelInvocationId).toBeNull();

    expect(await countCognitiveRuns(ctx.tenantId)).toBe(0);
  });

  describe("13.11: prompt correctness for optional authorityOutcome/finalWorkOrderStatus", () => {
    it("omits both lines entirely when absent -- never interpolates \"undefined\"", () => {
      const context: LlmResponseContext = {
        persona: ELORA_PERSONA,
        userMessageContent: "informational probe",
        taskType: "informational",
        reason: "no WorkOrder or authority decision applies",
        retrievedMemorySnippets: [],
      };
      const { user } = buildPrompt(context);
      expect(user).not.toContain("undefined");
      expect(user).not.toContain("Decided outcome:");
      expect(user).not.toContain("Final status:");
      expect(user).toContain('Original request: "informational probe"');
      expect(user).toContain("Reason: no WorkOrder or authority decision applies");
    });

    it("keeps the existing WorkOrder-path prompt content byte-for-byte unchanged when both fields are present", () => {
      const context: LlmResponseContext = {
        persona: ELORA_PERSONA,
        userMessageContent: "help me plan the rollout",
        taskType: "planning",
        authorityOutcome: "act",
        reason: "within current authority",
        finalWorkOrderStatus: "READY_TO_ACT",
        toolResult: null,
        retrievedMemorySnippets: ["prior note"],
      };
      const { user } = buildPrompt(context);
      expect(user).toBe(
        [
          'Original request: "help me plan the rollout"',
          "Task type: planning",
          "Decided outcome: act",
          "Reason: within current authority",
          "Final status: READY_TO_ACT",
          "Relevant prior context you may reference: prior note",
          "Write the in-character reply now, describing only the above.",
        ].join("\n"),
      );
    });
  });
});
