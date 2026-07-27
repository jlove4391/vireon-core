import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirective, OperatorDirectiveTransition, DirectiveState } from "../schemas/operatorDirective.js";
import { assertValidDirectiveTransition, DIRECTIVE_STATE_TIMESTAMP_COLUMN } from "./directiveState.js";
import { DirectiveNotFoundError, DirectivePersistenceError, InvalidDirectiveInputError, UnsubstantiatedCompletionError } from "./errors.js";
import { rowToDirective, rowToTransition } from "./rowMappers.js";

export type DirectiveCompletionMode = "operator_attested" | "system_validated";

export interface TransitionDirectiveInput {
  tenantId: string;
  directiveId: string;
  toState: DirectiveState;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
  /**
   * Required only when toState === "COMPLETED" (acceptance criterion #6).
   * "operator_attested": a human is vouching for completion directly, no
   * further check performed. "system_validated": requires real execution
   * evidence -- at least one operator_directive_provenance row pointing
   * at a work_order_id whose work_orders.status is actually 'COMPLETED'.
   * Claiming system_validated without that evidence throws
   * UnsubstantiatedCompletionError rather than silently downgrading to
   * operator_attested.
   */
  completionMode?: DirectiveCompletionMode;
}

export interface TransitionDirectiveResult {
  directive: OperatorDirective;
  transition: OperatorDirectiveTransition;
}

async function assertSystemValidatedCompletionSubstantiated(
  client: PoolClient,
  tenantId: string,
  directiveId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM operator_directive_provenance p
     JOIN work_orders wo ON wo.id = p.work_order_id AND wo.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1 AND p.directive_id = $2 AND p.work_order_id IS NOT NULL AND wo.status = 'COMPLETED'
     LIMIT 1`,
    [tenantId, directiveId],
  );
  if (result.rows.length === 0) {
    throw new UnsubstantiatedCompletionError(directiveId);
  }
}

/**
 * Client-taking core -- reused by createOrMergeDirective.ts's automatic
 * reopen path and by reopenDirective.ts's explicit manual path, so a
 * detection-triggered reopen (plus any accompanying revision) commits
 * atomically with the transition, and reopenDirective() doesn't
 * duplicate this logic.
 */
export async function applyDirectiveTransition(
  client: PoolClient,
  input: TransitionDirectiveInput,
): Promise<TransitionDirectiveResult> {
  const directiveResult = await client.query(
    "SELECT * FROM operator_directives WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [input.directiveId, input.tenantId],
  );
  const directiveRow = directiveResult.rows[0] as Record<string, unknown> | undefined;
  if (!directiveRow) {
    throw new DirectiveNotFoundError(input.directiveId);
  }

  const fromState = directiveRow.state as DirectiveState;
  assertValidDirectiveTransition(input.directiveId, fromState, input.toState);

  let transitionMetadata = { ...(input.metadata ?? {}) };

  if (input.toState === "COMPLETED") {
    if (!input.completionMode) {
      throw new InvalidDirectiveInputError("completionMode is required when transitioning a Directive to COMPLETED");
    }
    if (input.completionMode === "system_validated") {
      await assertSystemValidatedCompletionSubstantiated(client, input.tenantId, input.directiveId);
    }
    transitionMetadata = { ...transitionMetadata, completionMode: input.completionMode };
  }

  const now = new Date().toISOString();
  const timestampColumn = DIRECTIVE_STATE_TIMESTAMP_COLUMN[input.toState];

  try {
    const updateResult = await client.query(
      timestampColumn
        ? `UPDATE operator_directives SET state = $1, last_seen_at = $2, updated_at = $2, ${timestampColumn} = $2
           WHERE id = $3 AND tenant_id = $4 RETURNING *`
        : `UPDATE operator_directives SET state = $1, last_seen_at = $2, updated_at = $2
           WHERE id = $3 AND tenant_id = $4 RETURNING *`,
      [input.toState, now, input.directiveId, input.tenantId],
    );

    const transitionId = randomUUID();
    const transitionResult = await client.query(
      `INSERT INTO operator_directive_transitions
         (id, tenant_id, directive_id, from_state, to_state, actor_id, transition_type, reason, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'state_change',$7,$8,$9)
       RETURNING *`,
      [
        transitionId,
        input.tenantId,
        input.directiveId,
        fromState,
        input.toState,
        input.actorId,
        input.reason,
        JSON.stringify(transitionMetadata),
        now,
      ],
    );

    return {
      directive: rowToDirective(updateResult.rows[0] as Record<string, unknown>),
      transition: rowToTransition(transitionResult.rows[0] as Record<string, unknown>),
    };
  } catch (error) {
    if (error instanceof UnsubstantiatedCompletionError || error instanceof InvalidDirectiveInputError) throw error;
    throw new DirectivePersistenceError(
      `operator_directives/operator_directive_transitions transition write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Public entry point -- one of the eight core services. Opens its own transaction. */
export async function transitionDirective(input: TransitionDirectiveInput): Promise<TransitionDirectiveResult> {
  return withTenantTransaction(input.tenantId, (client) => applyDirectiveTransition(client, input));
}
