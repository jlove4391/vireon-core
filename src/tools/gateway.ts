import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import { buildIdempotencyKey } from "../shared/ids.js";
import { redactSecretLikeValues } from "../../tools/diagnostics/sanitizeReceipt.js";
import { ToolAuthorityDeniedError } from "./errors.js";
import { resolveTool } from "./registry.js";
import type { ToolExecutionContext, ToolInvocationResult } from "./types.js";

const AUTHORITY_TIER: Readonly<Record<"act" | "act_and_report", number>> = {
  act: 2,
  act_and_report: 1,
};

function authoritySatisfiesRequirement(
  outcome: "act" | "act_and_report",
  requirement: "act" | "act_and_report",
): boolean {
  return AUTHORITY_TIER[outcome] >= AUTHORITY_TIER[requirement];
}

const MAX_STORED_STRING_LENGTH = 500;

/** Truncates any individual string value beyond a compact preview -- §6: "store compact evidence, reference large content rather than duplicating it." Tool outputs are already designed to be references (path/hash/byteCount), not raw content, so this mainly guards tool *inputs* (e.g. artifact.write's full Markdown body). */
function truncateLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STORED_STRING_LENGTH) return value;
    return `${value.slice(0, 200)}... [truncated, ${value.length} chars total]`;
  }
  if (Array.isArray(value)) return value.map(truncateLongStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateLongStrings(v)]));
  }
  return value;
}

function sanitizeJsonValue(value: unknown): unknown {
  try {
    const redacted = JSON.parse(redactSecretLikeValues(JSON.stringify(value)));
    return truncateLongStrings(redacted);
  } catch {
    return null;
  }
}

interface InvocationRow {
  id: string;
  status: "pending" | "succeeded" | "failed";
  output_payload: unknown;
  error_payload: { code?: string; message: string } | null;
}

/**
 * All registered-tool execution passes through this one gateway (§6). The
 * gateway -- not individual callers -- owns invocation persistence.
 *
 * Authority is independently re-verified here via a fresh, locked database
 * query against the WorkOrder's real linked AuthorityDecision, mirroring
 * NEXORA.md §11.1's pre-flight pattern -- the caller-supplied
 * context.authorityOutcome is never trusted as the security decision by
 * itself, so a caller bug (a stale or fabricated context) cannot bypass the
 * check.
 */
export async function invokeRegisteredTool<Input = unknown, Output = unknown>(input: {
  toolName: string;
  input: Input;
  context: ToolExecutionContext;
}): Promise<ToolInvocationResult<Output>> {
  const tool = resolveTool(input.toolName);

  const verifiedOutcome = await withTenantTransaction(input.context.tenantId, async (client) => {
    const result = await client.query(
      `SELECT ad.outcome AS outcome
       FROM work_orders wo
       LEFT JOIN authority_decisions ad ON ad.id = wo.authority_decision_id
       WHERE wo.id = $1 AND wo.tenant_id = $2
       FOR UPDATE OF wo`,
      [input.context.workOrderId, input.context.tenantId],
    );
    return (result.rows[0]?.outcome as string | undefined) ?? null;
  });

  if (verifiedOutcome !== "act" && verifiedOutcome !== "act_and_report") {
    throw new ToolAuthorityDeniedError(tool.name, verifiedOutcome ?? "none");
  }
  if (!authoritySatisfiesRequirement(verifiedOutcome, tool.authorityRequirement)) {
    throw new ToolAuthorityDeniedError(tool.name, verifiedOutcome);
  }

  const idempotencyKey = buildIdempotencyKey([
    input.context.tenantId,
    input.context.workOrderId,
    tool.name,
    tool.version,
  ]);

  const candidateId = randomUUID();
  const now = new Date().toISOString();

  const insertResult = await withTenantTransaction(input.context.tenantId, async (client) => {
    return client.query(
      `INSERT INTO tool_invocations
         (id, tenant_id, run_id, work_order_id, tool_identifier, tool_version, authority_decision_id,
          input_payload, output_payload, status, error_payload, idempotency_key, created_at)
       VALUES ($1,$2,NULL,$3,$4,$5,NULL,$6,'{}'::jsonb,'pending',NULL,$7,$8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        candidateId,
        input.context.tenantId,
        input.context.workOrderId,
        tool.name,
        tool.version,
        JSON.stringify(sanitizeJsonValue(input.input)),
        idempotencyKey,
        now,
      ],
    );
  });

  if (insertResult.rows.length === 0) {
    // Replay: an invocation for this (tenant, work order, tool, version)
    // already exists. Do not re-validate input, do not re-execute the
    // handler -- return the prior terminal result (§12).
    const existingRow = await withTenantTransaction(input.context.tenantId, async (client) => {
      const result = await client.query(
        "SELECT * FROM tool_invocations WHERE tenant_id = $1 AND idempotency_key = $2",
        [input.context.tenantId, idempotencyKey],
      );
      return result.rows[0] as InvocationRow;
    });
    return {
      invocationId: existingRow.id,
      toolName: tool.name,
      toolVersion: tool.version,
      status: existingRow.status,
      output: existingRow.output_payload as Output | undefined,
      error: existingRow.error_payload ?? undefined,
    };
  }

  const invocationId = insertResult.rows[0]!.id as string;

  async function markFailed(code: string, message: string): Promise<ToolInvocationResult<Output>> {
    const sanitizedMessage = redactSecretLikeValues(message);
    await withTenantTransaction(input.context.tenantId, async (client) => {
      await client.query(
        `UPDATE tool_invocations SET status = 'failed', error_payload = $1, completed_at = $2 WHERE id = $3`,
        [JSON.stringify({ code, message: sanitizedMessage }), new Date().toISOString(), invocationId],
      );
    });
    return {
      invocationId,
      toolName: tool.name,
      toolVersion: tool.version,
      status: "failed",
      error: { code, message: sanitizedMessage },
    };
  }

  const parsedInput = tool.inputSchema.safeParse(input.input);
  if (!parsedInput.success) {
    return markFailed("INVALID_INPUT", parsedInput.error.message);
  }

  let rawOutput: unknown;
  try {
    rawOutput = await tool.execute(parsedInput.data, input.context);
  } catch (error) {
    return markFailed("EXECUTION_FAILED", error instanceof Error ? error.message : String(error));
  }

  const parsedOutput = tool.outputSchema.safeParse(rawOutput);
  if (!parsedOutput.success) {
    return markFailed("INVALID_OUTPUT", parsedOutput.error.message);
  }

  await withTenantTransaction(input.context.tenantId, async (client) => {
    await client.query(
      `UPDATE tool_invocations SET status = 'succeeded', output_payload = $1, completed_at = $2 WHERE id = $3`,
      [JSON.stringify(sanitizeJsonValue(parsedOutput.data)), new Date().toISOString(), invocationId],
    );
  });

  return {
    invocationId,
    toolName: tool.name,
    toolVersion: tool.version,
    status: "succeeded",
    output: parsedOutput.data as Output,
  };
}
