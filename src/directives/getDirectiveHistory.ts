import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type {
  OperatorDirective,
  OperatorDirectiveProvenance,
  OperatorDirectiveRevision,
  OperatorDirectiveTransition,
} from "../schemas/operatorDirective.js";
import { DirectiveNotFoundError } from "./errors.js";
import { rowToDirective, rowToProvenance, rowToRevision, rowToTransition } from "./rowMappers.js";

export interface DirectiveHistory {
  directive: OperatorDirective;
  revisions: OperatorDirectiveRevision[];
  transitions: OperatorDirectiveTransition[];
  provenance: OperatorDirectiveProvenance[];
}

/**
 * One of the eight core services. Read-only. Returns full reconstruction
 * material -- every revision, transition, and provenance row for a
 * Directive, in chronological order. Acceptance criterion #9 ("process
 * restart preserves full history") is satisfied structurally by this
 * function reading only from durable Postgres tables -- no in-memory
 * state anywhere in this domain.
 */
export async function getDirectiveHistory(tenantId: string, directiveId: string): Promise<DirectiveHistory> {
  return withTenantTransaction(tenantId, async (client) => {
    const directiveResult = await client.query("SELECT * FROM operator_directives WHERE id = $1 AND tenant_id = $2", [
      directiveId,
      tenantId,
    ]);
    if (directiveResult.rows.length === 0) {
      throw new DirectiveNotFoundError(directiveId);
    }
    const directive = rowToDirective(directiveResult.rows[0] as Record<string, unknown>);

    const revisionsResult = await client.query(
      "SELECT * FROM operator_directive_revisions WHERE tenant_id = $1 AND directive_id = $2 ORDER BY revision_number ASC",
      [tenantId, directiveId],
    );
    const transitionsResult = await client.query(
      "SELECT * FROM operator_directive_transitions WHERE tenant_id = $1 AND directive_id = $2 ORDER BY created_at ASC",
      [tenantId, directiveId],
    );
    const provenanceResult = await client.query(
      "SELECT * FROM operator_directive_provenance WHERE tenant_id = $1 AND directive_id = $2 ORDER BY created_at ASC",
      [tenantId, directiveId],
    );

    return {
      directive,
      revisions: (revisionsResult.rows as Record<string, unknown>[]).map(rowToRevision),
      transitions: (transitionsResult.rows as Record<string, unknown>[]).map(rowToTransition),
      provenance: (provenanceResult.rows as Record<string, unknown>[]).map(rowToProvenance),
    };
  });
}
