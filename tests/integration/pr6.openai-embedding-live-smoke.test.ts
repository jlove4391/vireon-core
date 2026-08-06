import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createOpenAIEmbeddingProvider, OPENAI_EMBEDDING_DIMENSIONS } from "../../src/elora/llm/embeddingProvider.js";
import { runEmbedding } from "../../src/elora/llm/operations/embedding.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

// Deliberately its own file, separate from pr6.hybrid-retrieval.test.ts:
// that file mocks embeddingProvider.js's createConfiguredEmbeddingProvider
// (module-wide, for every importer in its graph), so there is no clean way
// to reach the real, unmocked OpenAI embeddings API from inside a file that
// mocks it -- same split pr3.openai-live-smoke.test.ts already established
// for the identical reason. A real network call, gated behind an explicit
// opt-in flag, one inexpensive operation, safe synthetic input only, no
// side-effecting calls. Manual pre-merge signoff, never automatic CI --
// matching how this project already treats every other live-provider test.
const shouldRun = process.env.OPENAI_LIVE_SMOKE === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("PR 6: optional live OpenAI embedding smoke test", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it.skipIf(!shouldRun)(
    "a real OpenAI embedding call succeeds, with 1536 finite dimensions, a resolved model, and a SUCCEEDED model-invocation row",
    async () => {
      const provider = createOpenAIEmbeddingProvider(process.env.OPENAI_API_KEY!);
      const result = await runEmbedding(
        { text: "a short, safe, synthetic embedding smoke-test sentence", purpose: "query", dimensions: provider.dimensions },
        { tenantId: ctx.tenantId, provider, invocationKey: `pr6-live-smoke:${randomUUID()}` },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.embedding).toHaveLength(OPENAI_EMBEDDING_DIMENSIONS);
      expect(result.value.embedding.every(Number.isFinite)).toBe(true);
      expect(typeof result.value.model).toBe("string");
      expect(result.value.model.length).toBeGreaterThan(0);

      const row = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query("SELECT * FROM model_invocations WHERE id = $1", [result.invocationId]);
        return r.rows[0];
      });
      expect(row.status).toBe("SUCCEEDED");
      expect(row.provider).toBe("openai");
      expect(row.operation_kind).toBe("embedding");
      expect(row.input_tokens).not.toBeNull();
      expect(row.resolved_model).not.toBeNull();
    },
  );

  // Never logs the API key or the raw input text -- only whether the test
  // ran, matching pr3.openai-live-smoke.test.ts's own convention exactly.
  it("documents whether the optional live-OpenAI-embedding smoke test ran", () => {
    if (!shouldRun) {
      console.log(
        'PR 6 optional live-OpenAI-embedding smoke test SKIPPED: OPENAI_LIVE_SMOKE is not "1" and/or no OPENAI_API_KEY is present.',
      );
    }
    expect(true).toBe(true);
  });
});
