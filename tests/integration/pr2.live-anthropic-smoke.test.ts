import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { AnthropicProvider } from "../../src/elora/llm/anthropicProvider.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

// Deliberately its own file, separate from pr2.structured-model-operations.test.ts:
// that file's vi.mock("@anthropic-ai/sdk", ...) applies to every importer in its
// module graph (including via vi.importActual on a dependent module), so there is
// no clean way to reach the real, unmocked SDK from inside a file that mocks it.
// This file never mocks the SDK at all -- a real network call, gated behind an
// explicit opt-in flag, exactly like tests/integration/phase6f.llm-integration.test.ts's
// own optional real-model test.
const shouldRun = process.env.RUN_LIVE_ANTHROPIC_TESTS === "true" && Boolean(process.env.ANTHROPIC_API_KEY);

describe("PR 2: optional live Anthropic smoke test", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it.skipIf(!shouldRun)("a real Anthropic call succeeds for intent interpretation", async () => {
    const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);
    const result = await runIntentInterpretation(
      { content: "Help me draft a project plan for CORE memory v1." },
      { tenantId: ctx.tenantId, provider, invocationKey: `pr2-live-smoke:${randomUUID()}` },
    );
    expect(result.ok).toBe(true);
  });

  it("documents whether the optional live-Anthropic smoke test ran", () => {
    if (!shouldRun) {
      console.log(
        'PR 2 optional live-Anthropic smoke test SKIPPED: RUN_LIVE_ANTHROPIC_TESTS is not "true" and/or no ANTHROPIC_API_KEY is present.',
      );
    }
    expect(true).toBe(true);
  });
});
