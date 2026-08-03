import Anthropic from "@anthropic-ai/sdk";
import { ELORA_INTENT_TYPES, ELORA_TASK_TYPES } from "../types.js";
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

// Fast, low-latency conversational response generation -- not a
// heavy-reasoning use case. Confirmed against current Anthropic model
// documentation at implementation time (Phase 6F Step 0), not hardcoded
// from memory: Claude Haiku 4.5 is documented as "the fastest model with
// near-frontier intelligence," comparative latency "Fastest" among current
// models. Dated snapshot id, not the bare alias, per Anthropic's own
// pinned-snapshot guidance.
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

// 6H §5.4: token budget / context isolation, decided as a small addition at
// this one call site -- not a reusable per-persona execution-context
// primitive (no second concurrent persona execution exists in any live
// path yet to generalize against; extend when one does). A rough,
// character-based ceiling, not a real tokenizer -- the decision explicitly
// scoped this small, not a heavier tokenizer dependency. The user-message
// side of the prompt is the only genuinely unbounded input (persona fields
// are fixed constants, retrievedMemorySnippets is already capped at 5
// records x 200 chars by the caller).
//
// PR #19 review fix: this bounds ONLY the raw userMessageContent component,
// applied before it's embedded in the "Original request" line and joined
// with the fixed-size control fields (task type, decided outcome, reason,
// final status, closing instruction). Bounding the fully-assembled joined
// string instead -- the original version of this code -- meant a long
// enough user message truncated the string before any of those fixed
// fields were even reached, silently dropping the decided authority
// outcome and the closing instruction from what the model actually sees.
//
// 100,000 chars is a deliberate fraction of Claude Haiku 4.5's 200k-token
// context window, not an arbitrary small number: at a conservative ~4
// chars/token, 100,000 chars is roughly 25,000 tokens -- about an eighth
// of the window -- leaving generous headroom for the system prompt
// (persona fields), retrieved memory snippets, and the model's own
// response budget (MAX_TOKENS), none of which should ever be crowded out
// by a single user message.
const MAX_USER_MESSAGE_CHARS = 100_000;

function boundToTokenBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated, ${text.length} chars total, over the ${maxChars}-char prompt budget]`;
}

/**
 * Generic, persona-driven prompt construction -- never a hardcoded
 * reference to "Elora" in this function. Same discipline PersonaConsole.tsx
 * was already built with in 6A, now applied to the LLM layer.
 *
 * Truthfulness constraints (§5.2): state only what has actually, already
 * happened or been decided; never claim an action occurred that didn't;
 * never imply an escalation has already been approved; never invent
 * details beyond what's supplied. Direct extension of the same
 * truthfulness principle already established for the UI's action cards
 * ("no simulated typing, no fake tool progress, no invented substeps"),
 * now applied to model-generated text instead of hand-written templates.
 */
export function buildPrompt(context: LlmResponseContext): { system: string; user: string } {
  const { persona } = context;

  const system = [
    `You are ${persona.name}, ${persona.formalTitle}, ${persona.corporateRole}. Pronouns: ${persona.pronouns}.`,
    `Voice and tone: ${persona.voiceTone.join(", ")}. Respond in character, using this voice and tone.`,
    "",
    "You are narrating the outcome of a request that has ALREADY been fully decided by deterministic system logic, not by you. Your only job is to describe what already happened or was already decided, in one short, natural, in-character reply.",
    "",
    "Strict truthfulness rules:",
    "- State only what has actually, already happened or been decided. Do not invent, embellish, or imply anything beyond the facts given to you below.",
    "- Never claim an action occurred that didn't. Never imply an escalation, approval, or authorization has already happened if it hasn't.",
    "- Never invent details -- no fake tool output, no fake file contents, no fabricated next steps beyond what's stated.",
    "- Keep the reply concise: a few sentences at most.",
  ].join("\n");

  const boundedUserMessage = boundToTokenBudget(context.userMessageContent, MAX_USER_MESSAGE_CHARS);

  // PR 4: authorityOutcome/finalWorkOrderStatus are optional on
  // LlmResponseContext (no WorkOrder or authority decision exists on the
  // informational cognitive-run path) -- their lines are omitted entirely
  // when absent, never replaced with a placeholder like "undefined" or
  // "N/A", so the prompt never implies a decision was made where none was.
  // When both are present (every existing WorkOrder-path caller), this
  // produces the exact same lines in the exact same order as before.
  const userLines = [`Original request: "${boundedUserMessage}"`, `Task type: ${context.taskType}`];
  if (context.authorityOutcome !== undefined) {
    userLines.push(`Decided outcome: ${context.authorityOutcome}`);
  }
  userLines.push(`Reason: ${context.reason}`);
  if (context.finalWorkOrderStatus !== undefined) {
    userLines.push(`Final status: ${context.finalWorkOrderStatus}`);
  }

  if (context.toolResult) {
    userLines.push(
      `Tool used: ${context.toolResult.toolName}` +
        (context.toolResult.artifactFilename ? ` (artifact: ${context.toolResult.artifactFilename})` : ""),
    );
  }

  if (context.retrievedMemorySnippets.length > 0) {
    userLines.push(`Relevant prior context you may reference: ${context.retrievedMemorySnippets.join(" | ")}`);
  }

  userLines.push("Write the in-character reply now, describing only the above.");

  return { system, user: userLines.join("\n") };
}

// PR 2: max_tokens budget for the five new structured operations. Higher
// than MAX_TOKENS (conversational replies are "a few sentences at most" --
// see buildPrompt's own system prompt) since a plan/critique/extraction
// response is real structured JSON, not a short reply.
const STRUCTURED_MAX_TOKENS = 4096;

const JSON_ONLY_INSTRUCTION =
  "Respond with ONLY a single valid JSON object matching the shape below -- no markdown code fences, no commentary before or after, no trailing text of any kind.";

/**
 * Shared call path for all five PR 2 structured operations: sends a
 * JSON-only prompt, parses the response text as JSON (raw parse only --
 * src/elora/llm/executeModelOperation.ts is the sole place that validates
 * this against the calling operation's Zod output schema, not here), and
 * extracts whatever usage Anthropic reported. Malformed JSON becomes an
 * empty object rather than a thrown parse error -- every operation's
 * output schema requires at least one real field, so `{}` reliably fails
 * validation there and surfaces as INVALID_OUTPUT, the correct
 * classification for "the provider responded, but not usefully."
 */
async function callStructuredOperation(
  client: Anthropic,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<ProviderOperationCallResult> {
  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: STRUCTURED_MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    },
    { timeout: timeoutMs },
  );

  const textBlock = response.content.find((block) => block.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

  let output: unknown;
  try {
    output = JSON.parse(rawText);
  } catch {
    output = {};
  }

  const usage = response.usage as
    | (Anthropic.Usage & { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } })
    | undefined;

  const providerUsage: ProviderUsage = {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? undefined,
    raw: usage?.cache_creation ? { cache_creation: usage.cache_creation } : undefined,
  };

  return { output, usage: providerUsage };
}

/**
 * The only real LlmProvider implementation. Uses a dedicated
 * ANTHROPIC_API_KEY -- never a VITE_*-prefixed variable, never read
 * anywhere in apps/web, server-side only.
 *
 * PR 2: providerId/modelId identify this instance for
 * executeModelOperation.ts's model_invocations evidence. Every structured
 * operation reuses the same Claude Haiku 4.5 model Phase 6F already chose
 * for generateResponse -- picking a different, possibly more capable model
 * per operation is a real design decision the handoff never asked for,
 * left to a future, explicitly-scoped PR.
 */
export class AnthropicProvider implements LlmProvider {
  readonly providerId = "anthropic";
  readonly modelId = MODEL;

  constructor(private readonly apiKey: string) {}

  async generateResponse(context: LlmResponseContext, timeoutMs: number): Promise<string> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const { system, user } = buildPrompt(context);

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // 6H §5.5: system-string half of prompt caching only (decided --
        // no tool schemas are ever sent to a model in this codebase today;
        // tool selection is fully deterministic via dispatchTool.ts, so
        // there's nothing on that half to cache yet). system is built
        // purely from fixed persona fields (name/formalTitle/corporateRole/
        // pronouns/voiceTone) -- byte-identical across every call for a
        // given persona, never touched by per-call content -- so it's a
        // genuinely stable prefix, not merely typically-stable.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      },
      { timeout: timeoutMs },
    );

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  }

  async interpretIntent(input: IntentInterpretationInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const system = [
      "You are a structured intent classifier for an internal task-routing system.",
      JSON_ONLY_INSTRUCTION,
      "",
      `Shape: { "intentType": ${JSON.stringify(ELORA_INTENT_TYPES)}, "taskType": ${JSON.stringify(ELORA_TASK_TYPES)}, "confidence": number between 0 and 1, "summary": string }`,
      `intentType and taskType must each be exactly one of the listed values.`,
    ].join("\n");
    const user = `Classify this request:\n"${input.content}"`;
    return callStructuredOperation(client, system, user, timeoutMs);
  }

  async plan(input: PlanningInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const system = [
      "You are a planning assistant that decomposes an objective into concrete steps.",
      JSON_ONLY_INSTRUCTION,
      "",
      `Shape: { "steps": [{ "description": string, "rationale": string (optional) }] }`,
      "steps must contain at least one entry.",
    ].join("\n");
    const user = [
      `Objective: ${input.objective}`,
      input.context ? `Context: ${input.context}` : null,
      "Produce a concrete step-by-step plan for this objective.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return callStructuredOperation(client, system, user, timeoutMs);
  }

  async critique(input: CritiqueInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const system = [
      "You are a critical reviewer evaluating a subject against a set of criteria.",
      JSON_ONLY_INSTRUCTION,
      "",
      `Shape: { "verdict": "approve" | "revise" | "reject", "issues": [{ "description": string, "severity": "low" | "medium" | "high" }], "summary": string }`,
    ].join("\n");
    const user = [
      `Subject to review:\n${input.subject}`,
      input.criteria && input.criteria.length > 0 ? `Criteria:\n${input.criteria.map((c) => `- ${c}`).join("\n")}` : null,
      "Evaluate the subject and produce your verdict.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    return callStructuredOperation(client, system, user, timeoutMs);
  }

  async extract(input: ExtractionInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const system = [
      "You extract specific fields of structured data from unstructured content.",
      JSON_ONLY_INSTRUCTION,
      "",
      `Shape: { "values": { <each requested field name>: string | number | boolean | null } }`,
      "Every requested field must be a key in values. Use null for a field that genuinely cannot be found in the content -- never a guessed or fabricated value.",
    ].join("\n");
    const user = [`Fields to extract: ${input.fields.join(", ")}`, `Content:\n${input.content}`].join("\n");
    return callStructuredOperation(client, system, user, timeoutMs);
  }

  async rerank(input: RerankingInput, timeoutMs: number): Promise<ProviderOperationCallResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const system = [
      "You rerank a list of candidates by relevance to a query.",
      JSON_ONLY_INSTRUCTION,
      "",
      `Shape: { "rankedCandidates": [{ "candidateId": string, "rank": positive integer, 1 = most relevant }] }`,
      "candidateId must be exactly one of the candidate ids given below -- never invent a new id, never omit or duplicate one you were given.",
      input.maximumResults ? `Return at most ${input.maximumResults} ranked candidates.` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    const user = [
      `Query: ${input.query}`,
      "Candidates:",
      ...input.candidates.map((candidate) => `- id: ${candidate.id}\n  content: ${candidate.content}`),
    ].join("\n");
    return callStructuredOperation(client, system, user, timeoutMs);
  }
}
