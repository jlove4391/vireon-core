import { EloraInvalidIngressInputError } from "./errors.js";
import type { EloraIngressInput, NormalizedEloraIngress } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOptionalId(label: string, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!UUID_PATTERN.test(value)) {
    throw new EloraInvalidIngressInputError(`${label} must be a valid UUID`);
  }
  return value;
}

/** Pure normalization -- no DB access. Validates shape only, never existence. */
export function normalizeIngress(input: EloraIngressInput): NormalizedEloraIngress {
  if (!UUID_PATTERN.test(input.tenantId)) {
    throw new EloraInvalidIngressInputError("tenantId must be a valid UUID");
  }
  if (!UUID_PATTERN.test(input.actorId)) {
    throw new EloraInvalidIngressInputError("actorId must be a valid UUID");
  }

  const content = input.content.trim();
  if (content.length === 0) {
    throw new EloraInvalidIngressInputError("content must not be empty");
  }

  return {
    tenantId: input.tenantId,
    workspaceId: normalizeOptionalId("workspaceId", input.workspaceId),
    projectId: normalizeOptionalId("projectId", input.projectId),
    threadId: normalizeOptionalId("threadId", input.threadId),
    actorId: input.actorId,
    content,
    sourceSurface: input.sourceSurface?.trim() || null,
    sourceCorrelationId: input.sourceCorrelationId?.trim() || null,
  };
}
