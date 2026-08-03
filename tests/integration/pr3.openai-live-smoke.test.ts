import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { OpenAIProvider } from "../../src/elora/llm/openaiProvider.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

// Deliberately its own file, separate from pr3.openai-provider.test.ts: that
// file's vi.mock("openai", ...) applies to every importer in its module
// graph, so there is no clean way to reach the real, unmocked SDK from
// inside a file that mocks it (same reasoning as
// pr2.live-anthropic-smoke.test.ts's own split). Never mocks the SDK at
// all -- a real network call, gated behind an explicit opt-in flag, one
// inexpensive operation, safe synthetic input only, no side-effecting
// calls. Manual pre-merge signoff, never automatic CI -- matching how this
// project already treats every other live-provider test.
const shouldRun = process.env.OPENAI_LIVE_SMOKE === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("PR 3: optional live OpenAI smoke test", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it.skipIf(!shouldRun)(
    "a real OpenAI call succeeds for intent interpretation, with structured output, usage, and correlation evidence captured",
    async () => {
      const provider = new OpenAIProvider(process.env.OPENAI_API_KEY!);
      const result = await runIntentInterpretation(
        { content: "Help me draft a short status update for the team." },
        { tenantId: ctx.tenantId, provider, invocationKey: `pr3-live-smoke:${randomUUID()}` },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.source).toBe("MODEL");
      expect(typeof result.value.intentType).toBe("string");
      expect(typeof result.value.taskType).toBe("string");

      const row = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query("SELECT * FROM model_invocations WHERE id = $1", [result.invocationId]);
        return r.rows[0];
      });
      expect(row.status).toBe("SUCCEEDED");
      expect(row.provider).toBe("openai");
      expect(row.input_tokens).not.toBeNull();
      expect(row.output_tokens).not.toBeNull();
      expect(row.provider_response_id).not.toBeNull();
      expect(row.resolved_model).not.toBeNull();
    },
  );

  it("documents whether the optional live-OpenAI smoke test ran", () => {
    if (!shouldRun) {
      console.log(
        'PR 3 optional live-OpenAI smoke test SKIPPED: OPENAI_LIVE_SMOKE is not "1" and/or no OPENAI_API_KEY is present.',
      );
    }
    expect(true).toBe(true);
  });
});
