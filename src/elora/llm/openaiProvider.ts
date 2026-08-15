import OpenAI from "openai";
import { ELORA_ROUTES } from "../types.js";
import { buildPrompt } from "./anthropicProvider.js";
import { ModelOperationIncompleteOutputError, ModelOperationRefusalError } from "./errors.js";
import type {
  CritiqueInput,
  ExtractionInput,
  IntentInterpretationInput,
  LlmProvider,
  LlmResponseContext,
  PlanningInput,
  ProviderOperationCallResult,
  ProviderUsage,
  RerankingInput,
} from "./types.js";

// Fast, cost-optimized tier -- not a heavy-reasoning use case, matching
// AnthropicProvider's own "fast, low-latency" rationale for generateResponse.
// Verified current as of implementation time against developers.openai.com's
// live model catalog, not hardcoded from memory: gpt-5.6-luna is documented
// as "optimized for cost-sensitive workloads," the Responses-API-era
// equivalent tier to Claude Haiku 4.5's role in anthropicProvider.ts.
const MODEL = "gpt-5.6-luna";

// PR 3, locked decision: CORE -- not the provider SDK -- owns retry policy,
// attempt numbering, and evidence. Left at its default (2), a single
// logical attempt CORE records as one model_invocations row could
// correspond to up to three real external HTTP requests the SDK made
// invisibly, directly undermining PR 2's invocation_key/attempt_number
// evidence model. Set on every client construction below, not just one.
const MAX_RETRIES = 0;

/**
 * Shared client construction -- every one of the six methods below builds
 * its own client, mirroring AnthropicProvider's exact per-call
 * construction pattern (never held on `this`). This is what makes provider
 * selection genuinely lazy: constructing `new OpenAIProvider(apiKey)`
 * touches nothing until a method actually runs, so selecting Anthropic
 * never requires OPENAI_API_KEY to be set, and vice versa
 * (providerSelection.ts relies on exactly this).
 *
 * maxRetries: 0 and an explicit timeout are both set here, on every call --
 * timeout mirrors the exact reasoning already in executeModelOperation.ts's
 * raceWithTimeout comment: CORE's race is what guarantees the executor
 * itself never waits past timeoutMs, but the provider should still be told
 * to abort its own in-flight request too, not left running invisibly after
 * CORE has already returned a TIMEOUT result. logLevel: "warn" -- debug
 * logging can include request/response bodies, never appropriate here.
 */
function buildClient(apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({ apiKey, maxRetries: MAX_RETRIES, timeout: timeoutMs, logLevel: "warn" });
}

const JSON_ONLY_DEVELOPER_PREFIX =
  "You are responding as part of an automated system. Respond only with the structured JSON output requested -- no prose outside the structured response.";

type JsonSchema = Record<string, unknown>;

const INTENT_INTERPRETATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    route: { type: "string", enum: [...ELORA_ROUTES] },
    interpretedIntent: { type: "string" },
    confidence: { type: "number" },
    taskDomain: { type: ["string", "null"] },
    requestedCapabilities: { type: "array", items: { type: "string" } },
    proposedDelegationTarget: { type: ["string", "null"] },
    requiresDurableWork: { type: "boolean" },
    proposedToolNeeds: { type: "array", items: { type: "string" } },
    externalSideEffect: { type: "boolean" },
    requiresClarification: { type: "boolean" },
    clarifyingQuestion: { type: ["string", "null"] },
  },
  required: [
    "route",
    "interpretedIntent",
    "confidence",
    "taskDomain",
    "requestedCapabilities",
    "proposedDelegationTarget",
    "requiresDurableWork",
    "proposedToolNeeds",
    "externalSideEffect",
    "requiresClarification",
    "clarifyingQuestion",
  ],
  additionalProperties: false,
};

const PLANNING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          // OpenAI strict mode requires every property in `required`;
          // optional fields are simulated via a nullable type instead --
          // normalized back to an absent key below so Zod's own
          // `.optional()` (which accepts undefined, not null) validates.
          rationale: { type: ["string", "null"] },
        },
        required: ["description", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
};

const CRITIQUE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise", "reject"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["description", "severity"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["verdict", "issues", "summary"],
  additionalProperties: false,
};

/** Extraction's schema is genuinely input-dependent -- one property per caller-requested field, unlike the other four operations' fixed shapes. */
function buildExtractionSchema(fields: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      values: {
        type: "object",
        properties: Object.fromEntries(fields.map((field) => [field, { type: ["string", "number", "boolean", "null"] }])),
        required: [...fields],
        additionalProperties: false,
      },
    },
    required: ["values"],
    additionalProperties: false,
  };
}

