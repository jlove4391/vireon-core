import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { EloraActorNotFoundError, EloraContextResolutionError, EloraTenantMismatchError } from "./errors.js";
import type { NormalizedEloraIngress } from "./types.js";

export interface ResolvedEloraContext {
  tenantId: string;
  workspaceId: string | null;
  projectId: string | null;
  threadId: string | null;
  actorId: string;
}

/**
 * Verifies every id on the ingress input resolves under the given tenant
 * before any write happens. RLS scopes every query to tenantId, so a row
 * that exists but belongs to a different tenant is invisible here --
 * indistinguishable from "doesn't exist" by design (same behavior as
 * tools/diagnostics/workOrder.ts's getWorkOrderDetail). A genuine mismatch
 * that IS detectable -- an explicit project/workspace pair that don't
 * belong to each other, both resolved under the correct tenant -- raises
 * EloraTenantMismatchError instead.
 */
export async function resolveContext(input: NormalizedEloraIngress): Promise<ResolvedEloraContext> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const actorResult = await client.query("SELECT id FROM actors WHERE id = $1 AND tenant_id = $2", [
      input.actorId,
      input.tenantId,
    ]);
    if (actorResult.rows.length === 0) {
      throw new EloraActorNotFoundError(input.actorId);
    }

    let resolvedWorkspaceId = input.workspaceId;

    if (input.projectId) {
      const projectResult = await client.query(
        "SELECT id, workspace_id FROM projects WHERE id = $1 AND tenant_id = $2",
        [input.projectId, input.tenantId],
      );
      const projectRow = projectResult.rows[0] as { id: string; workspace_id: string } | undefined;
      if (!projectRow) {
        throw new EloraContextResolutionError("project", input.projectId);
      }
      if (input.workspaceId && projectRow.workspace_id !== input.workspaceId) {
        throw new EloraTenantMismatchError(input.projectId, input.workspaceId, projectRow.workspace_id);
      }
      // projects.workspace_id is NOT NULL, so a valid project already
      // implies a valid workspace -- derive it when not explicitly supplied.
      resolvedWorkspaceId = projectRow.workspace_id;
    } else if (input.workspaceId) {
      const workspaceResult = await client.query("SELECT id FROM workspaces WHERE id = $1 AND tenant_id = $2", [
        input.workspaceId,
        input.tenantId,
      ]);
      if (workspaceResult.rows.length === 0) {
        throw new EloraContextResolutionError("workspace", input.workspaceId);
      }
    }

    if (input.threadId) {
      const threadResult = await client.query("SELECT id FROM threads WHERE id = $1 AND tenant_id = $2", [
        input.threadId,
        input.tenantId,
      ]);
      if (threadResult.rows.length === 0) {
        throw new EloraContextResolutionError("thread", input.threadId);
      }
    }

    return {
      tenantId: input.tenantId,
      workspaceId: resolvedWorkspaceId,
      projectId: input.projectId,
      threadId: input.threadId,
      actorId: input.actorId,
    };
  });
}
