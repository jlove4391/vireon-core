// Phase 5 §4: registers exactly three tools, deliberately not seven. See
// registry.ts/gateway.ts for the registration/invocation machinery.
import { artifactWriteTool } from "./definitions/artifactWrite.js";
import { localFileReadTool } from "./definitions/localFileRead.js";
import { localFileWriteTool } from "./definitions/localFileWrite.js";
import { registerTool } from "./registry.js";

let registered = false;

/** Idempotent: safe to call from multiple entrypoints (orchestrator, tests, diagnostics) without tripping DuplicateToolNameError. */
export function registerCoreTools(): void {
  if (registered) return;
  registerTool(artifactWriteTool);
  registerTool(localFileReadTool);
  registerTool(localFileWriteTool);
  registered = true;
}

export { invokeRegisteredTool } from "./gateway.js";
export { isToolRegistered, listRegisteredTools, resolveTool } from "./registry.js";
export type { ToolDefinition, ToolExecutionContext, ToolInvocationResult } from "./types.js";
