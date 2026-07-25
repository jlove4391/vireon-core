import type { PersonaConfig } from "@vireon/persona-config";
import type { AuthorityOutcome } from "../../shared/runtimeTypes.js";
import type { WorkOrderStatus } from "../../state/workOrderState.js";

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
  authorityOutcome: AuthorityOutcome;
  reason: string;
  finalWorkOrderStatus: WorkOrderStatus;
  toolResult?: { toolName: string; artifactFilename?: string } | null;
  retrievedMemorySnippets: string[];
}

/**
 * Thin, swappable provider interface. Anthropic is the only implementation
 * built in Phase 6F, but the interface itself is provider-agnostic on
 * purpose -- a future move to a different or self-hosted model is a new
 * file implementing this interface, not a rewrite of every call site.
 */
export interface LlmProvider {
  generateResponse(context: LlmResponseContext, timeoutMs: number): Promise<string>;
}
