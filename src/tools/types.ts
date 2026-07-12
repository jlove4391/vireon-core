import type { ZodType } from "zod";

/**
 * Static, in-process tool registry (§5). No dynamic loading, no remote
 * tools, no manifest discovery, no plugin marketplace. Tool version is
 * metadata ("1.0"), not encoded into the name.
 */
export interface ToolDefinition<Input, Output> {
  name: string;
  version: string;
  description: string;

  operation: "read" | "write";
  authorityRequirement: "act" | "act_and_report";

  inputSchema: ZodType<Input>;
  outputSchema: ZodType<Output>;

  execute(input: Input, context: ToolExecutionContext): Promise<Output>;
}

/**
 * workOrderId is not optional (§5): every tool actually registered in
 * Phase 5 (artifact.write, local_file.read, local_file.write) only ever
 * executes after a WorkOrder exists (post-READY_TO_ACT), since the four
 * bootstrap-problem tools that would need it optional are deliberately out
 * of scope (§4).
 */
export interface ToolExecutionContext {
  tenantId: string;
  actorId: string;
  workspaceId?: string;
  projectId?: string;

  workOrderId: string;
  threadId?: string;
  sourceMessageId?: string;

  authorityOutcome: "act" | "act_and_report";
  actingSystem: string;
  correlationId: string;
}

export type ToolInvocationStatus = "pending" | "succeeded" | "failed";

export interface ToolInvocationFailure {
  code?: string;
  message: string;
}

/** Result returned by the gateway (§6) -- typed success or typed failure, never a thrown exception for an expected failure mode. */
export interface ToolInvocationResult<Output = unknown> {
  invocationId: string;
  toolName: string;
  toolVersion: string;
  status: ToolInvocationStatus;
  output?: Output;
  error?: ToolInvocationFailure;
}
