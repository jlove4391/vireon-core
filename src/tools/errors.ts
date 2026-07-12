/** Base class for every tool-registry/gateway/workspace error, so callers can catch broadly with `instanceof ToolError`. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export class DuplicateToolNameError extends ToolError {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is already registered`);
    this.name = "DuplicateToolNameError";
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" is not registered`);
    this.name = "ToolNotFoundError";
  }
}

export class ToolAuthorityDeniedError extends ToolError {
  constructor(
    public readonly toolName: string,
    public readonly authorityOutcome: string,
  ) {
    super(`Tool "${toolName}" may not execute under authority outcome "${authorityOutcome}"`);
    this.name = "ToolAuthorityDeniedError";
  }
}

export class ToolInputValidationError extends ToolError {
  constructor(
    public readonly toolName: string,
    reason: string,
  ) {
    super(`Tool "${toolName}" rejected its input: ${reason}`);
    this.name = "ToolInputValidationError";
  }
}

export class ToolOutputValidationError extends ToolError {
  constructor(
    public readonly toolName: string,
    reason: string,
  ) {
    super(`Tool "${toolName}" produced output that failed its own output schema: ${reason}`);
    this.name = "ToolOutputValidationError";
  }
}

export class ToolExecutionFailedError extends ToolError {
  constructor(
    public readonly toolName: string,
    reason: string,
  ) {
    super(`Tool "${toolName}" execution failed: ${reason}`);
    this.name = "ToolExecutionFailedError";
  }
}

/** Bounded-workspace boundary violations (§7) -- traversal, absolute paths, symlink escape, size limits, etc. */
export class WorkspaceBoundaryViolationError extends ToolError {
  constructor(
    public readonly code: string,
    reason: string,
  ) {
    super(`Workspace boundary violation (${code}): ${reason}`);
    this.name = "WorkspaceBoundaryViolationError";
  }
}
