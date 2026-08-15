import { z } from "zod";
import type { PersonaConfig } from "@vireon/persona-config";
import type { AuthorityOutcome } from "../../shared/runtimeTypes.js";
import type { WorkOrderStatus } from "../../state/workOrderState.js";
import { ELORA_ROUTES } from "../types.js";

export interface LlmResponseContext {
  /**
   * Prep Pass (Persona Identity Consolidation): the full, canonical
   * PersonaConfig, not a backend-only voice-profile subset. buildPrompt()
   * only ever reads the prompt-relevant fields (name, formalTitle,
   * corporateRole, voiceTone, pronouns) off of it -- the extra fields
   * (crestAssetPath, accentColor, etc.) simply go unused here, same
   * acceptable "one complete type, not every field read by every
   * consumer" pattern 6E's EloraMessageResponseSchema already established.
   */
  persona: PersonaConfig;
  userMessageContent: string;
  taskType: string;
  /**
   * PR 4: optional -- absent on the informational cognitive-run path, which
   * has no WorkOrder and therefore no authority decision to report. Never
   * fabricate a value to satisfy this field; omit it instead. buildPrompt()
   * (anthropicProvider.ts) omits the "Decided outcome" prompt line entirely
   * when this is absent, rather than interpolating a placeholder.
   */
  authorityOutcome?: AuthorityOutcome;
  reason: string;
  /** PR 4: optional for the same reason as authorityOutcome above -- see that field's doc comment. */
  finalWorkOrderStatus?: WorkOrderStatus;
  toolResult?: { toolName: string; artifactFilename?: string } | null;
  retrievedMemorySnippets: string[];
}

// PR 2: input schemas for the five new structured operations. Declared here
// (not in their own operations/*.ts files) specifically so LlmProvider's
// method signatures below can reference them without a circular import --
// operations/*.ts files import these types type-only from this module and
// define their own OUTPUT schema locally (the interface only ever returns
// Promise<unknown> for these five methods; output shape is never part of
// the provider contract itself, only of what executeModelOperation.ts
// validates afterward). Each operations/*.ts file re-exports its input
// schema alongside its own output schema, so from a caller's perspective
// each operation still has one place to import both from.

export const IntentInterpretationInputSchema = z.object({
  content: z.string().min(1),
  /**
   * ADR 0008 §6: bounded thread context (recent messages/summary/retrieved
   * memory/current turn), assembled by Realignment A's thread-context
   * helper. Optional and unused by this schema's shape today -- declared
   * now so Realignment A's wiring slice doesn't need a second schema
   * change to add it.
   */
  threadContext: z.string().optional(),
});
export type IntentInterpretationInput = z.infer<typeof IntentInterpretationInputSchema>;

// ADR 0008 §2: reuses ELORA_ROUTES (src/elora/types.ts) rather than
// redeclaring a parallel enum. The model proposes a route plus the richer
// interpretation fields; resolveEloraRoute.ts's deterministic policy makes
// the final routing decision (ELORA.md §19: no LLM output reaches the
// database, or any safety-critical branch, unvalidated) -- same
// model-proposes/code-decides split classifyAuthority.ts already
// established for authority outcomes.
export const IntentInterpretationOutputSchema = z.object({
  route: z.enum(ELORA_ROUTES),
  interpretedIntent: z.string().min(1),
  confidence: z.number().min(0).max(1),
  taskDomain: z.string().nullable(),
  requestedCapabilities: z.array(z.string()),
  proposedDelegationTarget: z.string().nullable(),
  requiresDurableWork: z.boolean(),
  proposedToolNeeds: z.array(z.string()),
  externalSideEffect: z.boolean(),
  requiresClarification: z.boolean(),
  clarifyingQuestion: z.string().nullable(),
});
export type IntentInterpretationOutput = z.infer<typeof IntentInterpretationOutputSchema>;

export const PlanningInputSchema = z.object({
  objective: z.string().min(1),
  context: z.string().optional(),
});
export type PlanningInput = z.infer<typeof PlanningInputSchema>;

export const PlanningOutputSchema = z.object({
  steps: z
    .array(
      z.object({
        description: z.string().min(1),
        rationale: z.string().optional(),
      }),
    )
    .min(1),
});
export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;

export const CritiqueInputSchema = z.object({
  subject: z.string().min(1),
  criteria: z.array(z.string().min(1)).optional(),
});
export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;

