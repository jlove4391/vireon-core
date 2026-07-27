import { DIRECTIVE_STATES, type DirectiveState } from "../schemas/operatorDirective.js";
import { InvalidDirectiveTransitionError, TerminalDirectiveStateError } from "./errors.js";

export { DIRECTIVE_STATES, type DirectiveState };

/**
 * Transition graph -- filling in the spec's own gap. The spec names the
 * controlled transitions (accept, defer, complete, dismiss, expire,
 * reopen) and the eight states, but not the full from/to graph; this is
 * my own construction for Phase B, documented here rather than left
 * implicit, same as workOrderState.ts's own graph for WorkOrderStatus.
 *
 * PROPOSED is the initial state (a detected-but-not-yet-accepted
 * candidate); "accept" moves it to OPEN. Unlike WorkOrderStatus, most
 * closed states here are NOT fully terminal -- COMPLETED, DISMISSED, and
 * EXPIRED can all be reopened back to OPEN, because "reopen" is one of
 * the spec's own named controlled transitions and a Directive's identity
 * is meant to persist "across carrying, completion, reopening" (spec's
 * own words on (tenant_id, dedupe_key) identity). SUPERSEDED is the one
 * genuinely terminal state: once a different Directive has taken this
 * one's place, reopening the superseded one doesn't make sense.
 */
export const VALID_DIRECTIVE_TRANSITIONS: Readonly<Record<DirectiveState, readonly DirectiveState[]>> = {
  PROPOSED: ["OPEN", "DISMISSED", "SUPERSEDED"],
  OPEN: ["IN_PROGRESS", "DEFERRED", "COMPLETED", "DISMISSED", "EXPIRED", "SUPERSEDED"],
  IN_PROGRESS: ["DEFERRED", "COMPLETED", "DISMISSED", "EXPIRED", "SUPERSEDED"],
  DEFERRED: ["OPEN", "IN_PROGRESS", "DISMISSED", "EXPIRED", "SUPERSEDED"],
  COMPLETED: ["OPEN"],
  DISMISSED: ["OPEN"],
  EXPIRED: ["OPEN"],
  SUPERSEDED: [],
};

// Only SUPERSEDED has no outgoing transitions -- COMPLETED/DISMISSED/EXPIRED
// are closed-but-reopenable, not terminal in the WorkOrderStatus sense.
export const TERMINAL_DIRECTIVE_STATES: ReadonlySet<DirectiveState> = new Set(["SUPERSEDED"]);

export function isTerminalDirectiveState(state: DirectiveState): boolean {
  return TERMINAL_DIRECTIVE_STATES.has(state);
}

export function isValidDirectiveTransition(from: DirectiveState, to: DirectiveState): boolean {
  return VALID_DIRECTIVE_TRANSITIONS[from].includes(to);
}

export function assertValidDirectiveTransition(directiveId: string, from: DirectiveState, to: DirectiveState): void {
  if (isTerminalDirectiveState(from)) {
    throw new TerminalDirectiveStateError(directiveId, from);
  }
  if (!isValidDirectiveTransition(from, to)) {
    throw new InvalidDirectiveTransitionError(directiveId, from, to);
  }
}

/**
 * Which operator_directives timestamp column a transition into this state
 * should populate, if any. Not every to_state has one -- e.g. there is no
 * "expired_at"/"superseded_at" column (the spec's own schema only lists
 * accepted_at/started_at/completed_at/deferred_at/dismissed_at); EXPIRED
 * and SUPERSEDED are recorded only via the transitions table, consistent
 * with "transitions are the mandatory state evidence."
 */
export const DIRECTIVE_STATE_TIMESTAMP_COLUMN: Readonly<Partial<Record<DirectiveState, string>>> = {
  OPEN: "accepted_at",
  IN_PROGRESS: "started_at",
  COMPLETED: "completed_at",
  DEFERRED: "deferred_at",
  DISMISSED: "dismissed_at",
};
