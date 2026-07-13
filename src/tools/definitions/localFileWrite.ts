import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import { ensureWorkspaceRoot, loadWorkspaceConfig, resolveWorkspaceRoot, writeWorkspaceFile } from "../workspace.js";

const localFileWriteInputSchema = z.object({
  relativePath: z.string().min(1),
  content: z.string(),
  allowOverwrite: z.boolean().optional(),
});

const localFileWriteOutputSchema = z.object({
  relativePath: z.string().min(1),
  byteCount: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
  created: z.boolean(),
  overwritten: z.boolean(),
});

export type LocalFileWriteInput = z.infer<typeof localFileWriteInputSchema>;
export type LocalFileWriteOutput = z.infer<typeof localFileWriteOutputSchema>;

/** §11.2: relative paths, UTF-8 content, controlled parent-directory creation, explicit overwrite behavior (default: no overwrite), atomic writes where practical, configured byte limit. No deletes, renames, permission changes, binary writes, or unbounded appends. */
export const localFileWriteTool: ToolDefinition<LocalFileWriteInput, LocalFileWriteOutput> = {
  name: "core.local_file.write",
  version: "1.0",
  description: "Writes UTF-8 content to a file in the tenant/workspace-scoped bounded workspace.",
  operation: "write",
  authorityRequirement: "act_and_report",
  inputSchema: localFileWriteInputSchema,
  outputSchema: localFileWriteOutputSchema,

  async execute(input: LocalFileWriteInput, context: ToolExecutionContext): Promise<LocalFileWriteOutput> {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, context.tenantId, context.workspaceId ?? null);
    await ensureWorkspaceRoot(root);
    const result = await writeWorkspaceFile(config, root, input.relativePath, input.content, {
      allowOverwrite: input.allowOverwrite ?? false,
    });
    return result;
  },
};