export const CritiqueOutputSchema = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  issues: z.array(
    z.object({
      description: z.string().min(1),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  summary: z.string().min(1),
});
export type CritiqueOutput = z.infer<typeof CritiqueOutputSchema>;

export const ExtractionInputSchema = z.object({
  content: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;

export const ExtractionOutputSchema = z.object({
  values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// Deliberately retrieval-agnostic contract (locked decision): no vector
// similarity scores, no database identifiers beyond the opaque `id` the
// caller provided, no embedding-model metadata, no memory-tier assumptions,
// no retrieval-source-specific fields. Those decisions belong to PR 6
// (hybrid retrieval); this contract must not assume or encode them.
export const RerankingInputSchema = z.object({
  query: z.string().min(1),
  candidates: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string(),
      }),
    )
    .min(1),
  maximumResults: z.number().int().positive().optional(),
});
export type RerankingInput = z.infer<typeof RerankingInputSchema>;

// Base shape only -- reranking.ts builds the real, input-aware output
// schema (rejecting unknown/duplicate candidate ids) via a function of the
// input, since that validation genuinely depends on which candidate ids
// were actually supplied for this call.
export const RerankingOutputSchema = z.object({
  rankedCandidates: z.array(
    z.object({
      candidateId: z.string().min(1),
      rank: z.number().int().positive(),
    }),
  ),
});
export type RerankingOutput = z.infer<typeof RerankingOutputSchema>;

export const ResponseSynthesisOutputSchema = z.object({
  responseText: z.string(),
});
export type ResponseSynthesisOutput = z.infer<typeof ResponseSynthesisOutputSchema>;

// PR 6: query embedding happens during memory retrieval, before a
// cognitive run necessarily exists (PR 4 creates the informational run
// afterward) -- "memory_document" is the other purpose, used when embedding
// a memory_record_versions row for storage. OpenAI itself exposes no
// separate query/document embedding modes; `purpose` is durable operation
// context for audit/evaluation, not a parameter that changes the provider
// call.
export const EmbeddingInputSchema = z.object({
  text: z.string().min(1),
  purpose: z.enum(["query", "memory_document"]),
  dimensions: z.number().int().positive(),
});
export type EmbeddingInput = z.infer<typeof EmbeddingInputSchema>;

export const EmbeddingOutputSchema = z.object({
  embedding: z.array(z.number().finite()),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
});
export type EmbeddingOutput = z.infer<typeof EmbeddingOutputSchema>;

/**
 * PR 6 §5.1: the minimal identity every model-operation provider must
 * supply for evidence recording (executeModelOperation.ts's
 * insertStartedRow only ever reads providerId/modelId off of whatever
 * provider it's given). LlmProvider extends this rather than the executor
 * depending on LlmProvider's full six-method chat/structured-operation
 * surface -- EmbeddingProvider (embeddingProvider.ts) implements this same
 * minimal contract without pretending to support generateResponse/
 * interpretIntent/plan/critique/extract/rerank, which it genuinely does not
 * and never will (OpenAI has no chat completion role to play here; embedding
 * is its own axis, see providerSelection.ts's own doc comment on why this
 * is deliberately not reused).
 */
export interface ModelOperationProvider {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * Token usage for one provider call, in the shape migrations/0014's
 * model_invocations columns expect. All optional -- a provider (or the
 * fake provider) that doesn't report a given figure simply omits it,
 * recorded as NULL, not a fabricated 0. `raw` is the provider_usage jsonb
 * catch-all for provider-specific data that doesn't map to the four named
 * columns (e.g. Anthropic's per-TTL cache-write breakdown).
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  raw?: Record<string, unknown>;
}

/** Raw provider output plus whatever usage the provider reported for that one call. */
export interface ProviderOperationCallResult {
  output: unknown;
  usage: ProviderUsage;
  /**
   * PR 3: provider-side correlation ids and the actually-resolved model,
   * when the provider reports them (migrations/0015's provider_request_id/
   * provider_response_id/resolved_model columns). Optional -- generateResponse's
   * pre-existing Anthropic call path doesn't populate these; they stay NULL
   * on those rows, not a gap unique to any one provider.
   */
  providerRequestId?: string;
  providerResponseId?: string;
  resolvedModel?: string;
}

/**
 * Thin, swappable provider interface. Anthropic is the only real
 * implementation (Phase 6F's generateResponse, PR 2's five new
 * operations); the interface itself is provider-agnostic on purpose -- a
 * future move to a different or self-hosted model is a new file
 * implementing this interface, not a rewrite of every call site.
 *
 * PR 2: five new methods, one per structured operation beyond response
 * synthesis. Every method beyond generateResponse returns a raw,
 * unvalidated `output` plus whatever usage the provider reported --
 * src/elora/llm/executeModelOperation.ts is the sole place that validates
 * a provider's raw output against the calling operation's Zod output
 * schema; putting a typed return here would mean either duplicating that
 * validation inside every provider implementation, or trusting an
 * unvalidated cast at the interface boundary. generateResponse itself is
 * unmodified (Phase 6F, still returns a plain string, no usage reporting)
 * -- responseSynthesis.ts's model_invocations rows carry null usage
 * columns as a result, a documented limitation of adapting a pre-existing,
 * intentionally-untouched method rather than a gap unique to this
 * operation.
 *
 * providerId/modelId identify which concrete provider/model instance
 * produced a given call, for src/elora/llm/executeModelOperation.ts to
 * record on the model_invocations row -- not chosen per-operation-call, a
 * property of the provider instance itself. AnthropicProvider currently
 * uses the same model (Claude Haiku 4.5) for every operation, reusing the
 * existing Phase 6F model choice rather than inventing a new per-operation
 * model/quality tradeoff the handoff never asked for.
 */
export interface LlmProvider extends ModelOperationProvider {
  generateResponse(context: LlmResponseContext, timeoutMs: number): Promise<string>;
  interpretIntent(input: IntentInterpretationInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
  plan(input: PlanningInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
  critique(input: CritiqueInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
  extract(input: ExtractionInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
  rerank(input: RerankingInput, timeoutMs: number): Promise<ProviderOperationCallResult>;
}
