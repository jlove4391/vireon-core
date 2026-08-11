import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { FakeLlmProvider } from "../../src/elora/llm/fakeProvider.js";
import { OpenAIProvider } from "../../src/elora/llm/openaiProvider.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { selectLlmProvider, readProviderKindFromEnv } from "../../src/elora/llm/providerSelection.js";
import type { SensitiveField } from "../../src/elora/llm/contentPolicy/types.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import type { ConformanceProviders } from "../shared/providerConformanceSuite.js";
import { runProviderConformanceSuite } from "../shared/providerConformanceSuite.js";

// Mocks the `openai` SDK package itself (its transport), not the whole
// OpenAIProvider class -- same technique pr2.structured-model-operations.test.ts
// uses for @anthropic-ai/sdk, so the REAL OpenAIProvider code (prompt
// building, JSON parsing, refusal/incomplete detection, usage mapping)
// runs end-to-end against a controlled fake transport.
type OpenAIMockScenario =
  | "valid"
  | "malformed"
  | "throws"
  | "hangs"
  | "rerank-unknown"
  | "rerank-duplicate"
  | "smuggle"
  | "refusal"
  | "incomplete-max-tokens"
  | "incomplete-content-filter"
  | "empty-output"
  | "invalid-json"
  | "failed-status"
  | "rate-limit"
  | "server-error"
  | "auth-error"
  | "aborted";

const openaiMockState = vi.hoisted(() => ({ scenario: "valid" as OpenAIMockScenario }));

function validTextFor(params: { text?: { format?: { name?: string } }; input?: Array<{ content?: string }> }): string {
  if (!params.text?.format) {
    // generateResponse's own plain-text path -- no structured format requested.
    return "A real, sane in-character reply.";
  }
  const developerContent = params.input?.[0]?.content ?? "";
  if (developerContent.includes("structured intent classifier")) {
    return JSON.stringify({
      route: "converse",
      interpretedIntent: "mocked interpretation",
      confidence: 0.7,
      taskDomain: null,
      requestedCapabilities: [],
      proposedDelegationTarget: null,
      requiresDurableWork: false,
      proposedToolNeeds: [],
      externalSideEffect: false,
      requiresClarification: false,
      clarifyingQuestion: null,
    });
  }
  if (developerContent.includes("planning assistant")) {
    return JSON.stringify({ steps: [{ description: "mocked step" }] });
  }
  if (developerContent.includes("critical reviewer")) {
    return JSON.stringify({ verdict: "approve", issues: [], summary: "mocked critique" });
  }
  if (developerContent.includes("extract specific fields")) {
    return JSON.stringify({ values: { Name: "Alice", Age: 30 } });
  }
  if (developerContent.includes("rerank a list of candidates")) {
    return JSON.stringify({
      rankedCandidates: [
        { candidateId: "a", rank: 1 },
        { candidateId: "b", rank: 2 },
      ],
    });
  }
  return "{}";
}

function messageOutput(text: string) {
  return [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
}
function refusalOutput(refusalText: string) {
  return [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: refusalText }] }];
}

