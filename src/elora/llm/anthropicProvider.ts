import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmResponseContext } from "./types.js";

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

  const userLines = [
    `Original request: "${boundedUserMessage}"`,
    `Task type: ${context.taskType}`,
    `Decided outcome: ${context.authorityOutcome}`,
    `Reason: ${context.reason}`,
    `Final status: ${context.finalWorkOrderStatus}`,
  ];

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

/**
 * The only real LlmProvider implementation for Phase 6F. Uses a dedicated
 * ANTHROPIC_API_KEY -- never a VITE_*-prefixed variable, never read
 * anywhere in apps/web, server-side only.
 */
export class AnthropicProvider implements LlmProvider {
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
}
