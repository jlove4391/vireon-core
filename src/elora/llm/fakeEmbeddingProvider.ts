import type { EmbeddingProvider } from "./embeddingProvider.js";
import type { EmbeddingInput, ProviderOperationCallResult, ProviderUsage } from "./types.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// FNV-1a 32-bit -- a small, well-known, deterministic non-cryptographic
// hash. No randomness, no external dependency.
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * PR 6 §8: deterministic feature-hashing embedding, test infrastructure
 * only -- never a production fallback (embedding has no deterministic
 * fallback at all, unlike response_synthesis; see operations/embedding.ts's
 * own doc comment).
 *
 * Each token contributes a deterministic +1/-1 to one vector dimension
 * (chosen by hashing the token), accumulated across repeats. Text sharing
 * tokens with another text therefore produces a measurably higher cosine
 * similarity than text sharing none. Hashing the *whole string* into an
 * unrelated-looking vector instead (the tempting shortcut) would make every
 * pair of texts equally (un)related regardless of actual shared vocabulary,
 * which would make the golden retrieval dataset's vector-ranking
 * assertions (tests/fixtures/pr6.memory-retrieval-golden.ts) meaningless --
 * there would be nothing for cosine distance to actually measure.
 */
export function computeFeatureHashEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    // No valid token -- an honest all-zero vector, never a fabricated one.
    return vector;
  }
  return vector.map((value) => value / norm);
}

export interface FakeEmbeddingProviderOverrides {
  embed?: EmbeddingProvider["embed"];
}

export interface FakeEmbeddingProviderOptions {
  providerId?: string;
  modelId?: string;
}

/**
 * The long-term seam for every test double against EmbeddingProvider,
 * mirroring FakeLlmProvider's own "sane full implementation out of the box,
 * any method overridable per-instance for a specific scenario" convention
 * exactly. `new FakeEmbeddingProvider()` alone is a complete, working,
 * deterministic provider; pass `overrides.embed` only for tests that need
 * a specific failure/timeout scenario (provider-failure degradation,
 * hangs-for-timeout, etc.).
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;

  constructor(
    private readonly overrides: FakeEmbeddingProviderOverrides = {},
    options: FakeEmbeddingProviderOptions = {},
  ) {
    this.providerId = options.providerId ?? "fake";
    this.modelId = options.modelId ?? "fake-token-hash-embedding-v1";
    // Deliberately not overridable via options -- runEmbedding() always
    // requests a specific dimensions count via EmbeddingInput.dimensions,
    // and this provider must honor whatever it's actually asked for on
    // each call, the same contract the real OpenAI provider has.
    this.dimensions = 1536;
  }

  async embed(input: EmbeddingInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.embed) {
      return this.overrides.embed(input, timeoutMs);
    }

    const embedding = computeFeatureHashEmbedding(input.text, input.dimensions);
    const usage: ProviderUsage = { inputTokens: tokenize(input.text).length };
    return {
      output: { embedding, model: this.modelId, dimensions: embedding.length },
      usage,
      resolvedModel: this.modelId,
    };
  }
}
