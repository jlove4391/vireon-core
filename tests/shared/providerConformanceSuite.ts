import { randomUUID } from "node:crypto";
import { ELORA_PERSONA } from "@vireon/persona-config";
import { describe, expect, it } from "vitest";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import type { ModelOperationKind, ModelOperationResult } from "../../src/elora/llm/executeModelOperation.js";
import { runCritique } from "../../src/elora/llm/operations/critique.js";
import { runExtraction } from "../../src/elora/llm/operations/extraction.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { runPlanning } from "../../src/elora/llm/operations/planning.js";
import { runReranking } from "../../src/elora/llm/operations/reranking.js";
import { runResponseSynthesis } from "../../src/elora/llm/operations/responseSynthesis.js";
import type { LlmProvider } from "../../src/elora/llm/types.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

/**
 * Named provider instances, one per test scenario. Each key is a
 * DIFFERENTLY-CONFIGURED provider satisfying the same LlmProvider
 * interface -- how a given scenario is achieved is provider-specific
 * (FakeLlmProvider takes direct per-method overrides; a
 * transport-mocked AnthropicProvider configures its mocked
 * @anthropic-ai/sdk transport instead), which is exactly why this is a
 * factory the calling test file supplies rather than something this
 * shared suite constructs itself.
 */
export interface ConformanceProviders {
  /** Every method returns well-formed output matching its operation's schema. */
  valid: LlmProvider;
  /** Every method returns output that fails Zod validation for its operation. */
  malformedOutput: LlmProvider;
  /** Every method throws. */
  throwsError: LlmProvider;
  /** Every method never resolves within a realistic time -- exercises the executor's own race-timeout. */
  hangsForTimeout: LlmProvider;
  /** rerank() returns a candidateId that was never in the input. */
  rerankUnknownId: LlmProvider;
  /** rerank() returns the same candidateId twice. */
  rerankDuplicateId: LlmProvider;
  /** Returns every required field correctly, plus extra fields no schema declares. */
  smuggledFields: LlmProvider;
}

async function fetchInvocationRow(tenantId: string, invocationId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM model_invocations WHERE id = $1 AND tenant_id = $2", [
      invocationId,
      tenantId,
    ]);
    return result.rows[0] as Record<string, unknown>;
  });
}

interface OperationCase {
  kind: ModelOperationKind;
  run: (provider: LlmProvider, ctx: SeededContext, invocationKey: string, timeoutMs?: number) => Promise<ModelOperationResult<unknown>>;
  /** responseSynthesis adapts the pre-existing, unmodified generateResponse -- documented as always reporting empty usage (see operations/responseSynthesis.ts). */
  expectsUsage: boolean;
}

function allOperationCases(): OperationCase[] {
  return [
    {
      kind: "response_synthesis",
      expectsUsage: false,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runResponseSynthesis(
          {
            persona: ELORA_PERSONA,
            userMessageContent: "conformance suite probe",
            taskType: "planning",
            authorityOutcome: "act_and_report",
            reason: "conformance suite",
            finalWorkOrderStatus: "READY_TO_ACT",
            toolResult: null,
            retrievedMemorySnippets: [],
          },
          { tenantId: ctx.tenantId, provider, invocationKey, deterministicFallback: "FALLBACK-TEXT", timeoutMs },
        ),
    },
    {
      kind: "intent_interpretation",
      expectsUsage: true,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runIntentInterpretation({ content: "help me plan the PR 2 rollout" }, { tenantId: ctx.tenantId, provider, invocationKey, timeoutMs }),
    },
    {
      kind: "planning",
      expectsUsage: true,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runPlanning({ objective: "ship PR 2" }, { tenantId: ctx.tenantId, provider, invocationKey, timeoutMs }),
    },
    {
      kind: "critique",
      expectsUsage: true,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runCritique({ subject: "a draft plan" }, { tenantId: ctx.tenantId, provider, invocationKey, timeoutMs }),
    },
    {
      kind: "extraction",
      expectsUsage: true,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runExtraction(
          { content: "Name: Alice, Age: 30", fields: ["Name", "Age"] },
          { tenantId: ctx.tenantId, provider, invocationKey, timeoutMs },
        ),
    },
    {
      kind: "reranking",
      expectsUsage: true,
      run: (provider, ctx, invocationKey, timeoutMs) =>
        runReranking(
          {
            query: "best plan",
            candidates: [
              { id: "a", content: "candidate A" },
              { id: "b", content: "candidate B" },
            ],
          },
          { tenantId: ctx.tenantId, provider, invocationKey, timeoutMs },
        ),
    },
  ];
}

/**
 * Reusable provider-conformance suite -- run once per provider (both
 * FakeLlmProvider and a transport-mocked AnthropicProvider), not
 * per-provider bespoke tests. The calling test file owns Postgres
 * lifecycle (migrate/seed/pool.end) since this function may be invoked
 * more than once in the same process.
 */
