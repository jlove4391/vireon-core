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
 * This is correct by construction, not merely a discouragement: naming a
 * more-privileged persona as owner can never pass, because a superior
 * cannot appear as an ancestor of their own subordinate's chain (the
 * hierarchy has no cycles -- enforced by 6B's own schema constraints).
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
    currentActorId = superior;
  }
}
