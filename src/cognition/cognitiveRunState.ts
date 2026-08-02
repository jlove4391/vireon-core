import { z } from "zod";
import { InvalidCognitiveRunTransitionError, TerminalCognitiveRunStateError } from "./errors.js";

// CognitiveRunStatus v1 -- PR 1 of the cognitive plane. This module is the
// single source of truth for the status enum, transition map, and
// terminal-state set, mirroring src/state/workOrderState.ts's shape for
// WorkOrderStatus. A cognitive run's lifecycle is a genuinely different,
// much smaller shape than WorkOrder's 14-state lifecycle -- its own enum
// and transition map, not a reuse of WorkOrderStatus.
export const COGNITIVE_RUN_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export const CognitiveRunStatusSchema = z.enum(COGNITIVE_RUN_STATUSES);
export type CognitiveRunStatus = z.infer<typeof CognitiveRunStatusSchema>;

// No unlisted transitions. No transitions out of a terminal state. "Cancel"
// has no real asynchronous work to interrupt at this PR's scope -- the
// transition exists so the contract is stable before a later PR gives it
// something real to cancel.
export const VALID_COGNITIVE_RUN_TRANSITIONS: Readonly<Record<CognitiveRunStatus, readonly CognitiveRunStatus[]>> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

// COMPLETED, FAILED, and CANCELLED are all terminal, enforced identically --
// no special-casing one over another.
export const TERMINAL_COGNITIVE_RUN_STATUSES: ReadonlySet<CognitiveRunStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export function isTerminalCognitiveRunStatus(status: CognitiveRunStatus): boolean {
  return TERMINAL_COGNITIVE_RUN_STATUSES.has(status);
}

export function isValidCognitiveRunTransition(from: CognitiveRunStatus, to: CognitiveRunStatus): boolean {
  return VALID_COGNITIVE_RUN_TRANSITIONS[from].includes(to);
}

export function assertValidCognitiveRunTransition(
  cognitiveRunId: string,
  from: CognitiveRunStatus,
  to: CognitiveRunStatus,
): void {
  if (isTerminalCognitiveRunStatus(from)) {
    throw new TerminalCognitiveRunStateError(cognitiveRunId, from);
  }
  if (!isValidCognitiveRunTransition(from, to)) {
    throw new InvalidCognitiveRunTransitionError(cognitiveRunId, from, to);
  }
}
