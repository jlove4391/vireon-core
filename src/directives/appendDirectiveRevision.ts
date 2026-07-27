import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirectiveRevision } from "../schemas/operatorDirective.js";
import { computeDirectiveContentHash } from "./computeDirectiveContentHash.js";
import { DirectiveNotFoundError, DirectivePersistenceError, InvalidDirectiveInputError } from "./errors.js";
import { rowToRevision } from "./rowMappers.js";

export interface AppendDirectiveRevisionInput {
  tenantId: string;
  directiveId: string;
  title: string;
  body?: string | null;
  whyNow?: string | null;
  priority?: string | null;
  proposedOwnerActorId?: string | null;
  dueAt?: string | null;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  expiresAt?: string | null;
  changeReason?: string | null;
  createdByActorId: string;
}

function validateInput(input: AppendDirectiveRevisionInput): void {
  if (!input.title.trim()) {
    throw new InvalidDirectiveInputError("title must not be empty");
  }
}

/**
 * Client-taking core -- reused by createOrMergeDirective.ts (the initial
 * revision on creation, and any material-change revision on
 * revise/reopen) so the directive mutation and its revision commit
 * atomically. Locks the parent directive row first so concurrent
 * revision_number allocation for the same directive can't race.
 */
export async function insertDirectiveRevisionRow(
  client: PoolClient,
  input: AppendDirectiveRevisionInput,
): Promise<OperatorDirectiveRevision> {
  validateInput(input);

  const directiveResult = await client.query(
    "SELECT id FROM operator_directives WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [input.directiveId, input.tenantId],
  );
  if (directiveResult.rows.length === 0) {
    throw new DirectiveNotFoundError(input.directiveId);
  }

  const maxResult = await client.query<{ max_rev: number }>(
    "SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM operator_directive_revisions WHERE tenant_id = $1 AND directive_id = $2",
    [input.tenantId, input.directiveId],
  );
  const nextRevisionNumber = (maxResult.rows[0]?.max_rev ?? 0) + 1;

  const contentHash = computeDirectiveContentHash({
    title: input.title,
    body: input.body,
    whyNow: input.whyNow,
    priority: input.priority,
    proposedOwnerActorId: input.proposedOwnerActorId,
    dueAt: input.dueAt,
    windowStartAt: input.windowStartAt,
    windowEndAt: input.windowEndAt,
    expiresAt: input.expiresAt,
  });

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    const result = await client.query(
      `INSERT INTO operator_directive_revisions
         (id, tenant_id, directive_id, revision_number, title, body, why_now, priority,
          proposed_owner_actor_id, due_at, window_start_at, window_end_at, expires_at,
          content_hash, change_reason, created_by_actor_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.directiveId,
        nextRevisionNumber,
        input.title,
        input.body ?? null,
        input.whyNow ?? null,
        input.priority ?? null,
        input.proposedOwnerActorId ?? null,
        input.dueAt ?? null,
        input.windowStartAt ?? null,
        input.windowEndAt ?? null,
        input.expiresAt ?? null,
        contentHash,
        input.changeReason ?? null,
        input.createdByActorId,
        now,
      ],
    );
    return rowToRevision(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    throw new DirectivePersistenceError(
      `operator_directive_revisions insert failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Public entry point -- one of the eight core services. Opens its own transaction. */
export async function appendDirectiveRevision(input: AppendDirectiveRevisionInput): Promise<OperatorDirectiveRevision> {
  return withTenantTransaction(input.tenantId, (client) => insertDirectiveRevisionRow(client, input));
}
