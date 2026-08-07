/** Base class for every world-state-domain error, so callers can catch broadly with `instanceof WorldStateError`. */
export class WorldStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldStateError";
  }
}

export class InvalidEntityInputError extends WorldStateError {
  constructor(reason: string) {
    super(`Invalid entity input: ${reason}`);
    this.name = "InvalidEntityInputError";
  }
}

export class InvalidClaimInputError extends WorldStateError {
  constructor(reason: string) {
    super(`Invalid claim input: ${reason}`);
    this.name = "InvalidClaimInputError";
  }
}

export class EntityNotFoundError extends WorldStateError {
  constructor(
    public readonly field: string,
    public readonly entityId: string,
  ) {
    super(`Referenced entity ${entityId} (${field}) not found for the given tenant`);
    this.name = "EntityNotFoundError";
  }
}

export class ClaimNotFoundError extends WorldStateError {
  constructor(public readonly claimId: string) {
    super(`Referenced claim ${claimId} (supersedesClaimId) not found for the given tenant`);
    this.name = "ClaimNotFoundError";
  }
}

export class ClaimEvidenceSourceNotFoundError extends WorldStateError {
  constructor(
    public readonly sourceKind: string,
    public readonly sourceId: string,
  ) {
    super(`Referenced ${sourceKind} evidence source ${sourceId} not found for the given tenant`);
    this.name = "ClaimEvidenceSourceNotFoundError";
  }
}

export class WorldStatePersistenceError extends WorldStateError {
  constructor(reason: string) {
    super(`Failed to persist world-state record: ${reason}`);
    this.name = "WorldStatePersistenceError";
  }
}
