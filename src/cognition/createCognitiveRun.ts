import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { cognitiveRunSchema, type CognitiveRun } from "../schemas/cognitiveRun.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { setCorrelationAttributes, withSpan } from "../telemetry/correlation.js";

export interface CreateCognitiveRunInput {
  tenantId: string;
  threadId?: string | null;
  messageId?: string | null;
  initiatedByActorId?: string | null;
  objectiveKind: string;
}

export interface CognitiveRunTransitionRecord {
  id: string;
  tenant_id: string;
  cognitive_run_id: string;
  from_state: string | null;
  to_state: string;
  actor_id: string | null;
  reason: string;
  transition_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateCognitiveRunResult {
  cognitiveRun: CognitiveRun;
  initialTransition: CognitiveRunTransitionRecord;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToCognitiveRun(row: Record<string, unknown>): CognitiveRun {
  return cognitiveRunSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    initiated_by_actor_id: row.initiated_by_actor_id,
    objective_kind: row.objective_kind,
    status: row.status,
    idempotency_key: row.idempotency_key,
    started_at: row.started_at ? toIso(row.started_at as string | Date) : null,
    ended_at: row.ended_at ? toIso(row.ended_at as string | Date) : null,
    created_at: toIso(row.created_at as string | Date),
    updated_at: toIso(row.updated_at as string | Date),
  });
}

function rowToTransition(row: Record<string, unknown>): CognitiveRunTransitionRecord {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    cognitive_run_id: row.cognitive_run_id as string,
    from_state: row.from_state as string | null,
    to_state: row.to_state as string,
    actor_id: row.actor_id as string | null,
    reason: row.reason as string,
    transition_type: row.transition_type as string,
    metadata: row.metadata as Record<string, unknown>,
    created_at: toIso(row.created_at as string | Date),
  };
}

/**
 * Creates a CognitiveRun in PENDING status and its initial NULL -> PENDING
 * transition row atomically in one tenant-scoped transaction, mirroring
 * createWorkOrder.ts. Idempotency key derivation follows ELORA.md §9.1's
 * convention (stable runtime identifiers), adapted to this domain's
 * identifiers rather than inventing a new convention: tenant_id, thread_id,
 * message_id, initiated_by_actor_id, and objective_kind.
 *
 * No assertTenantScopedReference calls -- plain FKs throughout, per the
 * locked decision (matches work_order_state_transitions.work_order_id and
 * every operator_directive_ledger reference exactly). That decision holds
 * provided this function is only ever invoked from an already-tenant-scoped
 * context, the same precedent createWorkOrder.ts relies on -- but this PR
 * ships with no live caller, so that assumption cannot be verified against
 * a real caller here. Must be re-checked when a real caller is built, not
 * assumed to hold forever.
 *
 * Uses insert-or-fetch on the CognitiveRun's (tenant_id, idempotency_key)
 * unique constraint. On a fetched-existing conflict, the pre-existing
 * initial transition row is returned rather than inserting a second one.
 */
export async function createCognitiveRun(input: CreateCognitiveRunInput): Promise<CreateCognitiveRunResult> {
  const idempotencyKey = buildIdempotencyKey([
    input.tenantId,
    input.threadId ?? "",
    input.messageId ?? "",
    input.initiatedByActorId ?? "",
    input.objectiveKind,
  ]);

  return withSpan(
    "cognition",
    "cognition.cognitive_run_create",
    { "vireon.tenant.id": input.tenantId },
    async (span) => {
      const result = await withTenantTransaction(input.tenantId, async (client) => {
        const now = new Date().toISOString();
        const candidateId = randomUUID();

        const insertResult = await client.query(
          `INSERT INTO cognitive_runs
             (id, tenant_id, thread_id, message_id, initiated_by_actor_id, objective_kind, status, idempotency_key, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$8)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            candidateId,
            input.tenantId,
            input.threadId ?? null,
            input.messageId ?? null,
            input.initiatedByActorId ?? null,
            input.objectiveKind,
            idempotencyKey,
            now,
          ],
        );

        if (insertResult.rows.length > 0) {
          const cognitiveRunRow = insertResult.rows[0] as Record<string, unknown>;
          const transitionInsert = await client.query(
            `INSERT INTO cognitive_run_transitions
               (id, tenant_id, cognitive_run_id, from_state, to_state, actor_id, reason, transition_type, metadata, created_at)
             VALUES ($1,$2,$3,NULL,'PENDING',$4,$5,'state_change','{}'::jsonb,$6)
             RETURNING *`,
            [randomUUID(), input.tenantId, cognitiveRunRow.id, input.initiatedByActorId ?? null, "CognitiveRun created", now],
          );

          return {
            cognitiveRun: rowToCognitiveRun(cognitiveRunRow),
            initialTransition: rowToTransition(transitionInsert.rows[0] as Record<string, unknown>),
          };
        }

        const existingResult = await client.query(
          "SELECT * FROM cognitive_runs WHERE tenant_id = $1 AND idempotency_key = $2",
          [input.tenantId, idempotencyKey],
        );
        const existingRow = existingResult.rows[0] as Record<string, unknown>;

        const existingTransitionResult = await client.query(
          `SELECT * FROM cognitive_run_transitions
           WHERE tenant_id = $1 AND cognitive_run_id = $2 AND from_state IS NULL
           ORDER BY created_at ASC
           LIMIT 1`,
          [input.tenantId, existingRow.id],
        );

        return {
          cognitiveRun: rowToCognitiveRun(existingRow),
          initialTransition: rowToTransition(existingTransitionResult.rows[0] as Record<string, unknown>),
        };
      });

      setCorrelationAttributes(span, { cognitiveRunId: result.cognitiveRun.id });
      return result;
    },
  );
}
