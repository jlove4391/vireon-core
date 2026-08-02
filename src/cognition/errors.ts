import type { CognitiveRunStatus } from "./cognitiveRunState.js";

export class InvalidCognitiveRunTransitionError extends Error {
  constructor(
    public readonly cognitiveRunId: string,
    public readonly fromStatus: CognitiveRunStatus,
    public readonly toStatus: CognitiveRunStatus,
  ) {
    super(`Invalid CognitiveRun transition for ${cognitiveRunId}: ${fromStatus} -> ${toStatus} is not permitted`);
    this.name = "InvalidCognitiveRunTransitionError";
  }
}

export class TerminalCognitiveRunStateError extends Error {
  constructor(
    public readonly cognitiveRunId: string,
    public readonly status: CognitiveRunStatus,
  ) {
    super(`CognitiveRun ${cognitiveRunId} is in terminal state ${status} and cannot transition further`);
    this.name = "TerminalCognitiveRunStateError";
  }
}

export class CognitiveRunNotFoundError extends Error {
  constructor(public readonly cognitiveRunId: string) {
    super(`CognitiveRun ${cognitiveRunId} not found`);
    this.name = "CognitiveRunNotFoundError";
  }
}
