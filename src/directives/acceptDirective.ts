import type { TransitionDirectiveResult } from "./transitionDirective.js";
import { transitionDirective } from "./transitionDirective.js";

export interface AcceptDirectiveInput {
  tenantId: string;
  directiveId: string;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Named-verb wrapper over transitionDirective() -- mechanical only, no new
 * graph or schema. Hardcodes toState = "OPEN" and tags metadata.verb =
 * "accept" so getDirectiveHistory() records which of the spec's six named
 * verbs was actually invoked, rather than reading on trust of whatever
 * free-text `reason` the caller happened to write. Legality (e.g. that
 * PROPOSED -> OPEN is valid) is still enforced exactly where it already
 * was, by assertValidDirectiveTransition() in directiveState.ts -- this
 * wrapper does not add or duplicate that check.
 */
export async function acceptDirective(input: AcceptDirectiveInput): Promise<TransitionDirectiveResult> {
  return transitionDirective({
    tenantId: input.tenantId,
    directiveId: input.directiveId,
    toState: "OPEN",
    actorId: input.actorId,
    reason: input.reason,
    metadata: { ...(input.metadata ?? {}), verb: "accept" },
  });
}
