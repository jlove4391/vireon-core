// Phase 6A §6: reads the dev-only identity written by scripts/seedDevIdentity.ts.
// No auth, no sessions -- a placeholder until real identity resolution exists.
// Deliberately never read from a VITE_* variable: this stays server-side only.

export interface DevIdentity {
  tenantId: string;
  actorId: string;
  workspaceId: string;
  projectId: string;
}

export function getDevIdentity(): DevIdentity | null {
  const tenantId = process.env.VIREON_DEV_TENANT_ID;
  const actorId = process.env.VIREON_DEV_ACTOR_ID;
  const workspaceId = process.env.VIREON_DEV_WORKSPACE_ID;
  const projectId = process.env.VIREON_DEV_PROJECT_ID;

  if (!tenantId || !actorId || !workspaceId || !projectId) {
    return null;
  }

  return { tenantId, actorId, workspaceId, projectId };
}
