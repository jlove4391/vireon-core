/** Base class for every ELORA ingestion-pipeline error, so callers can catch broadly with `instanceof EloraError`. */
export class EloraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EloraError";
  }
}

export class EloraInvalidIngressInputError extends EloraError {
  constructor(reason: string) {
    super(`Invalid ELORA ingress input: ${reason}`);
    this.name = "EloraInvalidIngressInputError";
  }
}

export class EloraContextResolutionError extends EloraError {
  constructor(
    public readonly field: "workspace" | "project" | "thread",
    public readonly id: string,
  ) {
    super(`Could not resolve ${field} ${id} for the given tenant`);
    this.name = "EloraContextResolutionError";
  }
}

export class EloraActorNotFoundError extends EloraError {
  constructor(public readonly actorId: string) {
    super(`Actor ${actorId} not found for the given tenant`);
    this.name = "EloraActorNotFoundError";
  }
}

export class EloraTenantMismatchError extends EloraError {
  constructor(
    public readonly projectId: string,
    public readonly suppliedWorkspaceId: string,
    public readonly actualWorkspaceId: string,
  ) {
    super(
      `Project ${projectId} belongs to workspace ${actualWorkspaceId}, not the supplied workspace ${suppliedWorkspaceId}`,
    );
    this.name = "EloraTenantMismatchError";
  }
}

export class EloraThreadPersistenceError extends EloraError {
  constructor(reason: string) {
    super(`Failed to persist or resolve Thread: ${reason}`);
    this.name = "EloraThreadPersistenceError";
  }
}

export class EloraMessagePersistenceError extends EloraError {
  constructor(reason: string) {
    super(`Failed to persist Message: ${reason}`);
    this.name = "EloraMessagePersistenceError";
  }
}

export class EloraIntentParseError extends EloraError {
  constructor(reason: string) {
    super(`Failed to parse intent: ${reason}`);
    this.name = "EloraIntentParseError";
  }
}

export class EloraAuthorityClassificationError extends EloraError {
  constructor(reason: string) {
    super(`Failed to classify authority: ${reason}`);
    this.name = "EloraAuthorityClassificationError";
  }
}

export class EloraReceiptWriteError extends EloraError {
  constructor(reason: string) {
    super(`Failed to write ELORA receipt: ${reason}`);
    this.name = "EloraReceiptWriteError";
  }
}

export class EloraMemoryCandidateError extends EloraError {
  constructor(reason: string) {
    super(`Failed to propose memory candidate: ${reason}`);
    this.name = "EloraMemoryCandidateError";
  }
}
