import { DuplicateToolNameError, ToolNotFoundError } from "./errors.js";
import type { ToolDefinition } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDefinition = ToolDefinition<any, any>;

const registeredTools = new Map<string, AnyToolDefinition>();

/** Registers a tool under its canonical name. Throws DuplicateToolNameError on a name collision. */
export function registerTool<Input, Output>(definition: ToolDefinition<Input, Output>): void {
  if (registeredTools.has(definition.name)) {
    throw new DuplicateToolNameError(definition.name);
  }
  registeredTools.set(definition.name, definition as AnyToolDefinition);
}

/** Resolves a tool by exact name only. Throws ToolNotFoundError if unregistered. */
export function resolveTool(name: string): AnyToolDefinition {
  const tool = registeredTools.get(name);
  if (!tool) {
    throw new ToolNotFoundError(name);
  }
  return tool;
}

/** True if a tool name is registered, without throwing -- used for the §8.3 defensive registry check. */
export function isToolRegistered(name: string): boolean {
  return registeredTools.has(name);
}

/** Deterministic list of registered tool metadata (name/version/description/operation/authorityRequirement), no execution. */
export function listRegisteredTools(): Array<
  Pick<AnyToolDefinition, "name" | "version" | "description" | "operation" | "authorityRequirement">
> {
  return Array.from(registeredTools.values())
    .map((tool) => ({
      name: tool.name,
      version: tool.version,
      description: tool.description,
      operation: tool.operation,
      authorityRequirement: tool.authorityRequirement,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
