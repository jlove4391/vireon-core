import type { DirectiveCompletionMode, TransitionDirectiveResult } from "./transitionDirective.js";
import { transitionDirective } from "./transitionDirective.js";

export interface CompleteDirectiveInput {
  tenantId: string;
  directiveId: string;
  actorId: string;
  reason: string;
  /** Passed straight through to transitionDirective() -- still required, still checked (system_validated still needs real provenance evidence). This wrapper does not relax that. */
  completionMode: DirectiveCompletionMode;
  metadata?: Record<string, unknown>;
}

/**
 * Named-verb wrapper over transitionDirective() -- see acceptDirective.ts
 * for the full rationale (mechanical only, no new graph/schema; tags
 * metadata.verb for audit-trail honesty; legality still enforced solely
 * by assertValidDirectiveTransition()). completionMode is still mandatory
 * and still substantiated exactly as transitionDirective() already does
 * for "system_validated" -- this wrapper only adds the verb tag and
 * hardcoded toState, nothing about the completion-mode check changes.
 */
export async function completeDirective(input: CompleteDirectiveInput): Promise<TransitionDirectiveResult> {
  return transitionDirective({
    tenantId: input.tenantId,
    directiveId: input.directiveId,
    toState: "COMPLETED",
    actorId: input.actorId,
    reason: input.reason,
    completionMode: input.completionMode,
    metadata: { ...(input.metadata ?? {}), verb: "complete" },
  });
}
