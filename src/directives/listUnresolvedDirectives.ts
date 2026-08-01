import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirective, OperatorDirectiveRevision } from "../schemas/operatorDirective.js";
import { rowToDirective, rowToRevision } from "./rowMappers.js";

export interface UnresolvedDirectiveCandidate {
  directive: OperatorDirective;
  latestRevision: OperatorDirectiveRevision | null;
  /** Derived from operator_directive_provenance, same as getDirectiveDetail.ts. */
  carryCount: number;
  /** Derived from operator_directive_transitions where to_state = 'DEFERRED', same as getDirectiveDetail.ts. */
  deferCount: number;
  /** Same provisional placeholder as getDirectiveDetail.ts -- mirrors deferCount, not a final formula. */
  escalationLevel: number;
  /**
   * Count of distinct work_order_id values recorded as provenance for this
   * Directive -- 6L's "blocking impact" first-move scoring factor
   * (number of dependent WorkOrders). New in this phase; getDirectiveDetail.ts
   * has no equivalent.
   */
  dependentWorkOrderCount: number;
}

/**
 * 6L's own read-only extension of 6K's single-directive lookup pattern
 * (getDirectiveDetail.ts/getDirectiveHistory.ts) -- lists every
 * non-terminal Directive for a tenant in one tenant-scoped query, plus
 * the same derived counters getDirectiveDetail.ts computes per-directive,
 * batched here instead of N+1'd. Not a change to any existing 6K
 * service -- purely additive, reads only.
 *
 * "Unresolved" = state NOT IN ('COMPLETED','DISMISSED','EXPIRED','SUPERSEDED'),
 * the same closed-state set 6K's own directiveState.ts treats as
 * non-terminal-but-closed or terminal. Focus directives get one
 * additional filter on top of the state check -- 6L's Fork 1 resolution:
 * "Focus directives are window-gated... a Focus whose window hasn't
 * opened doesn't belong in today's issue" -- so a Focus is only unresolved
 * *for briefing purposes* once window_start_at <= asOf, and only while
 * window_end_at (if set) hasn't yet passed. This is a briefing-collection
 * concern, not a Directive state-machine change: a not-yet-open or
 * already-closed-window Focus is still genuinely OPEN/PROPOSED in 6K's
 * own state machine, just not surfaced by this query.
 */
export async function listUnresolvedDirectives(
  tenantId: string,
  asOf: Date = new Date(),
): Promise<UnresolvedDirectiveCandidate[]> {
  return withTenantTransaction(tenantId, (client) => listUnresolvedDirectivesWithClient(client, tenantId, asOf));
}

/**
 * Client-taking core -- reused by src/briefing/collectCandidates.ts so
 * the entire briefing assembly (this read plus every other collector plus
 * the entries/issue writes) runs inside one transaction, same reasoning
 * as insertDirectiveProvenanceRow()/applyDirectiveTransition() being
 * reused by createOrMergeDirective.ts.
 */
export async function listUnresolvedDirectivesWithClient(
  client: PoolClient,
  tenantId: string,
  asOf: Date = new Date(),
): Promise<UnresolvedDirectiveCandidate[]> {
  const asOfIso = asOf.toISOString();

  const directivesResult = await client.query(
    `SELECT * FROM operator_directives
     WHERE tenant_id = $1
       AND state NOT IN ('COMPLETED', 'DISMISSED', 'EXPIRED', 'SUPERSEDED')
       AND (
         directive_type != 'focus'
         OR (window_start_at IS NOT NULL AND window_start_at <= $2 AND (window_end_at IS NULL OR window_end_at >= $2))
       )
     ORDER BY first_seen_at ASC`,
    [tenantId, asOfIso],
  );
  const directiveRows = directivesResult.rows as Record<string, unknown>[];
  if (directiveRows.length === 0) {
    return [];
  }
  const directiveIds = directiveRows.map((row) => row.id as string);

  const revisionsResult = await client.query(
    `SELECT DISTINCT ON (directive_id) *
     FROM operator_directive_revisions
     WHERE tenant_id = $1 AND directive_id = ANY($2)
     ORDER BY directive_id, revision_number DESC`,
    [tenantId, directiveIds],
  );
  const latestRevisionByDirectiveId = new Map<string, OperatorDirectiveRevision>();
  for (const row of revisionsResult.rows as Record<string, unknown>[]) {
    latestRevisionByDirectiveId.set(row.directive_id as string, rowToRevision(row));
  }

  const provenanceAggResult = await client.query<{
    directive_id: string;
    carry_count: number;
    dependent_work_order_count: number;
  }>(
    `SELECT directive_id, count(*)::int AS carry_count, count(DISTINCT work_order_id)::int AS dependent_work_order_count
     FROM operator_directive_provenance
     WHERE tenant_id = $1 AND directive_id = ANY($2)
     GROUP BY directive_id`,
    [tenantId, directiveIds],
  );
  const provenanceByDirectiveId = new Map(
    provenanceAggResult.rows.map((row) => [
      row.directive_id,
      { carryCount: row.carry_count, dependentWorkOrderCount: row.dependent_work_order_count },
    ]),
  );

  const deferAggResult = await client.query<{ directive_id: string; n: number }>(
    `SELECT directive_id, count(*)::int AS n
     FROM operator_directive_transitions
     WHERE tenant_id = $1 AND directive_id = ANY($2) AND to_state = 'DEFERRED'
     GROUP BY directive_id`,
    [tenantId, directiveIds],
  );
  const deferCountByDirectiveId = new Map(deferAggResult.rows.map((row) => [row.directive_id, row.n]));

  return directiveRows.map((row) => {
    const directive = rowToDirective(row);
    const provenance = provenanceByDirectiveId.get(directive.id) ?? { carryCount: 0, dependentWorkOrderCount: 0 };
    const deferCount = deferCountByDirectiveId.get(directive.id) ?? 0;
    return {
      directive,
      latestRevision: latestRevisionByDirectiveId.get(directive.id) ?? null,
      carryCount: provenance.carryCount,
      deferCount,
      escalationLevel: deferCount,
      dependentWorkOrderCount: provenance.dependentWorkOrderCount,
    };
  });
}