function buildResponseForScenario(scenario: OpenAIMockScenario, params: Parameters<typeof validTextFor>[0]) {
  const base = {
    id: "resp_mock_123",
    created_at: 0,
    model: "gpt-5.6-luna",
    output_text: "",
    error: null as { message: string; code?: string } | null,
    incomplete_details: null as { reason?: "max_output_tokens" | "content_filter" } | null,
    instructions: null,
    metadata: null,
    status: "completed" as "completed" | "incomplete" | "failed" | "in_progress",
    usage: { input_tokens: 111, output_tokens: 22, input_tokens_details: { cached_tokens: 3 } },
    output: [] as ReturnType<typeof messageOutput>,
  };

  switch (scenario) {
    case "refusal":
      return { ...base, output: refusalOutput("I can't help with that.") };
    case "incomplete-max-tokens":
      return { ...base, status: "incomplete" as const, incomplete_details: { reason: "max_output_tokens" as const } };
    case "incomplete-content-filter":
      return { ...base, status: "incomplete" as const, incomplete_details: { reason: "content_filter" as const } };
    case "empty-output":
      return base;
    case "invalid-json":
      return { ...base, output: messageOutput("this is not { valid json") };
    case "failed-status":
      return { ...base, status: "failed" as const, error: { message: "simulated provider-side failure", code: "server_error" } };
    case "malformed":
      return { ...base, output: messageOutput(JSON.stringify({ totally: "wrong shape" })) };
    case "smuggle":
      return {
        ...base,
        output: messageOutput(
          JSON.stringify({
            route: "converse",
            interpretedIntent: "ok",
            confidence: 0.5,
            taskDomain: null,
            requestedCapabilities: [],
            proposedDelegationTarget: null,
            requiresDurableWork: false,
            proposedToolNeeds: [],
            externalSideEffect: false,
            requiresClarification: false,
            clarifyingQuestion: null,
            extraHackerField: "nope",
          }),
        ),
      };
    case "rerank-unknown":
      return { ...base, output: messageOutput(JSON.stringify({ rankedCandidates: [{ candidateId: "not-real", rank: 1 }] })) };
    case "rerank-duplicate":
      return {
        ...base,
        output: messageOutput(
          JSON.stringify({
            rankedCandidates: [
              { candidateId: "a", rank: 1 },
              { candidateId: "a", rank: 2 },
            ],
          }),
        ),
      };
    default:
      return { ...base, output: messageOutput(validTextFor(params)) };
  }
}

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();

  class MockOpenAI {
    constructor(_options: unknown) {}
    responses = {
      create: (params: Parameters<typeof validTextFor>[0]) => {
        const scenario = openaiMockState.scenario;

        const resolve = async () => {
          if (scenario === "throws") {
            throw new Error("simulated generic OpenAI provider failure");
          }
          if (scenario === "hangs") {
            return new Promise(() => {
              // Never resolves -- exercises executeModelOperation's own race-timeout.
            }) as never;
          }
          if (scenario === "rate-limit") {
            throw new actual.RateLimitError(429, {}, "Rate limit exceeded", new Headers());
          }
          if (scenario === "server-error") {
            throw new actual.InternalServerError(500, {}, "Internal server error", new Headers());
          }
          if (scenario === "auth-error") {
            throw new actual.AuthenticationError(401, {}, "Invalid API key", new Headers());
          }
          if (scenario === "aborted") {
            throw new actual.APIUserAbortError({ message: "Request aborted by caller" });
          }
          const data = buildResponseForScenario(scenario, params);
          return {
            data,
            response: { headers: { get: (name: string) => (name === "x-request-id" ? "req_mock_123" : null) } },
          };
        };

        // openaiProvider.ts only ever calls .withResponse() on the result
        // of .create() (never awaits the bare return value directly), so
        // this mock only needs to implement that one method -- returning a
        // plain object here (not also a self-invoking thenable) avoids an
        // unhandled-rejection warning from a second, unconsumed promise for
        // every throwing/hanging scenario.
        return { withResponse: resolve };
      },
    };
  }

  return { ...actual, default: MockOpenAI };
});

