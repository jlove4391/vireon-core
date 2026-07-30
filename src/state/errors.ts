import type { AuthorityOutcome } from "../shared/runtimeTypes.js";
import type { WorkOrderStatus } from "./workOrderState.js";

export class InvalidWorkOrderTransitionError extends Error {
  constructor(
    public readonly workOrderId: string,
    public readonly fromStatus: WorkOrderStatus,
    public readonly toStatus: WorkOrderStatus,
  ) {
    super(`Invalid WorkOrder transition for ${workOrderId}: ${fromStatus} -> ${toStatus} is not permitted`);
    this.name = "InvalidWorkOrderTransitionError";
  }
}

export class TerminalWorkOrderStateError extends Error {
  constructor(
    public readonly workOrderId: string,
    public readonly status: WorkOrderStatus,
  ) {
    super(`WorkOrder ${workOrderId} is in terminal state ${status} and cannot transition further`);
    this.name = "TerminalWorkOrderStateError";
  }
}

export class AuthorityOutcomeMismatchError extends Error {
  constructor(
    public readonly workOrderId: string,
    public readonly outcome: AuthorityOutcome,
    public readonly expectedStatus: WorkOrderStatus,
    public readonly actualStatus: WorkOrderStatus,
  ) {
    super(
      `AuthorityDecision outcome "${outcome}" for WorkOrder ${workOrderId} maps to ${expectedStatus}, ` +
        `but the transition targeted ${actualStatus}`,
    );
    this.name = "AuthorityOutcomeMismatchError";
  }
}

export class WorkOrderNotFoundError extends Error {
  constructor(public readonly workOrderId: string) {
    super(`WorkOrder ${workOrderId} not found`);
    this.name = "WorkOrderNotFoundError";
  }
}

// Defense-in-depth check that a substantiating record (or a record looked up
// mid-transition, e.g. the linked AuthorityDecision) shares tenant_id with
// the locked WorkOrder. RLS already scopes the queries that produce these
// rows, but AGENTS.md/ADR 0001 treat tenant isolation as a runtime
// invariant, not merely an RLS backstop -- so transitionWorkOrder asserts it
// explicitly rather than trusting RLS alone.
/** Phase 6D: raised when writeDelegationReceipt.ts fails to persist the agent_delegated receipt. */
export class DelegationReceiptWriteError extends Error {
  constructor(reason: string) {
    super(`Failed to write delegation receipt: ${reason}`);
    this.name = "DelegationReceiptWriteError";
  }
}

/**
 * Raised when a caller-influenced internal reference (a WorkOrder id, an
 * Actor id, ...) points at a row that doesn't exist at all, or exists but
 * belongs to a different tenant. A plain FK only proves the row exists
 * SOMEWHERE -- it does not prove tenant ownership, since FK constraint
 * checks run independent of RLS (see src/db/assertTenantScopedReference.ts).
 */
export class StateReferenceNotFoundError extends Error {
  constructor(
    public readonly field: string,
    public readonly id: string,
  ) {
    super(`Referenced ${field} ${id} not found for the given tenant`);
    this.name = "StateReferenceNotFoundError";
  }
}

export class TenantScopeViolationError extends Error {
  constructor(
    public readonly workOrderId: string,
    public readonly recordTenantId: string,
    public readonly expectedTenantId: string,
  ) {
    super(
      `Substantiating record tenant_id ${recordTenantId} does not match WorkOrder ${workOrderId} ` +
        `tenant_id ${expectedTenantId}`,
    );
    this.name = "TenantScopeViolationError";
  }
}
