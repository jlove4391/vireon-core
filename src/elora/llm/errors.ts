export type ModelOperationErrorKind = "TIMEOUT" | "PROVIDER_FAILURE" | "INVALID_OUTPUT" | "PERSISTENCE_FAILURE";

/**
 * Base class for the four ModelOperationResult failure kinds.
 * executeModelOperation.ts throws one of this class's four subclasses
 * internally (during the provider race, output validation, or evidence
 * persistence) and catches ModelOperationError at its single top-level
 * boundary to build the final `{ ok: false, error: { kind, retryable } }`
 * result -- callers of run() never see a thrown error for an expected
 * operation failure, only for a genuine programming-error misuse (e.g. a
 * malformed executor config). These classes are also exported directly so
 * a narrower unit test (or a future caller with its own reason to bypass
 * run()) can still `instanceof`-check a specific failure kind.
 */
export class ModelOperationError extends Error {
  constructor(
    public readonly kind: ModelOperationErrorKind,
    public readonly retryable: boolean,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelOperationError";
  }
}

export class ModelOperationTimeoutError extends ModelOperationError {
  constructor(operationKind: string, timeoutMs: number) {
    super("TIMEOUT", true, `Model operation "${operationKind}" timed out after ${timeoutMs}ms`);
    this.name = "ModelOperationTimeoutError";
  }
}

/** The provider call itself threw -- network failure, API error, non-2xx response, etc. Transient by nature, so retryable. */
export class ModelOperationProviderFailureError extends ModelOperationError {
  constructor(operationKind: string, cause: unknown) {
    super(
      "PROVIDER_FAILURE",
      true,
      `Model operation "${operationKind}" provider call failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
    this.name = "ModelOperationProviderFailureError";
  }
}

/**
 * The provider returned a response, but it failed Zod validation against
 * the operation's output schema. Not retryable by default: a systematic
 * prompt/schema mismatch is more likely than one-off sampling noise, and
 * this project's own doctrine (never fabricate a capability) means a
 * malformed structured result must surface as a real failure, never get
 * silently retried into a guessed value.
 */
export class ModelOperationInvalidOutputError extends ModelOperationError {
  constructor(operationKind: string, cause: unknown) {
    super(
      "INVALID_OUTPUT",
      false,
      `Model operation "${operationKind}" output failed schema validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
    this.name = "ModelOperationInvalidOutputError";
  }
}

/**
 * A model_invocations write (the initial STARTED row or the terminal
 * update) failed. Transient (a DB blip), so retryable -- but see
 * ModelOperationResult's own doc comment: invocationId is only present on
 * this kind of failure if the STARTED row insert itself succeeded before
 * the later write failed.
 */
export class ModelOperationPersistenceError extends ModelOperationError {
  constructor(operationKind: string, cause: unknown) {
    super(
      "PERSISTENCE_FAILURE",
      true,
      `Model operation "${operationKind}" evidence persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
    this.name = "ModelOperationPersistenceError";
  }
}
