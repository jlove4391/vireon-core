import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { buildIdempotencyKey } from "../../shared/ids.js";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import {
  ensureWorkspaceRoot,
  loadWorkspaceConfig,
  removeWorkspaceFileQuietly,
  resolveContainedPath,
  resolveWorkspaceRoot,
  writeWorkspaceFile,
} from "../workspace.js";

const artifactWriteInputSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
  mimeType: z.literal("text/markdown"),
  title: z.string().optional(),
});

const artifactWriteOutputSchema = z.object({
  artifactId: z.string().uuid(),
  relativePath: z.string().min(1),
  mimeType: z.literal("text/markdown"),
  byteCount: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
});

export type ArtifactWriteInput = z.infer<typeof artifactWriteInputSchema>;
export type ArtifactWriteOutput = z.infer<typeof artifactWriteOutputSchema>;

/**
 * The primary Phase 5 acceptance-test tool (§11.3). Uses the shared bounded
 * workspace service (§7) directly -- does not recursively invoke
 * core.local_file.write through the registry/gateway (nested tool-to-tool
 * calls are out of scope, §13). Artifact-row creation is gated behind the
 * gateway's own tool_invocations insert-or-fetch outcome: this handler is
 * only ever called once per WorkOrder in practice, since the gateway
 * short-circuits a replay before ever calling execute() again -- but the
 * handler still guards its own artifacts insert with a matching
 * insert-or-fetch on the same idempotency key, for defense in depth.
 */
export const artifactWriteTool: ToolDefinition<ArtifactWriteInput, ArtifactWriteOutput> = {
  name: "core.artifact.write",
  version: "1.0",
  description: "Writes a local Markdown artifact into the tenant/workspace-scoped bounded workspace and persists a durable artifacts row.",
  operation: "write",
  authorityRequirement: "act_and_report",
  inputSchema: artifactWriteInputSchema,
  outputSchema: artifactWriteOutputSchema,

  async execute(input: ArtifactWriteInput, context: ToolExecutionContext): Promise<ArtifactWriteOutput> {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, context.tenantId, context.workspaceId ?? null);
    await ensureWorkspaceRoot(root);

    const relativePath = `artifacts/${input.filename}`;
    const writeResult = await writeWorkspaceFile(config, root, relativePath, input.content, { allowOverwrite: false });

    const idempotencyKey = buildIdempotencyKey([context.tenantId, context.workOrderId, "artifact", "core.artifact.write"]);
    const artifactId = randomUUID();

    try {
      const insertResult = await withTenantTransaction(context.tenantId, async (client) => {
        return client.query(
          `INSERT INTO artifacts
             (id, tenant_id, workspace_id, project_id, work_order_id, run_id, actor_id, receipt_id,
              artifact_type, storage_reference, content_pointer, mime_type, byte_count, content_hash,
              idempotency_key, created_at)
           VALUES ($1,$2,$3,$4,$5,NULL,$6,NULL,'markdown_document',$7,NULL,$8,$9,$10,$11,$12)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING *`,
          [
            artifactId,
            context.tenantId,
            context.workspaceId ?? null,
            context.projectId ?? null,
            context.workOrderId,
            context.actorId,
            writeResult.relativePath,
            input.mimeType,
            writeResult.byteCount,
            writeResult.contentHash,
            idempotencyKey,
            new Date().toISOString(),
          ],
        );
      });

      if (insertResult.rows.length === 0) {
        // A prior fresh attempt already persisted this artifact -- the
        // gateway's own insert-or-fetch would normally have caught this
        // before ever calling execute() again, but guard defensively
        // rather than leave a second file write unaccounted for.
        const existing = await withTenantTransaction(context.tenantId, async (client) => {
          const result = await client.query(
            "SELECT * FROM artifacts WHERE tenant_id = $1 AND idempotency_key = $2",
            [context.tenantId, idempotencyKey],
          );
          return result.rows[0] as Record<string, unknown>;
        });
        return {
          artifactId: existing.id as string,
          relativePath: existing.storage_reference as string,
          mimeType: existing.mime_type as "text/markdown",
          byteCount: existing.byte_count as number,
          contentHash: existing.content_hash as string,
        };
      }
    } catch (error) {
      // Avoid leaving a successful file write with no corresponding
      // artifacts row if DB persistence fails (§15).
      await removeWorkspaceFileQuietly(resolveContainedPath(root, relativePath));
      throw error;
    }

    return {
      artifactId,
      relativePath: writeResult.relativePath,
      mimeType: input.mimeType,
      byteCount: writeResult.byteCount,
      contentHash: writeResult.contentHash,
    };
  },
};
