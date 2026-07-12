import { z } from "zod";
import type { ToolDefinition, ToolExecutionContext } from "../types.js";
import { loadWorkspaceConfig, readWorkspaceFile, resolveWorkspaceRoot } from "../workspace.js";

const localFileReadInputSchema = z.object({
  relativePath: z.string().min(1),
});

const localFileReadOutputSchema = z.object({
  relativePath: z.string().min(1),
  content: z.string(),
  byteCount: z.number().int().nonnegative(),
  contentHash: z.string().min(1),
});

export type LocalFileReadInput = z.infer<typeof localFileReadInputSchema>;
export type LocalFileReadOutput = z.infer<typeof localFileReadOutputSchema>;

/** §11.1: relative paths only, UTF-8 text, regular files only, bounded by the workspace root and configured byte limit. No binary, no recursive reads, no globs, no execution, no network paths, no absolute paths. */
export const localFileReadTool: ToolDefinition<LocalFileReadInput, LocalFileReadOutput> = {
  name: "core.local_file.read",
  version: "1.0",
  description: "Reads a UTF-8 text file from the tenant/workspace-scoped bounded workspace.",
  operation: "read",
  authorityRequirement: "act_and_report",
  inputSchema: localFileReadInputSchema,
  outputSchema: localFileReadOutputSchema,

  async execute(input: LocalFileReadInput, context: ToolExecutionContext): Promise<LocalFileReadOutput> {
    const config = loadWorkspaceConfig();
    const root = resolveWorkspaceRoot(config, context.tenantId, context.workspaceId ?? null);
    const result = await readWorkspaceFile(config, root, input.relativePath);
    return {
      relativePath: result.relativePath,
      content: result.content,
      byteCount: result.byteCount,
      contentHash: result.contentHash,
    };
  },
};
