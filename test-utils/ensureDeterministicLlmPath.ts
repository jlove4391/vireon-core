import { afterAll, beforeAll } from "vitest";

/**
 * Guarantees ingestUserMessage() takes the deterministic response-text
 * fallback path (src/elora/generateEloraResponse.ts) for the duration of
 * the calling describe block, regardless of what ANTHROPIC_API_KEY/
 * ELORA_LLM_DISABLED actually happen to be set to in the ambient
 * environment (.env, shell exports, CI secrets, etc.).
 *
 * Call once inside a top-level describe() body, alongside the suite's own
 * beforeAll/afterAll. Saves the real values once and restores them
 * afterward -- never a blind delete -- so a real key present in the
 * environment (e.g. for tests/integration/phase6f.llm-integration.test.ts's
 * own optional real-model test) is left intact for whichever file actually
 * needs it.
 *
 * Phase 6F's own test file manages its own key state directly (it needs to
 * toggle a real/mock provider mid-suite) and does not use this helper.
 * This exists for every other suite, which was never meant to depend on
 * whether an LLM happens to be reachable.
 */
export function ensureDeterministicLlmPath(): void {
  let originalApiKey: string | undefined;
  let originalDisabledFlag: string | undefined;

  beforeAll(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalDisabledFlag = process.env.ELORA_LLM_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ELORA_LLM_DISABLED;
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalDisabledFlag === undefined) {
      delete process.env.ELORA_LLM_DISABLED;
    } else {
      process.env.ELORA_LLM_DISABLED = originalDisabledFlag;
    }
  });
}
