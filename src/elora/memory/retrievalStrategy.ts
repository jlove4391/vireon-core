/**
 * PR 6 §21: the memory retrieval feature flag. "deterministic" (the
 * pre-existing token/ILIKE path, retrieveRelevantMemory.ts) remains the
 * default and requires no OpenAI configuration at all. "hybrid" enables
 * FTS + OpenAI embeddings + pgvector + RRF (retrieveHybridMemory.ts).
 */
export const MEMORY_RETRIEVAL_STRATEGIES = ["deterministic", "hybrid"] as const;
export type MemoryRetrievalStrategy = (typeof MEMORY_RETRIEVAL_STRATEGIES)[number];

export class InvalidMemoryRetrievalStrategyError extends Error {
  constructor(public readonly rawValue: string) {
    super(
      `MEMORY_RETRIEVAL_STRATEGY must be unset, "deterministic", or "hybrid" -- got: ${JSON.stringify(rawValue)}`,
    );
    this.name = "InvalidMemoryRetrievalStrategyError";
  }
}

/**
 * Unset defaults to "deterministic" -- the safe, zero-configuration
 * behavior this codebase has always had. An explicit but unrecognized
 * value fails closed with a typed error rather than silently falling back
 * to the default; only the *absence* of the variable gets the default.
 */
export function readMemoryRetrievalStrategyFromEnv(): MemoryRetrievalStrategy {
  const raw = process.env.MEMORY_RETRIEVAL_STRATEGY;
  if (raw === undefined || raw === "") {
    return "deterministic";
  }
  if (raw !== "deterministic" && raw !== "hybrid") {
    throw new InvalidMemoryRetrievalStrategyError(raw);
  }
  return raw;
}
