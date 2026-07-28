import type { TransitionDirectiveResult } from "./transitionDirective.js";
import { transitionDirective } from "./transitionDirective.js";

export interface ExpireDirectiveInput {
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
 *
 * This is a manual/explicit call only -- it does not add an automatic
 * PROPOSED -> EXPIRED path or any due_at/expires_at comparison against
 * now(). See directiveState.ts's own doc comment on
 * VALID_DIRECTIVE_TRANSITIONS for why that stays out of scope here.
 */
export async function expireDirective(input: ExpireDirectiveInput): Promise<TransitionDirectiveResult> {
  return transitionDirective({
    tenantId: input.tenantId,
    directiveId: input.directiveId,
    toState: "EXPIRED",
    actorId: input.actorId,
    reason: input.reason,
    metadata: { ...(input.metadata ?? {}), verb: "expire" },
  });
}
