import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { AnthropicProvider } from "../../src/elora/llm/anthropicProvider.js";
import { FakeLlmProvider } from "../../src/elora/llm/fakeProvider.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import type { ConformanceProviders } from "../shared/providerConformanceSuite.js";
import { runProviderConformanceSuite } from "../shared/providerConformanceSuite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hoisted mutable mock state -- vi.mock factories are hoisted above
// imports, so state they close over must be created via vi.hoisted(). This
// mocks @anthropic-ai/sdk itself (the transport), not the whole
// AnthropicProvider class -- unlike phase6f.llm-integration.test.ts's
// module-level mock, this lets the REAL AnthropicProvider code
// (prompt-building, JSON parsing, usage-field mapping) run end-to-end
// against a controlled fake transport, which is what actually proves that
// code, not just the executor around it.
type AnthropicMockScenario = "valid" | "malformed" | "throws" | "hangs" | "rerank-unknown" | "rerank-duplicate" | "smuggle";
const anthropicMockState = vi.hoisted(() => ({ scenario: "valid" as AnthropicMockScenario }));

function validResponseTextFor(params: { system?: Array<{ text?: string }>; messages?: Array<{ content?: unknown }> }): string {
  const systemText = params.system?.[0]?.text ?? "";
  if (!systemText.includes("Respond with ONLY a single valid JSON object")) {
    // generateResponse's own conversational prompt -- not one of the five structured operations.
    return "A real, sane in-character reply.";
  }
  if (systemText.includes("structured intent classifier")) {
    return JSON.stringify({ intentType: "informational", taskType: "unknown", confidence: 0.7, summary: "mocked summary" });
  }
  if (systemText.includes("planning assistant")) {
    return JSON.stringify({ steps: [{ description: "mocked step" }] });
  }
  if (systemText.includes("critical reviewer")) {
    return JSON.stringify({ verdict: "approve", issues: [], summary: "mocked critique" });
  }
  if (systemText.includes("extract specific fields")) {
    return JSON.stringify({ values: { Name: "Alice", Age: 30 } });
  }
  if (systemText.includes("rerank a list of candidates")) {
    return JSON.stringify({
      rankedCandidates: [
        { candidateId: "a", rank: 1 },
        { candidateId: "b", rank: 2 },
      ],
    });
  }
  return "{}";
}

const MOCK_USAGE = { input_tokens: 111, output_tokens: 22, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 };

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    constructor(_options: unknown) {}
    messages = {
      create: async (params: { system?: Array<{ text?: string }>; messages?: Array<{ content?: unknown }> }) => {
        const scenario = anthropicMockState.scenario;
        if (scenario === "throws") {
          throw new Error("simulated Anthropic provider failure");
        }
        if (scenario === "hangs") {
          return new Promise(() => {
            // Never resolves -- exercises executeModelOperation's own race-timeout.
          });
        }

        const textByScenario: Partial<Record<AnthropicMockScenario, string>> = {
          malformed: JSON.stringify({ totally: "wrong shape" }),
          smuggle: JSON.stringify({
            intentType: "informational",
            taskType: "unknown",
            confidence: 0.5,
            summary: "ok",
            extraHackerField: "should not survive validation",
          }),
          "rerank-unknown": JSON.stringify({ rankedCandidates: [{ candidateId: "not-real", rank: 1 }] }),
          "rerank-duplicate": JSON.stringify({
            rankedCandidates: [
              { candidateId: "a", rank: 1 },
              { candidateId: "a", rank: 2 },
            ],
          }),
        };

        const text = textByScenario[scenario] ?? validResponseTextFor(params);
        return { content: [{ type: "text", text }], usage: MOCK_USAGE };
      },
    };
  }
  return { default: MockAnthropic };
});

