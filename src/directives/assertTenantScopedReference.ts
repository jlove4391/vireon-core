import type { PoolClient } from "pg";
import { assertTenantScopedReference as assertTenantScopedReferenceCore } from "../db/assertTenantScopedReference.js";
import { DirectiveReferenceNotFoundError } from "./errors.js";

/**
 * Directives-domain wrapper over the shared, domain-neutral
 * src/db/assertTenantScopedReference.ts core (same query shape, not
 * reimplemented here) -- this file only supplies this domain's own error
 * type (DirectiveReferenceNotFoundError) and the `field` label every
 * existing call site in this domain already passes. Kept as its own
 * module, rather than inlined at each call site, purely so this domain's
 * existing four call sites (addDirectiveProvenance.ts,
 * transitionDirective.ts, appendDirectiveRevision.ts,
 * suppressDirectiveKey.ts) don't need to change.
 *
 * `table` must always be a fixed, hardcoded string literal from this
 * domain's own call sites -- never derived from caller input -- since it
 * is interpolated directly into the query by the shared core.
 */
export async function assertTenantScopedReference(
  client: PoolClient,
  table: string,
  id: string,
  tenantId: string,
  field: string,
): Promise<void> {
  return assertTenantScopedReferenceCore(client, table, id, tenantId, () => new DirectiveReferenceNotFoundError(field, id));
}
