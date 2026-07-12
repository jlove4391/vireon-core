import { z } from "zod";
import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import { InvalidWorkOrderTransitionError, TerminalWorkOrderStateError } from "./errors.js";

// WorkOrderStatus v1 -- Phase 2 CORE state machine. This module is the
// single source of truth for the status enum, transition map,
// authority-outcome mapping, and terminal-state set. src/schemas/workOrder.ts
// imports WorkOrderStatusSchema from here rather than redefining its own
// status union.
export const WORK_ORDER_STATUSES = [
  "RECEIVED",
  "INTENT_PARSED",
  "AUTHORITY_CLASSIFIED",
  "READY_TO_ACT",
  "AWAITING_AUTHORIZATION",
  "SETUP_REQUIRED",
  "CAPABILITY_MISSING",
  "REFUSED",
  "EXECUTING",
  "VALIDATING",
  "RECEIPT_WRITTEN",
  "MEMORY_CANDIDATES_CREATED",
  "COMPLETED",
  "FAILED",
] as const;

export const WorkOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatusSchema>;

// No unlisted transitions. No transitions out of a terminal state.
export const VALID_WORK_ORDER_TRANSITIONS: Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>> = {
  RECEIVED: ["INTENT_PARSED", "FAILED"],
  INTENT_PARSED: ["AUTHORITY_CLASSIFIED", "FAILED"],
  AUTHORITY_CLASSIFIED: [
    "READY_TO_ACT",
    "AWAITING_AUTHORIZATION",
    "SETUP_REQUIRED",
    "CAPABILITY_MISSING",
    "REFUSED",
    "FAILED",
  ],
  READY_TO_ACT: ["EXECUTING", "FAILED"],
  AWAITING_AUTHORIZATION: ["READY_TO_ACT", "REFUSED", "FAILED"],
  SETUP_REQUIRED: ["READY_TO_ACT", "FAILED"],
  CAPABILITY_MISSING: [],
  REFUSED: [],
  EXECUTING: ["VALIDATING", "FAILED"],
  VALIDATING: ["RECEIPT_WRITTEN", "FAILED"],
  RECEIPT_WRITTEN: ["MEMORY_CANDIDATES_CREATED", "COMPLETED", "FAILED"],
  MEMORY_CANDIDATES_CREATED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

// REFUSED and CAPABILITY_MISSING are terminal alongside COMPLETED and
// FAILED -- all four are enforced identically as terminal states.
export const TERMINAL_WORK_ORDER_STATUSES: ReadonlySet<WorkOrderStatus> = new Set([
  "CAPABILITY_MISSING",
  "REFUSED",
  "COMPLETED",
  "FAILED",
]);

// Authority outcome -> WorkOrderStatus branch mapping for the
// AUTHORITY_CLASSIFIED fan-out. Lives here as a plain lookup, not
// duplicated in transitionWorkOrder.ts.
export const AUTHORITY_OUTCOME_TO_WORK_ORDER_STATUS: Readonly<Record<AuthorityOutcome, WorkOrderStatus>> = {
  act: "READY_TO_ACT",
  act_and_report: "READY_TO_ACT",
  escalate: "AWAITING_AUTHORIZATION",
  setup_required: "SETUP_REQUIRED",
  capability_missing: "CAPABILITY_MISSING",
  refuse: "REFUSED",
};

export function isTerminalWorkOrderStatus(status: WorkOrderStatus): boolean {
  return TERMINAL_WORK_ORDER_STATUSES.has(status);
}

export function isValidWorkOrderTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return VALID_WORK_ORDER_TRANSITIONS[from].includes(to);
}

export function assertValidWorkOrderTransition(
  workOrderId: string,
  from: WorkOrderStatus,
  to: WorkOrderStatus,
): void {
  if (isTerminalWorkOrderStatus(from)) {
    throw new TerminalWorkOrderStateError(workOrderId, from);
  }
  if (!isValidWorkOrderTransition(from, to)) {
    throw new InvalidWorkOrderTransitionError(workOrderId, from, to);
  }
}
