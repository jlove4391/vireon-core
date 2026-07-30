import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirectiveSuppression } from "../schemas/operatorDirective.js";
import { assertTenantScopedReference } from "./assertTenantScopedReference.js";
import { DirectivePersistenceError, InvalidDirectiveInputError } from "./errors.js";
import { rowToSuppression } from "./rowMappers.js";

export interface SuppressDirectiveKeyInput {
  tenantId: string;
  dedupeKey: string;
  reason: string;
  suppressedByActorId: string;
  suppressedUntil: string;
}

/**
 * Append-only, one history row per suppression request -- not a single
 * mutable per-key row (no uniqueness constraint on dedupe_key). Whether a
 * key is currently suppressed is a read-time question
 * (createOrMergeDirective.ts's own "inspect suppression" step checks for
 * any row with suppressed_until > now()), not a stored boolean.
 * Re-suppressing an already-suppressed key simply adds another row
 * (e.g. extending or shortening the effective window) rather than
 * updating one in place.
 */
export async function suppressDirectiveKey(input: SuppressDirectiveKeyInput): Promise<OperatorDirectiveSuppression> {
  if (!input.dedupeKey.trim()) {
    throw new InvalidDirectiveInputError("dedupeKey must not be empty");
  }
  if (!input.reason.trim()) {
    throw new InvalidDirectiveInputError("reason must not be empty");
  }
  if (Number.isNaN(new Date(input.suppressedUntil).getTime())) {
    throw new InvalidDirectiveInputError("suppressedUntil must be a valid datetime");
  }

  // Trimmed once, used everywhere below: createOrMergeDirective.ts's
  // suppression lookup always compares against dedupeKey.trim(), so a key
  // stored here with incidental leading/trailing whitespace would silently
  // never match and the suppression would block nothing.
  const dedupeKey = input.dedupeKey.trim();

  return withTenantTransaction(input.tenantId, async (client) => {
    await assertTenantScopedReference(client, "actors", input.suppressedByActorId, input.tenantId, "suppressedByActorId");

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      const result = await client.query(
        `INSERT INTO operator_directive_suppressions
           (id, tenant_id, dedupe_key, reason, suppressed_by_actor_id, suppressed_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [id, input.tenantId, dedupeKey, input.reason, input.suppressedByActorId, input.suppressedUntil, now],
      );
      return rowToSuppression(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      throw new DirectivePersistenceError(
        `operator_directive_suppressions insert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
