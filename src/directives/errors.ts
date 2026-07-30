import type { DirectiveState } from "../schemas/operatorDirective.js";

/** Base class for every operator-directive-domain error, so callers can catch broadly with `instanceof DirectiveError`. */
export class DirectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectiveError";
  }
}

export class InvalidDirectiveInputError extends DirectiveError {
  constructor(reason: string) {
    super(`Invalid Directive input: ${reason}`);
    this.name = "InvalidDirectiveInputError";
  }
}

export class DirectiveActorNotFoundError extends DirectiveError {
  constructor(
    public readonly field: string,
    public readonly actorId: string,
  ) {
    super(`Actor ${actorId} (${field}) not found for the given tenant`);
    this.name = "DirectiveActorNotFoundError";
  }
}

/**
 * Raised when an internal reference (a provenance column, or any other
 * cross-table id this domain accepts from a caller) points at a row that
 * either doesn't exist at all, or exists but belongs to a different
 * tenant. A plain FK only proves the row exists SOMEWHERE -- it does not
 * prove tenant ownership, since FK constraint checks run independent of
 * RLS. This is the error every explicit tenant-scoped existence check in
 * this domain raises, so a cross-tenant reference is rejected at
 * write-time instead of silently persisting a row whose column value
 * points outside its own tenant.
 */
export class DirectiveReferenceNotFoundError extends DirectiveError {
  constructor(
    public readonly field: string,
    public readonly id: string,
  ) {
    super(`Referenced ${field} ${id} not found for the given tenant`);
    this.name = "DirectiveReferenceNotFoundError";
  }
}

export class DirectiveNotFoundError extends DirectiveError {
  constructor(public readonly directiveId: string) {
    super(`Directive ${directiveId} not found`);
    this.name = "DirectiveNotFoundError";
  }
}

export class InvalidDirectiveTransitionError extends DirectiveError {
  constructor(
    public readonly directiveId: string,
    public readonly fromState: DirectiveState,
    public readonly toState: DirectiveState,
  ) {
    super(`Invalid Directive transition for ${directiveId}: ${fromState} -> ${toState} is not permitted`);
    this.name = "InvalidDirectiveTransitionError";
  }
}

export class TerminalDirectiveStateError extends DirectiveError {
  constructor(
    public readonly directiveId: string,
    public readonly state: DirectiveState,
  ) {
    super(`Directive ${directiveId} is in terminal state ${state} and cannot transition further`);
    this.name = "TerminalDirectiveStateError";
  }
}

export class UnsubstantiatedCompletionError extends DirectiveError {
  constructor(directiveId: string) {
    super(
      `Directive ${directiveId} was completed as "system_validated" but no provenance row points to a ` +
        `real completed WorkOrder -- system-validated completion requires actual execution evidence`,
    );
    this.name = "UnsubstantiatedCompletionError";
  }
}

export class DirectivePersistenceError extends DirectiveError {
  constructor(reason: string) {
    super(`Failed to persist Directive record: ${reason}`);
    this.name = "DirectivePersistenceError";
  }
}
