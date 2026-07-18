import type { AuthorityOutcome } from "../../shared/runtimeTypes.js";
import type { WorkOrderStatus } from "../../state/workOrderState.js";

/**
 * The prompt-relevant subset of a persona's identity -- deliberately not
 * the frontend's PersonaConfig (apps/web/src/lib/personaConfig.ts), which
 * also carries UI-only fields (crestAssetPath, accentColor) the backend has
 * no use for and must not depend on apps/web to get. Backend-owned mirrors
 * live in personaVoiceProfiles.ts, same deliberate-duplication precedent
 * 6E established for packages/contracts's enums.
 */
export interface LlmPersonaVoiceProfile {
  name: string;
  formalTitle: string;
  corporateRole: string;
  voiceTone: string[];
  pronouns: string;
}

export interface LlmResponseContext {
  persona: LlmPersonaVoiceProfile;
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
