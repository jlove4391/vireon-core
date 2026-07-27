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