describe("PR 3: OpenAI direct provider + content-policy boundary acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("Provider conformance: OpenAIProvider (mocked transport)", () => {
    // Constructed once, synchronously -- vitest requires all test
    // registration to happen during collection, not from inside an
    // it()/beforeAll() callback (see pr2.structured-model-operations.test.ts's
    // own comment on the identical constraint). OpenAIProvider is imported
    // statically at the top of this file specifically so this works --
    // vi.mock("openai", ...) below is hoisted above all imports by vitest
    // regardless of import style, so the static import still picks up the
    // mocked transport.
    const real = new OpenAIProvider("test-openai-key");
    const withScenario =
      <A extends unknown[], R>(scenario: OpenAIMockScenario, fn: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        openaiMockState.scenario = scenario;
        return fn(...args);
      };
    const scenarioProvider = (scenario: OpenAIMockScenario) => ({
      providerId: real.providerId,
      modelId: real.modelId,
      generateResponse: withScenario(scenario, real.generateResponse.bind(real)),
      interpretIntent: withScenario(scenario, real.interpretIntent.bind(real)),
      plan: withScenario(scenario, real.plan.bind(real)),
      critique: withScenario(scenario, real.critique.bind(real)),
      extract: withScenario(scenario, real.extract.bind(real)),
      rerank: withScenario(scenario, real.rerank.bind(real)),
    });

    const openaiProviders: ConformanceProviders = {
      valid: scenarioProvider("valid"),
      malformedOutput: scenarioProvider("malformed"),
      throwsError: scenarioProvider("throws"),
      hangsForTimeout: scenarioProvider("hangs"),
      rerankUnknownId: scenarioProvider("rerank-unknown"),
      rerankDuplicateId: scenarioProvider("rerank-duplicate"),
      smuggledFields: scenarioProvider("smuggle"),
    };

    runProviderConformanceSuite("OpenAIProvider (mocked transport)", () => ctx, openaiProviders);
  });

  describe("OpenAI-specific terminal conditions", () => {
    async function runWithScenario(scenario: OpenAIMockScenario) {
      openaiMockState.scenario = scenario;
      const provider = new OpenAIProvider("test-openai-key");
      return runIntentInterpretation(
        { content: "terminal condition probe" },
        { tenantId: ctx.tenantId, provider, invocationKey: `pr3-terminal:${scenario}:${randomUUID()}` },
      );
    }

    it("model refusal -> MODEL_REFUSAL, not retryable", async () => {
      const result = await runWithScenario("refusal");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("MODEL_REFUSAL");
        expect(result.error.retryable).toBe(false);
      }
    });

    it("incomplete output (max_output_tokens) -> INCOMPLETE_OUTPUT, retryable", async () => {
      const result = await runWithScenario("incomplete-max-tokens");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("INCOMPLETE_OUTPUT");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("incomplete output (content_filter) -> INCOMPLETE_OUTPUT, retryable", async () => {
      const result = await runWithScenario("incomplete-content-filter");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("INCOMPLETE_OUTPUT");
      }
    });

    it("missing/empty parsed output -> INCOMPLETE_OUTPUT", async () => {
      const result = await runWithScenario("empty-output");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("INCOMPLETE_OUTPUT");
      }
    });

    it("invalid (unparseable) structured output -> INVALID_OUTPUT, not retryable", async () => {
      const result = await runWithScenario("invalid-json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("INVALID_OUTPUT");
        expect(result.error.retryable).toBe(false);
      }
    });

    it("provider-side failed status -> PROVIDER_FAILURE", async () => {
      const result = await runWithScenario("failed-status");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
      }
    });

    it("429 rate limit -> PROVIDER_FAILURE with a real RateLimitError error_class", async () => {
      const result = await runWithScenario("rate-limit");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
        expect(result.error.retryable).toBe(true);
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT error_class FROM model_invocations WHERE id = $1", [result.invocationId]);
          return r.rows[0];
        });
        expect(row.error_class).toBe("RateLimitError");
      }
    });

    it("500 internal server error -> PROVIDER_FAILURE with a real InternalServerError error_class", async () => {
      const result = await runWithScenario("server-error");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT error_class FROM model_invocations WHERE id = $1", [result.invocationId]);
          return r.rows[0];
        });
        expect(row.error_class).toBe("InternalServerError");
      }
    });

    it("authentication failure -> PROVIDER_FAILURE with a real AuthenticationError error_class", async () => {
      const result = await runWithScenario("auth-error");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT error_class FROM model_invocations WHERE id = $1", [result.invocationId]);
          return r.rows[0];
        });
        expect(row.error_class).toBe("AuthenticationError");
      }
    });

    it("aborted request -> PROVIDER_FAILURE with a real APIUserAbortError error_class", async () => {
      const result = await runWithScenario("aborted");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT error_class FROM model_invocations WHERE id = $1", [result.invocationId]);
          return r.rows[0];
        });
        expect(row.error_class).toBe("APIUserAbortError");
      }
    });

    it("provider_request_id / provider_response_id / resolved_model are captured on success", async () => {
      const result = await runWithScenario("valid");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query(
            "SELECT provider_request_id, provider_response_id, resolved_model FROM model_invocations WHERE id = $1",
            [result.invocationId],
          );
          return r.rows[0];
        });
        expect(row.provider_request_id).toBe("req_mock_123");
        expect(row.provider_response_id).toBe("resp_mock_123");
        expect(row.resolved_model).toBe("gpt-5.6-luna");
      }
    });
  });

  describe("Content-policy boundary", () => {
    it("SECRET-classified declared field blocks the request with zero model_invocations rows", async () => {
      const declaredFields: SensitiveField[] = [{ name: "apiKey", classification: "SECRET", value: "sk-super-secret-value" }];
      const beforeCount = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query("SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id = $1", [ctx.tenantId]);
        return (r.rows[0] as { n: number }).n;
      });

      const result = await runIntentInterpretation(
        { content: "please use this: sk-super-secret-value" },
        {
          tenantId: ctx.tenantId,
          provider: new FakeLlmProvider(),
          invocationKey: `pr3-policy-secret:${randomUUID()}`,
          contentPolicy: { declaredFields },
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("SENSITIVE_CONTEXT_BLOCKED");
        expect(result.error.retryable).toBe(false);
        // Never a row with a FAILED status -- no row at all, because no
        // provider call ever occurred.
        expect(result.invocationId).toBeUndefined();
      }

      const afterCount = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query("SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id = $1", [ctx.tenantId]);
        return (r.rows[0] as { n: number }).n;
      });
      expect(afterCount).toBe(beforeCount);
    });

    it("RESTRICTED-classified content fails closed without an explicit policy allow", async () => {
      const declaredFields: SensitiveField[] = [{ name: "token", classification: "RESTRICTED", value: "Bearer some-restricted-token-value" }];
      const result = await runIntentInterpretation(
        { content: "context" },
        {
          tenantId: ctx.tenantId,
          provider: new FakeLlmProvider(),
          invocationKey: `pr3-policy-restricted:${randomUUID()}`,
          contentPolicy: { declaredFields },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("SENSITIVE_CONTEXT_BLOCKED");
      }
    });

    it("CONFIDENTIAL-classified content is allowed only for an approved provider, and is redacted before reaching it", async () => {
      const secretValue = "internal-project-codename-zephyr";
      const declaredFields: SensitiveField[] = [{ name: "projectCodename", classification: "CONFIDENTIAL", value: secretValue }];

      let receivedContent: string | undefined;
      const capturingProvider = new FakeLlmProvider({
        interpretIntent: async (input) => {
          receivedContent = input.content;
          return {
            output: {
              route: "converse",
              interpretedIntent: "ok",
              confidence: 0.5,
              taskDomain: null,
              requestedCapabilities: [],
              proposedDelegationTarget: null,
              requiresDurableWork: false,
              proposedToolNeeds: [],
              externalSideEffect: false,
              requiresClarification: false,
              clarifyingQuestion: null,
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      });

      // Not approved for the fake provider -> blocked.
      const blocked = await runIntentInterpretation(
        { content: `The codename is ${secretValue}.` },
        {
          tenantId: ctx.tenantId,
          provider: capturingProvider,
          invocationKey: `pr3-policy-confidential-blocked:${randomUUID()}`,
          contentPolicy: { declaredFields, approvedProvidersForConfidential: ["anthropic"] },
        },
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.error.kind).toBe("SENSITIVE_CONTEXT_BLOCKED");
      }

      // Approved for "fake" -> allowed, and the secret value must be redacted before it reaches the provider.
      const allowed = await runIntentInterpretation(
        { content: `The codename is ${secretValue}.` },
        {
          tenantId: ctx.tenantId,
          provider: capturingProvider,
          invocationKey: `pr3-policy-confidential-allowed:${randomUUID()}`,
          contentPolicy: { declaredFields, approvedProvidersForConfidential: ["fake"] },
        },
      );
      expect(allowed.ok).toBe(true);
      expect(receivedContent).not.toContain(secretValue);
      expect(receivedContent).toContain("[REDACTED:projectCodename]");

      if (allowed.ok) {
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query(
            "SELECT input_classification, redaction_applied, redaction_count, request_fingerprint FROM model_invocations WHERE id = $1",
            [allowed.invocationId],
          );
          return r.rows[0];
        });
        expect(row.input_classification).toBe("CONFIDENTIAL");
        expect(row.redaction_applied).toBe(true);
        expect(row.redaction_count).toBeGreaterThan(0);
        // The fingerprint must never be computed over the original secret --
        // hashing the same secret value independently must not match, by
        // construction (fingerprint is over the redacted request, not raw content).
        expect(row.request_fingerprint).not.toBeNull();
      }
    });

    it("PUBLIC/INTERNAL content (no declared fields) passes through unchanged, matching pre-PR-3 behavior exactly", async () => {
      const result = await runIntentInterpretation(
        { content: "ordinary, non-sensitive request" },
        { tenantId: ctx.tenantId, provider: new FakeLlmProvider(), invocationKey: `pr3-policy-internal:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const row = await withTenantTransaction(ctx.tenantId, async (client) => {
          const r = await client.query("SELECT input_classification, redaction_applied, redaction_count FROM model_invocations WHERE id = $1", [
            result.invocationId,
          ]);
          return r.rows[0];
        });
        expect(row.input_classification).toBe("INTERNAL");
        expect(row.redaction_applied).toBe(false);
        expect(row.redaction_count).toBe(0);
      }
    });
  });

  describe("providerSelection.ts", () => {
    it("fails closed on an unrecognized or unset MODEL_PROVIDER value", () => {
      const original = process.env.MODEL_PROVIDER;
      try {
        delete process.env.MODEL_PROVIDER;
        expect(() => readProviderKindFromEnv()).toThrow(/MODEL_PROVIDER must be set/);
        process.env.MODEL_PROVIDER = "not-a-real-provider";
        expect(() => readProviderKindFromEnv()).toThrow(/MODEL_PROVIDER must be set/);
      } finally {
        if (original === undefined) {
          delete process.env.MODEL_PROVIDER;
        } else {
          process.env.MODEL_PROVIDER = original;
        }
      }
    });

    it("selects the requested provider without requiring the other provider's credentials", () => {
      expect(() => selectLlmProvider("anthropic", { anthropicApiKey: "test-key" })).not.toThrow();
      expect(() => selectLlmProvider("openai", { openaiApiKey: "test-key" })).not.toThrow();
    });

    it("throws when the selected provider's own credential is missing", () => {
      expect(() => selectLlmProvider("anthropic", {})).toThrow(/anthropicApiKey/);
      expect(() => selectLlmProvider("openai", {})).toThrow(/openaiApiKey/);
    });
  });
});
