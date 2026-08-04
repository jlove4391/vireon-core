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

/**
 * PR 4 §4.1: a transition into COMPLETED must be rejected unless at least
 * one real model_invocations row exists for this (tenant_id,
 * cognitive_run_id) with a terminal status (SUCCEEDED, FAILED, or
 * TIMED_OUT). This is the completion substantiation gate -- it lives inside
 * transitionCognitiveRun.ts's own transaction, not merely in a caller, so it
 * cannot be bypassed by a coordinator that forgets to check.
 */
export class CognitiveRunCompletionUnsubstantiatedError extends Error {
  constructor(public readonly cognitiveRunId: string) {
    super(
      `CognitiveRun ${cognitiveRunId} cannot transition to COMPLETED: no terminal model_invocations row substantiates completion`,
    );
    this.name = "CognitiveRunCompletionUnsubstantiatedError";
  }
}
