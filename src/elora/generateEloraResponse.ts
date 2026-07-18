import { AnthropicProvider } from "./llm/anthropicProvider.js";
import type { LlmProvider, LlmResponseContext } from "./llm/types.js";

// Generous for a real round trip, short enough to catch a genuinely hung
// request (§6). Wraps only the provider call itself, not the whole HTTP
// request -- unrelated request handling (DB writes, receipt writing) is
// never affected by this specific timeout.
const LLM_TIMEOUT_MS = 30_000;

export interface GenerateEloraResponseInput {
  context: LlmResponseContext;
  /**
   * Already computed by the caller using the existing, unmodified
   * deterministic code (produceDirectAnswer.ts / synthesizeIngestionResponse.ts's
   * blocked-branch templates / runToolExecution.ts's tool-result templates,
   * depending on which branch this call is for). This is "produceDirectAnswer.ts's
   * existing logic, not deleted" -- it's exactly what runs today, generalized
   * to being called for every branch by having every branch supply its own
   * fallback text here, rather than being duplicated into a second
   * parallel implementation.
   */
  deterministicFallback: string;
  /** Test seam -- defaults to a real AnthropicProvider when ANTHROPIC_API_KEY is set. */
  provider?: LlmProvider;
}

function isEnabled(): boolean {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const explicitlyDisabled = process.env.ELORA_LLM_DISABLED === "true";
  return Boolean(apiKey) && !explicitlyDisabled;
}

function resolveDefaultProvider(): LlmProvider | null {
  if (!isEnabled()) {
    return null;
  }
  return new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);
}

/** Non-empty and not absurdly long -- a basic sanity check, not content validation. */
function passesSanityCheck(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < 4000;
}

/**
 * Orchestrator: tries the LLM provider (if enabled), falls back to the
 * caller-supplied deterministic text on any failure -- timeout, API error,
 * or an empty/malformed response. Never throws, never returns an empty
 * string, never surfaces a raw provider error to the caller.
 *
 * Strict ordering (§5.1): callers must only invoke this after
 * transitionWorkOrder() has already finalized the branch status. This
 * function itself has no opinion about that -- it's the caller's
 * responsibility (ingestUserMessage.ts) to call it at the right point.
 */
export async function generateEloraResponse(input: GenerateEloraResponseInput): Promise<string> {
  const provider = input.provider ?? resolveDefaultProvider();
  if (!provider) {
    return input.deterministicFallback;
  }

  try {
    const result = await provider.generateResponse(input.context, LLM_TIMEOUT_MS);
    if (passesSanityCheck(result)) {
      return result;
    }
  } catch {
    // Timeout, API error, network failure -- fall through to the
    // deterministic fallback. Never thrown further, never left blank.
  }

  return input.deterministicFallback;
}