export function runProviderConformanceSuite(label: string, getCtx: () => SeededContext, providers: ConformanceProviders): void {
  describe(`Provider conformance: ${label}`, () => {
    it("valid output returns as typed data, for every one of the six operations", async () => {
      for (const operation of allOperationCases()) {
        const result = await operation.run(providers.valid, getCtx(), `conformance:${label}:valid:${operation.kind}:${randomUUID()}`);
        expect(result.ok, `${operation.kind} should succeed`).toBe(true);
        if (result.ok) {
          expect(result.source).toBe("MODEL");
          expect(typeof result.invocationId).toBe("string");
        }
      }
    });

    it("operation kinds are recorded correctly on the model_invocations row, for every operation", async () => {
      for (const operation of allOperationCases()) {
        const result = await operation.run(providers.valid, getCtx(), `conformance:${label}:kind:${operation.kind}:${randomUUID()}`);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const row = await fetchInvocationRow(getCtx().tenantId, result.invocationId);
        expect(row.operation_kind).toBe(operation.kind);
        expect(row.status).toBe("SUCCEEDED");
      }
    });

    it("usage metadata is captured for every operation that reports it", async () => {
      for (const operation of allOperationCases()) {
        const result = await operation.run(providers.valid, getCtx(), `conformance:${label}:usage:${operation.kind}:${randomUUID()}`);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const row = await fetchInvocationRow(getCtx().tenantId, result.invocationId);
        if (operation.expectsUsage) {
          expect(row.input_tokens).not.toBeNull();
          expect(row.output_tokens).not.toBeNull();
        }
      }
    });

    it("malformed output never escapes Zod validation", async () => {
      const result = await runIntentInterpretation(
        { content: "malformed output probe" },
        { tenantId: getCtx().tenantId, provider: providers.malformedOutput, invocationKey: `conformance:${label}:malformed:${randomUUID()}` },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("INVALID_OUTPUT");
        expect(result.error.retryable).toBe(false);
      }
    });

    it("timeouts produce the correct typed failure", async () => {
      const result = await runIntentInterpretation(
        { content: "timeout probe" },
        {
          tenantId: getCtx().tenantId,
          provider: providers.hangsForTimeout,
          invocationKey: `conformance:${label}:timeout:${randomUUID()}`,
          timeoutMs: 50,
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("TIMEOUT");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("provider exceptions never escape to the caller", async () => {
      await expect(
        runIntentInterpretation(
          { content: "throw probe" },
          { tenantId: getCtx().tenantId, provider: providers.throwsError, invocationKey: `conformance:${label}:throws:${randomUUID()}` },
        ),
      ).resolves.not.toThrow();

      const result = await runIntentInterpretation(
        { content: "throw probe 2" },
        { tenantId: getCtx().tenantId, provider: providers.throwsError, invocationKey: `conformance:${label}:throws2:${randomUUID()}` },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("PROVIDER_FAILURE");
        expect(result.error.retryable).toBe(true);
      }
    });

    it("unknown or duplicate candidate IDs fail reranking validation specifically", async () => {
      const unknownIdResult = await runReranking(
        {
          query: "q",
          candidates: [
            { id: "a", content: "A" },
            { id: "b", content: "B" },
          ],
        },
        {
          tenantId: getCtx().tenantId,
          provider: providers.rerankUnknownId,
          invocationKey: `conformance:${label}:rerank-unknown:${randomUUID()}`,
        },
      );
      expect(unknownIdResult.ok).toBe(false);
      if (!unknownIdResult.ok) {
        expect(unknownIdResult.error.kind).toBe("INVALID_OUTPUT");
      }

      const duplicateIdResult = await runReranking(
        {
          query: "q",
          candidates: [
            { id: "a", content: "A" },
            { id: "b", content: "B" },
          ],
        },
        {
          tenantId: getCtx().tenantId,
          provider: providers.rerankDuplicateId,
          invocationKey: `conformance:${label}:rerank-duplicate:${randomUUID()}`,
        },
      );
      expect(duplicateIdResult.ok).toBe(false);
      if (!duplicateIdResult.ok) {
        expect(duplicateIdResult.error.kind).toBe("INVALID_OUTPUT");
      }
    });

    it("the provider cannot smuggle additional unvalidated fields through", async () => {
      const result = await runIntentInterpretation(
        { content: "smuggling probe" },
        {
          tenantId: getCtx().tenantId,
          provider: providers.smuggledFields,
          invocationKey: `conformance:${label}:smuggle:${randomUUID()}`,
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty("extraHackerField");
        expect(Object.keys(result.value as object).sort()).toEqual(["confidence", "intentType", "summary", "taskType"]);
      }
    });
  });
}