// Constructed once at module-evaluation time (plain class instantiation,
// no async work, no DB access) so runProviderConformanceSuite() below can
// call describe()/it() with them directly -- vitest requires all test
// registration to happen synchronously during collection, not from inside
// an it()/beforeAll() callback. Each provider only needs a lazily-evaluated
// SeededContext getter (see providerConformanceSuite.ts), not the context
// itself, at registration time.
const fakeProviders: ConformanceProviders = {
  valid: new FakeLlmProvider(),
  malformedOutput: new FakeLlmProvider({
    interpretIntent: async () => ({ output: { totally: "wrong shape" }, usage: {} }),
  }),
  throwsError: new FakeLlmProvider({
    interpretIntent: async () => {
      throw new Error("simulated Fake provider failure");
    },
  }),
  hangsForTimeout: new FakeLlmProvider({
    interpretIntent: () => new Promise(() => undefined),
  }),
  rerankUnknownId: new FakeLlmProvider({
    rerank: async () => ({ output: { rankedCandidates: [{ candidateId: "not-real", rank: 1 }] }, usage: {} }),
  }),
  rerankDuplicateId: new FakeLlmProvider({
    rerank: async () => ({
      output: {
        rankedCandidates: [
          { candidateId: "a", rank: 1 },
          { candidateId: "a", rank: 2 },
        ],
      },
      usage: {},
    }),
  }),
  smuggledFields: new FakeLlmProvider({
    interpretIntent: async () => ({
      output: {
        intentType: "informational",
        taskType: "unknown",
        confidence: 0.5,
        summary: "ok",
        extraHackerField: "should not survive validation",
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  }),
};

const anthropicReal = new AnthropicProvider("test-anthropic-key");
const withScenario =
  <A extends unknown[], R>(scenario: AnthropicMockScenario, fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> => {
    anthropicMockState.scenario = scenario;
    return fn(...args);
  };
const scenarioProvider = (scenario: AnthropicMockScenario) => ({
  providerId: anthropicReal.providerId,
  modelId: anthropicReal.modelId,
  generateResponse: withScenario(scenario, anthropicReal.generateResponse.bind(anthropicReal)),
  interpretIntent: withScenario(scenario, anthropicReal.interpretIntent.bind(anthropicReal)),
  plan: withScenario(scenario, anthropicReal.plan.bind(anthropicReal)),
  critique: withScenario(scenario, anthropicReal.critique.bind(anthropicReal)),
  extract: withScenario(scenario, anthropicReal.extract.bind(anthropicReal)),
  rerank: withScenario(scenario, anthropicReal.rerank.bind(anthropicReal)),
});

const anthropicProviders: ConformanceProviders = {
  valid: scenarioProvider("valid"),
  malformedOutput: scenarioProvider("malformed"),
  throwsError: scenarioProvider("throws"),
  hangsForTimeout: scenarioProvider("hangs"),
  rerankUnknownId: scenarioProvider("rerank-unknown"),
  rerankDuplicateId: scenarioProvider("rerank-duplicate"),
  smuggledFields: scenarioProvider("smuggle"),
};

describe("PR 2: structured model operation abstraction acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  // Registered directly in this describe()'s synchronous body -- both
  // conformance runs (Fake and mocked-transport-Anthropic) are real,
  // separate describe() blocks with their own it()s, not deferred behind
  // another it().
  runProviderConformanceSuite("FakeLlmProvider", () => ctx, fakeProviders);
  runProviderConformanceSuite("AnthropicProvider (mocked transport)", () => ctx, anthropicProviders);

  it("no file under src/elora/llm/ references anything from the authority/tool-execution/work-order-transition surface", () => {
    const llmDir = path.resolve(__dirname, "../../src/elora/llm");
    const forbidden = [
      "classifyAuthority",
      "resolveAuthorityWithHierarchy",
      "assertValidWorkOrderTransition",
      "transitionWorkOrder",
      "dispatchTool",
      "invokeRegisteredTool",
      "tools/gateway",
      "ingestUserMessage",
    ];

    function collectTsFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectTsFiles(fullPath);
        return entry.name.endsWith(".ts") ? [fullPath] : [];
      });
    }

    // Strips comments before checking -- anthropicProvider.ts's own
    // pre-existing (Phase 6H) generateResponse doc comment explains a
    // caching decision by *mentioning* dispatchTool.ts in prose ("tool
    // selection is fully deterministic via dispatchTool.ts"), which is not
    // an actual import or call. This test's job is to catch a real
    // functional reference to the authority/tool-execution surface, not to
    // penalize a comment that happens to name one of those files.
    function stripComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }

    const files = collectTsFiles(llmDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = stripComments(readFileSync(file, "utf8"));
      for (const term of forbidden) {
        expect(content.includes(term), `${path.relative(llmDir, file)} must not reference "${term}"`).toBe(false);
      }
    }
  });

  describe("model_invocations evidence", () => {
    it("writes a STARTED row that reaches SUCCEEDED with completion-consistent fields", async () => {
      const result = await runIntentInterpretation(
        { content: "evidence probe" },
        { tenantId: ctx.tenantId, provider: new FakeLlmProvider(), invocationKey: `pr2-evidence:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query("SELECT * FROM model_invocations WHERE id = $1", [result.invocationId]);
        return r.rows[0];
      });

      expect(row.status).toBe("SUCCEEDED");
      expect(row.tenant_id).toBe(ctx.tenantId);
      expect(row.operation_kind).toBe("intent_interpretation");
      expect(row.completed_at).not.toBeNull();
      expect(row.duration_ms).not.toBeNull();
      expect(row.request_fingerprint).not.toBeNull();
      expect(row.response_fingerprint).not.toBeNull();
      // Trace/evidence privacy default (PR 0's own convention, reused
      // here): fingerprints are hashes, never raw content.
      expect(row.request_fingerprint).not.toContain("evidence probe");
    });

    it("attempt_number lets a genuine retry after a failure get its own durable row, not an insert-or-fetch collapse", async () => {
      const invocationKey = `pr2-retry:${randomUUID()}`;
      const failing = new FakeLlmProvider({
        interpretIntent: async () => {
          throw new Error("simulated transient failure");
        },
      });

      const first = await runIntentInterpretation(
        { content: "retry probe" },
        { tenantId: ctx.tenantId, provider: failing, invocationKey, attemptNumber: 1 },
      );
      expect(first.ok).toBe(false);

      const second = await runIntentInterpretation(
        { content: "retry probe" },
        { tenantId: ctx.tenantId, provider: new FakeLlmProvider(), invocationKey, attemptNumber: 2 },
      );
      expect(second.ok).toBe(true);

      const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          "SELECT attempt_number, status FROM model_invocations WHERE tenant_id = $1 AND invocation_key = $2 ORDER BY attempt_number ASC",
          [ctx.tenantId, invocationKey],
        );
        return r.rows;
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ attempt_number: 1, status: "FAILED" });
      expect(rows[1]).toMatchObject({ attempt_number: 2, status: "SUCCEEDED" });
    });

    it("enforces row-level security on model_invocations", async () => {
      const result = await runIntentInterpretation(
        { content: "rls probe" },
        { tenantId: ctx.tenantId, provider: new FakeLlmProvider(), invocationKey: `pr2-rls:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const unset = await client.query("SELECT id FROM model_invocations WHERE id = $1", [result.invocationId]);
        expect(unset.rows).toHaveLength(0);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const otherTenantId = randomUUID();
      const wrongTenant = await withTenantTransaction(otherTenantId, async (txClient) =>
        txClient.query("SELECT id FROM model_invocations WHERE id = $1", [result.invocationId]),
      );
      expect(wrongTenant.rows).toHaveLength(0);

      const correctTenant = await withTenantTransaction(ctx.tenantId, async (txClient) =>
        txClient.query("SELECT id FROM model_invocations WHERE id = $1", [result.invocationId]),
      );
      expect(correctTenant.rows.length).toBeGreaterThan(0);
    });
  });
});
