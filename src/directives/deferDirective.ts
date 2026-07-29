import type { TransitionDirectiveResult } from "./transitionDirective.js";
import { transitionDirective } from "./transitionDirective.js";

export interface DeferDirectiveInput {
  tenantId: string;
  directiveId: string;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Named-verb wrapper over transitionDirective() -- see acceptDirective.ts
 * for the full rationale (mechanical only, no new graph/schema; tags
 * metadata.verb for audit-trail honesty; legality still enforced solely
 * by assertValidDirectiveTransition()).
 */
export async function deferDirective(input: DeferDirectiveInput): Promise<TransitionDirectiveResult> {
  return transitionDirective({
    tenantId: input.tenantId,
    directiveId: input.directiveId,
    toState: "DEFERRED",
    actorId: input.actorId,
    reason: input.reason,
    metadata: { ...(input.metadata ?? {}), verb: "defer" },
  });
}
