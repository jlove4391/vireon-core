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
 *
 * Deliberately no PROPOSED -> EXPIRED edge, and no code anywhere in this
 * phase (this domain or 6J's poller) ever compares due_at/expires_at
 * against now() to auto-close a stale, never-accepted Directive -- a
 * PROPOSED row that ages out today has no automatic exit, only manual
 * DISMISSED (or an explicit SUPERSEDED call). This is in scope for
 * whatever later phase builds per-directive-type carry/expiry cadence
 * (the deliberation source material's own carry/expiry policy language
 * lives outside this phase's schema/service scope) -- not an oversight
 * discovered after the fact, but flagged explicitly here so it reads as a
 * scoped-out decision on its own, not something to rediscover later.
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
 *
 * Overwrite, not write-once (see applyDirectiveTransition() in
 * transitionDirective.ts): each column reflects the MOST RECENT time its
 * state was reached, not the first. Decided deliberately, reversed from
 * an earlier local-only write-once pass -- these columns exist as a
 * current-status fast path on the parent row (that's the whole reason
 * they're denormalized instead of always requiring a join), and freezing
 * e.g. completed_at at a directive's first completion would make a
 * months-stale value the answer to "when did this most recently
 * complete." First-occurrence history is never lost -- it's fully
 * available via operator_directive_transitions (ORDER BY created_at ASC
 * LIMIT 1 for the earliest entry into a given to_state) if ever actually
 * needed; nothing here saves a query either way, since
 * getDirectiveDetail()/getDirectiveHistory() already hit that table for
 * the derived counters regardless.
 */
export const DIRECTIVE_STATE_TIMESTAMP_COLUMN: Readonly<Partial<Record<DirectiveState, string>>> = {
  OPEN: "accepted_at",
  IN_PROGRESS: "started_at",
  COMPLETED: "completed_at",
  DEFERRED: "deferred_at",
  DISMISSED: "dismissed_at",
};
