import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import type { LlmProvider } from "./types.js";

export const PROVIDER_KINDS = ["anthropic", "openai"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderDependencies {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

/**
 * Environment configuration only, fail-closed, no fallback. No per-tenant
 * selection in this PR -- that needs durable tenant config, RLS, admin
 * authorization, audit, and credential-availability handling, which is a
 * genuinely separate, later PR, not a small addition to this one.
 *
 * The unused provider never requires credentials: both AnthropicProvider
 * and OpenAIProvider construct their real SDK client lazily, fresh inside
 * each method call, never at construction time (see each provider's own
 * doc comment) -- so `selectLlmProvider("anthropic", { anthropicApiKey })`
 * never touches `dependencies.openaiApiKey` at all, and vice versa.
 */
export function selectLlmProvider(kind: ProviderKind, dependencies: ProviderDependencies): LlmProvider {
  switch (kind) {
    case "anthropic": {
      if (!dependencies.anthropicApiKey) {
        throw new Error('selectLlmProvider: provider "anthropic" selected but no anthropicApiKey was supplied');
      }
      return new AnthropicProvider(dependencies.anthropicApiKey);
    }
    case "openai": {
      if (!dependencies.openaiApiKey) {
        throw new Error('selectLlmProvider: provider "openai" selected but no openaiApiKey was supplied');
      }
      return new OpenAIProvider(dependencies.openaiApiKey);
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`selectLlmProvider: unrecognized provider kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Reads MODEL_PROVIDER from the environment. An unrecognized (or unset)
 * value fails startup validation -- never a silent default to one
 * provider over the other.
 */
export function readProviderKindFromEnv(): ProviderKind {
  const raw = process.env.MODEL_PROVIDER;
  if (raw !== "anthropic" && raw !== "openai") {
    throw new Error(`MODEL_PROVIDER must be set to "anthropic" or "openai", got: ${JSON.stringify(raw)}`);
  }
  return raw;
}
