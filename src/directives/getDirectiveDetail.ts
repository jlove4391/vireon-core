import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirective, OperatorDirectiveRevision } from "../schemas/operatorDirective.js";
import { DirectiveNotFoundError } from "./errors.js";
import { rowToDirective, rowToRevision } from "./rowMappers.js";

export interface DirectiveDetail {
  directive: OperatorDirective;
  latestRevision: OperatorDirectiveRevision | null;
  /** Derived from operator_directive_provenance -- never stored (avoids counter drift). Count of recorded detection events, including the one that created the Directive. */
  carryCount: number;
  /** Derived from operator_directive_transitions where to_state = 'DEFERRED'. Never stored. */
  deferCount: number;
  /**
   * Derived, never stored. Placeholder heuristic only -- the spec names
   * this as a derived value but doesn't define its formula, and no
   * acceptance criterion tests a specific value; mirrors deferCount for
   * now. The real formula (likely combining defer history, overdue
   * status, and possibly briefing-cycle count) is a 6L design question,
   * not resolved here -- flagged, not invented.
   */
  escalationLevel: number;
}

/** One of the eight core services. Read-only. */
export async function getDirectiveDetail(tenantId: string, directiveId: string): Promise<DirectiveDetail> {
  return withTenantTransaction(tenantId, async (client) => {
    const directiveResult = await client.query("SELECT * FROM operator_directives WHERE id = $1 AND tenant_id = $2", [
      directiveId,
      tenantId,
    ]);
    if (directiveResult.rows.length === 0) {
      throw new DirectiveNotFoundError(directiveId);
    }
    const directive = rowToDirective(directiveResult.rows[0] as Record<string, unknown>);

    const latestRevisionResult = await client.query(
      "SELECT * FROM operator_directive_revisions WHERE tenant_id = $1 AND directive_id = $2 ORDER BY revision_number DESC LIMIT 1",
      [tenantId, directiveId],
    );
    const latestRevision = latestRevisionResult.rows[0]
      ? rowToRevision(latestRevisionResult.rows[0] as Record<string, unknown>)
      : null;

    const carryCountResult = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM operator_directive_provenance WHERE tenant_id = $1 AND directive_id = $2",
      [tenantId, directiveId],
    );
    const carryCount = carryCountResult.rows[0]?.n ?? 0;

    const deferCountResult = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM operator_directive_transitions WHERE tenant_id = $1 AND directive_id = $2 AND to_state = 'DEFERRED'",
      [tenantId, directiveId],
    );
    const deferCount = deferCountResult.rows[0]?.n ?? 0;

    return { directive, latestRevision, carryCount, deferCount, escalationLevel: deferCount };
  });
}