const RERANKING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    rankedCandidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          rank: { type: "integer" },
        },
        required: ["candidateId", "rank"],
        additionalProperties: false,
      },
    },
  },
  required: ["rankedCandidates"],
  additionalProperties: false,
};

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * Shared call path for all five PR 2 structured operations, via the
 * Responses API's provider-native structured output (text.format,
 * type "json_schema") as a first pass -- executeModelOperation.ts's
 * existing Zod validation remains the sole authoritative boundary;
 * provider-side parsing reduces malformed responses, it does not replace
 * CORE's own validation. store: false on every request (OpenAI-specific
 * privacy hardening, locked decision).
 *
 * Detects the three OpenAI-specific terminal conditions that get their own
 * ModelOperationErrorKind: refusal (an output content item with type
 * "refusal"), incomplete output (status "incomplete", covering both
 * max_output_tokens and content_filter), and missing/empty parsed output
 * (treated as a degenerate incomplete case). Every other terminal condition
 * (429, 500, auth failure, aborted request, provider-side "failed" status)
 * is left to propagate as a raw error -- executeModelOperation.ts's
 * existing generic PROVIDER_FAILURE classification already gives each a
 * distinct, meaningful error_class via openai-node's own typed error
 * classes (RateLimitError, InternalServerError, AuthenticationError,
 * APIUserAbortError, ...), no per-status-code handling needed here.
 */
async function callStructuredOperation(
  client: OpenAI,
  operationKind: string,
  developerPrompt: string,
  userPrompt: string,
  schemaName: string,
  schema: JsonSchema,
  timeoutMs: number,
): Promise<ProviderOperationCallResult> {
  const { data: response, response: httpResponse } = await client.responses
    .create(
      {
        model: MODEL,
        input: [
          { role: "developer", content: `${JSON_ONLY_DEVELOPER_PREFIX}\n\n${developerPrompt}` },
          { role: "user", content: userPrompt },
        ],
        text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
        store: false,
      },
      { timeout: timeoutMs },
    )
    .withResponse();

  if (response.status === "failed") {
    throw new Error(response.error?.message ?? `OpenAI response for "${operationKind}" failed`);
  }
  if (response.status === "incomplete") {
    throw new ModelOperationIncompleteOutputError(operationKind, response.incomplete_details?.reason ?? "unknown reason");
  }

  const messageItem = response.output?.find((item): item is Extract<typeof item, { type: "message" }> => item.type === "message");
  const contentItem = messageItem?.content?.[0];

  if (contentItem?.type === "refusal") {
    throw new ModelOperationRefusalError(operationKind, contentItem.refusal);
  }
  if (!contentItem || contentItem.type !== "output_text" || contentItem.text.trim().length === 0) {
    throw new ModelOperationIncompleteOutputError(operationKind, "missing or empty parsed output");
  }

  let output: unknown;
  try {
    output = JSON.parse(contentItem.text);
  } catch {
    output = {};
  }

  const usage = response.usage as ResponsesUsage | undefined;
  const providerUsage: ProviderUsage = {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadInputTokens: usage?.input_tokens_details?.cached_tokens,
    raw: usage ? { ...usage } : undefined,
  };

  return {
    output,
    usage: providerUsage,
    providerRequestId: httpResponse.headers.get("x-request-id") ?? undefined,
    providerResponseId: response.id,
    resolvedModel: response.model,
  };
}

/** Removes a null-valued `rationale` key so it reads as absent to Zod's `.optional()` (which accepts undefined, not null) -- OpenAI strict mode returns null for the one optional field this operation's schema has. */
function normalizePlanningOutput(output: unknown): unknown {
  if (output === null || typeof output !== "object" || !("steps" in output) || !Array.isArray((output as { steps: unknown }).steps)) {
    return output;
  }
  const steps = (output as { steps: unknown[] }).steps.map((step) => {
    if (step === null || typeof step !== "object") return step;
    const { rationale, ...rest } = step as Record<string, unknown>;
    return rationale === null ? rest : { ...rest, rationale };
  });
  return { ...(output as Record<string, unknown>), steps };
}

/**
 * Second real LlmProvider implementation -- proves provider-neutrality:
 * this passes the exact same conformance suite AnthropicProvider does.
 * Same per-call client construction pattern, same "executeModelOperation.ts
 * is the sole validator" boundary.
 */
