import { createHash } from "node:crypto";

export interface DirectiveContentFields {
  title: string;
  body?: string | null;
  whyNow?: string | null;
  priority?: string | null;
  proposedOwnerActorId?: string | null;
  dueAt?: string | null;
  windowStartAt?: string | null;
  windowEndAt?: string | null;
  expiresAt?: string | null;
}

/**
 * "Material content" fingerprint -- same shape as createWorkOrder.ts's
 * own intentFingerprint, generalized to a full field set. Used by
 * createOrMergeDirective.ts to decide revise vs carry: a re-detection
 * whose canonical fields hash identically to the latest revision is a
 * carry (no new revision), one that differs is a revision.
 */
export function computeDirectiveContentHash(fields: DirectiveContentFields): string {
  const canonical = JSON.stringify({
    title: fields.title,
    body: fields.body ?? null,
    whyNow: fields.whyNow ?? null,
    priority: fields.priority ?? null,
    proposedOwnerActorId: fields.proposedOwnerActorId ?? null,
    dueAt: fields.dueAt ?? null,
    windowStartAt: fields.windowStartAt ?? null,
    windowEndAt: fields.windowEndAt ?? null,
    expiresAt: fields.expiresAt ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
