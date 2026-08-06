import OpenAI from "openai";
import type { EmbeddingInput, ModelOperationProvider, ProviderOperationCallResult, ProviderUsage } from "./types.js";

// PR 6 §2.2: fixed v1 production configuration. Verified directly against
// current (2026) OpenAI documentation: text-embedding-3-small is real,
// active (not deprecated), defaults to 1536 dimensions, and is OpenAI's
// standard recommended default for cost-sensitive production retrieval --
// not an arbitrary choice. Changing this later must produce new
// memory_embeddings rows (a new model_version) and supersede earlier
// embeddings -- never overwrite them in place (writeMemoryEmbedding.ts).
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;

// PR 3's locked decision, reused verbatim: CORE -- not the provider SDK --
// owns retry policy, attempt numbering, and evidence. A single logical
// attempt this codebase records as one model_invocations row must not
// silently correspond to more than one real external HTTP request.
const MAX_RETRIES = 0;

/**
 * PR 6 §6.1: a separate provider contract, not an extension of LlmProvider.
 * Embedding generation is an independent provider axis from chat/
 * structured-operation providers (§2.1) -- fixed to OpenAI because
 * Anthropic offers no embeddings API at all (a stated product decision on
 * their part, not a temporary gap), so there is no "Anthropic embedding"
 * option to select between and nothing to make pluggable here yet.
 */
export interface EmbeddingProvider extends ModelOperationProvider {
  readonly dimensions: number;
  embed(input: EmbeddingInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
}

/**
 * Mirrors openaiProvider.ts's own buildClient() exactly: constructed lazily,
 * fresh inside the method call, never held on `this` -- this is what makes
 * provider selection genuinely lazy (constructing an EmbeddingProvider
 * touches nothing until embed() actually runs). maxRetries: 0 and an
 * explicit timeout are both set here for the same reasoning already
 * documented in executeModelOperation.ts's raceWithTimeout comment.
 */
function buildClient(apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({ apiKey, maxRetries: MAX_RETRIES, timeout: timeoutMs, logLevel: "warn" });
}

/**
 * The only real EmbeddingProvider implementation. Deliberately does NOT
 * implement LlmProvider and never will -- see this module's own doc
 * comment on EmbeddingProvider for why that's a genuine axis split, not an
 * oversight.
 *
 * The three structural checks below (result count, vector length, finite
 * values) validate OpenAI's own raw response before it's mapped into
 * ProviderOperationCallResult -- a defensive check on this provider's
 * faithful mapping of an untyped API response, expected to never actually
 * trigger against a well-behaved OpenAI. This is a different, earlier
 * layer than the embedding operation's own output schema (operations/
 * embedding.ts), which independently re-validates length and finiteness on
 * whatever `output.embedding` a provider returns -- including a test
 * double that never parses a "raw OpenAI response" at all. Both layers are
 * real and intentional, not redundant: one guards this provider's own
 * parsing, the other guards the executor's contract with every provider.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "openai";
  readonly modelId = OPENAI_EMBEDDING_MODEL;
  readonly dimensions = OPENAI_EMBEDDING_DIMENSIONS;

  constructor(private readonly apiKey: string) {}

  async embed(input: EmbeddingInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);

    const { data: response, response: httpResponse } = await client.embeddings
      .create(
        {
          model: OPENAI_EMBEDDING_MODEL,
          input: input.text,
          encoding_format: "float",
          dimensions: input.dimensions,
        },
        { timeout: timeoutMs },
      )
      .withResponse();

    if (response.data.length !== 1) {
      throw new Error(`OpenAI embeddings API returned ${response.data.length} result(s), expected exactly 1`);
    }
    const embedding = response.data[0]!.embedding;
    if (embedding.length !== input.dimensions) {
      throw new Error(
        `OpenAI embeddings API returned a vector of length ${embedding.length}, expected ${input.dimensions}`,
      );
    }
    if (!embedding.every((value) => Number.isFinite(value))) {
      throw new Error("OpenAI embeddings API returned a vector containing a non-finite value");
    }

    // Never fabricate output-token usage -- the embeddings endpoint only
    // ever reports prompt/total tokens (there is no "output" to an
    // embedding call), so outputTokens is deliberately left unset here,
    // recorded as NULL, not a guessed 0.
    const providerUsage: ProviderUsage = {
      inputTokens: response.usage?.prompt_tokens,
      raw: response.usage ? { ...response.usage } : undefined,
    };

    return {
      output: {
        embedding,
        model: response.model,
        dimensions: embedding.length,
      },
      usage: providerUsage,
      providerRequestId: httpResponse.headers.get("x-request-id") ?? undefined,
      resolvedModel: response.model,
    };
  }
}

export function createOpenAIEmbeddingProvider(apiKey: string): EmbeddingProvider {
  return new OpenAIEmbeddingProvider(apiKey);
}

/** PR 6 §2.3: hybrid mode with a missing key must fail configuration validation explicitly, never silently construct a fake provider. */
export class EmbeddingProviderConfigurationError extends Error {
  constructor(reason: string) {
    super(`Embedding provider configuration error: ${reason}`);
    this.name = "EmbeddingProviderConfigurationError";
  }
}

/**
 * Reads OPENAI_API_KEY only -- never MODEL_PROVIDER (§6.3/§2.1). Embedding
 * generation is fixed to OpenAI regardless of which chat provider a
 * deployment has configured; an Anthropic chat deployment
 * (MODEL_PROVIDER=anthropic) can and is expected to use OpenAI embeddings
 * for hybrid retrieval. Deterministic retrieval must never call this
 * function -- see retrievalStrategy.ts / retrieveRelevantMemory.ts.
 */
export function createConfiguredEmbeddingProvider(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new EmbeddingProviderConfigurationError(
      "OPENAI_API_KEY is required when MEMORY_RETRIEVAL_STRATEGY=hybrid",
    );
  }
  return createOpenAIEmbeddingProvider(apiKey);
}
