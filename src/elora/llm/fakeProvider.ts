import type {
  CritiqueInput,
  ExtractionInput,
  IntentInterpretationInput,
  LlmProvider,
  LlmResponseContext,
  PlanningInput,
  ProviderOperationCallResult,
  RerankingInput,
} from "./types.js";

export interface FakeLlmProviderOverrides {
  generateResponse?: LlmProvider["generateResponse"];
  interpretIntent?: LlmProvider["interpretIntent"];
  plan?: LlmProvider["plan"];
  critique?: LlmProvider["critique"];
  extract?: LlmProvider["extract"];
  rerank?: LlmProvider["rerank"];
}

export interface FakeLlmProviderOptions {
  providerId?: string;
  modelId?: string;
}

/**
 * The single, long-term seam for every test double against LlmProvider
 * (locked decision) -- a full, sane implementation of every method out of
 * the box, with any subset overridable per-instance for a specific
 * scenario (malformed output, a hang past timeoutMs, a thrown provider
 * error, etc.). `new FakeLlmProvider()` alone is a complete, working
 * provider; pass `overrides` only for the methods a given test actually
 * needs to behave differently.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly providerId: string;
  readonly modelId: string;

  constructor(
    private readonly overrides: FakeLlmProviderOverrides = {},
    options: FakeLlmProviderOptions = {},
  ) {
    this.providerId = options.providerId ?? "fake";
    this.modelId = options.modelId ?? "fake-model";
  }

  async generateResponse(context: LlmResponseContext, timeoutMs: number): Promise<string> {
    if (this.overrides.generateResponse) {
      return this.overrides.generateResponse(context, timeoutMs);
    }
    return "A real, sane in-character reply.";
  }

  async interpretIntent(input: IntentInterpretationInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.interpretIntent) {
      return this.overrides.interpretIntent(input, timeoutMs);
    }
    return {
      output: {
        route: "converse",
        interpretedIntent: input.content.slice(0, 200),
        confidence: 0.8,
        taskDomain: null,
        requestedCapabilities: [],
        proposedDelegationTarget: null,
        requiresDurableWork: false,
        proposedToolNeeds: [],
        externalSideEffect: false,
        requiresClarification: false,
        clarifyingQuestion: null,
      },
      usage: { inputTokens: 42, outputTokens: 12 },
    };
  }

  async plan(input: PlanningInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.plan) {
      return this.overrides.plan(input, timeoutMs);
    }
    return {
      output: {
        steps: [{ description: `Fake step for objective: ${input.objective}`, rationale: "fake rationale" }],
      },
      usage: { inputTokens: 30, outputTokens: 20 },
    };
  }

  async critique(input: CritiqueInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.critique) {
      return this.overrides.critique(input, timeoutMs);
    }
    return {
      output: {
        verdict: "approve",
        issues: [],
        summary: `Fake critique of: ${input.subject}`,
      },
      usage: { inputTokens: 25, outputTokens: 15 },
    };
  }

  async extract(input: ExtractionInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.extract) {
      return this.overrides.extract(input, timeoutMs);
    }
    return {
      output: {
        values: Object.fromEntries(input.fields.map((field) => [field, `fake-${field}`])),
      },
      usage: { inputTokens: 20, outputTokens: 10 },
    };
  }

  async rerank(input: RerankingInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    if (this.overrides.rerank) {
      return this.overrides.rerank(input, timeoutMs);
    }
    return {
      output: {
        rankedCandidates: input.candidates.map((candidate, index) => ({
          candidateId: candidate.id,
          rank: index + 1,
        })),
      },
      usage: { inputTokens: 15, outputTokens: 8 },
    };
  }
}