export class OpenAIProvider implements LlmProvider {
  readonly providerId = "openai";
  readonly modelId = MODEL;

  constructor(private readonly apiKey: string) {}

  async generateResponse(context: LlmResponseContext, timeoutMs: number): Promise<string> {
    const client = buildClient(this.apiKey, timeoutMs);
    // Reuses the exact same prompt-building logic as AnthropicProvider,
    // via LlmResponseContext -- no duplicate prompt-authoring surface.
    const { system, user } = buildPrompt(context);

    const { data: response } = await client.responses
      .create(
        {
          model: MODEL,
          input: [
            { role: "developer", content: system },
            { role: "user", content: user },
          ],
          store: false,
        },
        { timeout: timeoutMs },
      )
      .withResponse();

    if (response.status === "failed" || response.status === "incomplete") {
      return "";
    }
    const messageItem = response.output?.find((item): item is Extract<typeof item, { type: "message" }> => item.type === "message");
    const contentItem = messageItem?.content?.[0];
    return contentItem?.type === "output_text" ? contentItem.text.trim() : "";
  }

  async interpretIntent(input: IntentInterpretationInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);
    const developerPrompt = [
      "You are ELORA's conversational router: a structured intent classifier that proposes a route for an internal task-routing system. You do not decide the final route yourself -- deterministic code validates and may override your proposal, especially for safety-critical cases.",
      `route must be exactly one of the schema's enumerated values. Prefer "converse"/"direct_answer"/"clarify" for ordinary conversation and questions -- reserve "durable_work"/"delegate"/"consequential_action" for requests that genuinely describe multi-step tracked work, handing work to another specialist, or a real external side effect.`,
    ].join("\n");
    const userPrompt = input.threadContext
      ? `Thread context:\n${input.threadContext}\n\nClassify this request:\n"${input.content}"`
      : `Classify this request:\n"${input.content}"`;
    return callStructuredOperation(client, "intent_interpretation", developerPrompt, userPrompt, "intent_interpretation", INTENT_INTERPRETATION_SCHEMA, timeoutMs);
  }

  async plan(input: PlanningInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);
    const developerPrompt = "You are a planning assistant that decomposes an objective into concrete steps. steps must contain at least one entry.";
    const userPrompt = [
      `Objective: ${input.objective}`,
      input.context ? `Context: ${input.context}` : null,
      "Produce a concrete step-by-step plan for this objective.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    const result = await callStructuredOperation(client, "planning", developerPrompt, userPrompt, "planning", PLANNING_SCHEMA, timeoutMs);
    return { ...result, output: normalizePlanningOutput(result.output) };
  }

  async critique(input: CritiqueInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);
    const developerPrompt = "You are a critical reviewer evaluating a subject against a set of criteria.";
    const userPrompt = [
      `Subject to review:\n${input.subject}`,
      input.criteria && input.criteria.length > 0 ? `Criteria:\n${input.criteria.map((criterion) => `- ${criterion}`).join("\n")}` : null,
      "Evaluate the subject and produce your verdict.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return callStructuredOperation(client, "critique", developerPrompt, userPrompt, "critique", CRITIQUE_SCHEMA, timeoutMs);
  }

  async extract(input: ExtractionInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);
    const developerPrompt = [
      "You extract specific fields of structured data from unstructured content.",
      "Use null for a field that genuinely cannot be found in the content -- never a guessed or fabricated value.",
    ].join("\n");
    const userPrompt = [`Fields to extract: ${input.fields.join(", ")}`, `Content:\n${input.content}`].join("\n");
    return callStructuredOperation(client, "extraction", developerPrompt, userPrompt, "extraction", buildExtractionSchema(input.fields), timeoutMs);
  }

  async rerank(input: RerankingInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = buildClient(this.apiKey, timeoutMs);
    const developerPrompt = [
      "You rerank a list of candidates by relevance to a query.",
      "candidateId must be exactly one of the candidate ids given -- never invent a new id, never omit or duplicate one you were given.",
      input.maximumResults ? `Return at most ${input.maximumResults} ranked candidates.` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    const userPrompt = [
      `Query: ${input.query}`,
      "Candidates:",
      ...input.candidates.map((candidate) => `- id: ${candidate.id}\n  content: ${candidate.content}`),
    ].join("\n");
    return callStructuredOperation(client, "reranking", developerPrompt, userPrompt, "reranking", RERANKING_SCHEMA, timeoutMs);
  }
}
