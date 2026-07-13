import type { EloraStructuredIntent } from "./types.js";

export interface DispatchedToolCall {
  toolName: string;
  input: { filename: string; content: string; mimeType: "text/markdown" };
}

/**
 * Deterministic, code-defined mapping from parsed intent to a registered
 * tool name (§10). The model or user-supplied text never directly names a
 * tool for execution -- this is a closed dispatch table, not a lookup on
 * arbitrary input. Returns null when the intent doesn't map to any
 * registered tool, which is the normal case for every non-artifact
 * conversational request.
 */
export function dispatchTool(intent: EloraStructuredIntent): DispatchedToolCall | null {
  if (intent.task_type === "artifact_creation" && intent.artifactRequest) {
    return {
      toolName: "core.artifact.write",
      input: {
        filename: intent.artifactRequest.filename,
        content: intent.artifactRequest.content,
        mimeType: "text/markdown",
      },
    };
  }
  return null;
}
