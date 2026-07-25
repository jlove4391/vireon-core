/** Base class for every scheduled-trigger-domain error, so callers can catch broadly with `instanceof ScheduledTriggerError`. */
export class ScheduledTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTriggerError";
  }
}

export class InvalidScheduledTriggerInputError extends ScheduledTriggerError {
  constructor(reason: string) {
    super(`Invalid scheduled trigger creation input: ${reason}`);
    this.name = "InvalidScheduledTriggerInputError";
  }
}

export class ScheduledTriggerActorNotFoundError extends ScheduledTriggerError {
  constructor(
    public readonly field: "owningActorId" | "createdByActorId",
    public readonly actorId: string,
  ) {
    super(`Actor ${actorId} (${field}) not found for the given tenant`);
    this.name = "ScheduledTriggerActorNotFoundError";
  }
}

export class ScheduledTriggerPersistenceError extends ScheduledTriggerError {
  constructor(reason: string) {
    super(`Failed to persist scheduled trigger: ${reason}`);
    this.name = "ScheduledTriggerPersistenceError";
  }
}

export class ScheduledTriggerReceiptWriteError extends ScheduledTriggerError {
  constructor(reason: string) {
    super(`Failed to write trigger_created receipt: ${reason}`);
    this.name = "ScheduledTriggerReceiptWriteError";
  }
}
