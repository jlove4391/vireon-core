import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { setCorrelationAttributes, withSpan } from "../telemetry/correlation.js";
import type { CognitiveRunTransitionRecord } from "./createCognitiveRun.js";
import {
  assertValidCognitiveRunTransition,
  CognitiveRunStatusSchema,
  isTerminalCognitiveRunStatus,
  type CognitiveRunStatus,
} from "./cognitiveRunState.js";
import { CognitiveRunNotFoundError } from "./errors.js";

export interface TransitionCognitiveRunInput {
  tenantId: string;
  cognitiveRunId: string;
  nextStatus: CognitiveRunStatus;
  actorId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionCognitiveRunResult {
  cognitiveRun: {
    id: string;
    tenant_id: string;
    status: CognitiveRunStatus;
    started_at: string | null;
    ended_at: string | null;
  };
  transition: CognitiveRunTransitionRecord;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function lockCognitiveRun(
  client: PoolClient,
  tenantId: string,
  cognitiveRunId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    "SELECT * FROM cognitive_runs WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [cognitiveRunId, tenantId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    // Also how a cross-tenant reference is rejected: a run id belonging to
    // a different tenant never matches this tenant-scoped WHERE clause, so
    // it surfaces identically to a genuinely nonexistent id -- same
    // mechanism transitionWorkOrder.ts's lockWorkOrder() uses.
    throw new CognitiveRunNotFoundError(cognitiveRunId);
  }
  return row;
}

/**
 * Runs the CognitiveRun transition sequence inside a single tenant-scoped
 * transaction: lock -> validate -> update status (+ started_at/ended_at) ->
 * record transition -> (test-only) inject failure -> commit. Trimmed from
 * transitionWorkOrder.ts's shape to PR 1's scope -- no authority/run/
 * receipt/memory-candidate substantiation branches exist for a CognitiveRun
 * yet.
 */
async function runTransition(
  input: TransitionCognitiveRunInput,
  options: { injectFailureAfterTransitionInsert: boolean },
): Promise<TransitionCognitiveRunResult> {
  return withSpan(
    "cognition",
    "cognition.cognitive_run_transition",
    {
      "vireon.tenant.id": input.tenantId,
      "vireon.cognitive_run.id": input.cognitiveRunId,
      "vireon.cognitive_run.status_to": input.nextStatus,
    },
    async (span) => {
      const result = await withTenantTransaction(input.tenantId, async (client) => {
        const now = new Date().toISOString();
        const cognitiveRunRow = await lockCognitiveRun(client, input.tenantId, input.cognitiveRunId);
        const currentStatus = CognitiveRunStatusSchema.parse(cognitiveRunRow.status);

        assertValidCognitiveRunTransition(input.cognitiveRunId, currentStatus, input.nextStatus);

        // Both server-computed, never caller-controlled. started_at is only
        // reachable via the single PENDING -> RUNNING edge, so this can
        // only ever set it once; ended_at is only reachable via entering a
        // terminal state, which has no outgoing edges, so likewise only
        // ever set once. COALESCE is defense-in-depth, not load-bearing.
        const enteringRunning = input.nextStatus === "RUNNING";
        const enteringTerminal = isTerminalCognitiveRunStatus(input.nextStatus);

        const updateResult = await client.query(
          `UPDATE cognitive_runs
           SET status = $1,
               updated_at = $2,
               started_at = COALESCE($3, started_at),
               ended_at = COALESCE($4, ended_at)
           WHERE id = $5 AND tenant_id = $6
           RETURNING *`,
          [
            input.nextStatus,
            now,
            enteringRunning ? now : null,
            enteringTerminal ? now : null,
            input.cognitiveRunId,
            input.tenantId,
          ],
        );
        const updatedRow = updateResult.rows[0] as Record<string, unknown>;

        const transitionInsert = await client.query(
          `INSERT INTO cognitive_run_transitions
             (id, tenant_id, cognitive_run_id, from_state, to_state, actor_id, reason, transition_type, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'state_change',$8,$9)
           RETURNING *`,
          [
            randomUUID(),
            input.tenantId,
            input.cognitiveRunId,
            currentStatus,
            input.nextStatus,
            input.actorId,
            input.reason,
            JSON.stringify(input.metadata ?? {}),
            now,
          ],
        );
        const transitionRow = transitionInsert.rows[0] as Record<string, unknown>;

        if (options.injectFailureAfterTransitionInsert) {
          throw new Error("transitionCognitiveRun: test-only failure injection after transition insert");
        }

        return {
          cognitiveRun: {
            id: updatedRow.id as string,
            tenant_id: updatedRow.tenant_id as string,
            status: CognitiveRunStatusSchema.parse(updatedRow.status),
            started_at: updatedRow.started_at ? toIso(updatedRow.started_at as string | Date) : null,
            ended_at: updatedRow.ended_at ? toIso(updatedRow.ended_at as string | Date) : null,
          },
          transition: {
            id: transitionRow.id as string,
            tenant_id: transitionRow.tenant_id as string,
            cognitive_run_id: transitionRow.cognitive_run_id as string,
            from_state: transitionRow.from_state as string | null,
            to_state: transitionRow.to_state as string,
            actor_id: transitionRow.actor_id as string | null,
            reason: transitionRow.reason as string,
            transition_type: transitionRow.transition_type as string,
            metadata: transitionRow.metadata as Record<string, unknown>,
            created_at: toIso(transitionRow.created_at as string | Date),
          },
        };
      });

      setCorrelationAttributes(span, { cognitiveRunId: result.cognitiveRun.id });
      return result;
    },
  );
}

/** Production entry point. Never accepts failure-injection input. */
export async function transitionCognitiveRun(input: TransitionCognitiveRunInput): Promise<TransitionCognitiveRunResult> {
  return runTransition(input, { injectFailureAfterTransitionInsert: false });
}

/**
 * Test-only wrapper that can force a rollback after the transition row is
 * inserted but before commit, to prove no partial status/history mismatch
 * survives a rollback. Rejected outside test context so this is not a
 * reachable production code path. Mirrors transitionWorkOrderForTest's
 * exact purpose.
 */
export async function transitionCognitiveRunForTest(
  input: TransitionCognitiveRunInput,
): Promise<TransitionCognitiveRunResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("transitionCognitiveRunForTest may only be called with NODE_ENV=test");
  }
  return runTransition(input, { injectFailureAfterTransitionInsert: true });
}
