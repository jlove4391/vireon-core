import type { TransitionDirectiveResult } from "./transitionDirective.js";
import { transitionDirective } from "./transitionDirective.js";

export interface ReopenDirectiveInput {
  tenantId: string;
  directiveId: string;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Explicit, operator-initiated reopen (one of the eight core services) --
 * distinct from createOrMergeDirective.ts's *automatic* reopen-on-
 * re-detection path. Both ultimately go through the same
 * applyDirectiveTransition() core (transitionDirective.ts) targeting
 * OPEN, so the transition graph and its validation live in exactly one
 * place.
 */
export async function reopenDirective(input: ReopenDirectiveInput): Promise<TransitionDirectiveResult> {
  return transitionDirective({
    tenantId: input.tenantId,
    directiveId: input.directiveId,
    toState: "OPEN",
    actorId: input.actorId,
    reason: input.reason,
    metadata: { ...(input.metadata ?? {}), reopenedManually: true },
  });
}
