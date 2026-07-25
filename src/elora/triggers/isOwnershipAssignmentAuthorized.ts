import type { PoolClient } from "pg";

/**
 * Phase 6J firing-time guard (6I's own flagged precondition, resolved
 * here): a creator may only assign trigger ownership to themselves or a
 * subordinate -- never a superior. Walks owningActorId's
 * reports_to_actor_id chain upward (same direction and same table
 * resolveAuthorityWithHierarchy.ts already walks), checking whether
 * createdByActorId is the owner itself or any real ancestor anywhere in
 * that chain, arbitrary depth.
 *
 * Correct by construction *given an acyclic hierarchy*: naming a
 * more-privileged persona as owner can never pass, because a superior
 * cannot appear as an ancestor of their own subordinate's chain, as long
 * as reports_to_actor_id genuinely has no cycles. That acyclicity is
 * confirmed (Phase B review) to be an application-level convention only
 * -- upheld today solely by seedPersonaRoster.ts's own insertion order,
 * not by any CHECK constraint or trigger on `actors` (verified directly
 * against pg_constraint/pg_trigger: the only constraints on
 * reports_to_actor_id are the tenant-scoped FK and the tier-vocabulary
 * CHECKs, nothing cycle-related). A future direct UPDATE to
 * reports_to_actor_id -- through this code path or any other -- could
 * introduce a cycle the database would not reject. The visited-set guard
 * below is this function's own defense against that, not a redundant
 * check against something the schema already forbids: without it, a
 * cycle not containing createdByActorId would make this function loop
 * forever instead of returning false.
 *
 * Not built on 6D's delegation mechanism -- confirmed during 6J Phase A
 * that 6D has no production entry point and its own supervised-mode
 * authority-bounding is explicitly unenforced (AUTHORITY_AND_DELEGATION.md
 * §6); leaning on it here would mean building on a foundation that
 * doesn't yet do real consent-checking.
 */
export async function isOwnershipAssignmentAuthorized(
  client: PoolClient,
  tenantId: string,
  createdByActorId: string,
  owningActorId: string,
): Promise<boolean> {
  if (createdByActorId === owningActorId) {
    return true;
  }

  const visited = new Set<string>([owningActorId]);
  let currentActorId = owningActorId;
  for (;;) {
    const result = await client.query<{ reports_to_actor_id: string | null }>(
      "SELECT reports_to_actor_id FROM actors WHERE id = $1 AND tenant_id = $2",
      [currentActorId, tenantId],
    );
    const superior = result.rows[0]?.reports_to_actor_id ?? null;
    if (!superior) {
      // Reached the root (or an actor with no resolvable chain) without
      // ever finding createdByActorId -- not authorized.
      return false;
    }
    if (superior === createdByActorId) {
      return true;
    }
    if (visited.has(superior)) {
      // A cycle exists in reports_to_actor_id that never passes through
      // createdByActorId -- fail closed rather than loop forever.
      return false;
    }
    visited.add(superior);
    currentActorId = superior;
  }
}
