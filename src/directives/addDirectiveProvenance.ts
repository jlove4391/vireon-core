import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { OperatorDirectiveProvenance } from "../schemas/operatorDirective.js";
import { assertTenantScopedReference } from "./assertTenantScopedReference.js";
import { DirectiveNotFoundError, DirectivePersistenceError, InvalidDirectiveInputError } from "./errors.js";
import { rowToProvenance } from "./rowMappers.js";

export type DirectiveProvenanceSource =
  | { kind: "message"; messageId: string }
  | { kind: "work_order"; workOrderId: string }
  | { kind: "run"; runId: string }
  | { kind: "authority_decision"; authorityDecisionId: string }
  | { kind: "tool_invocation"; toolInvocationId: string }
  | { kind: "action_receipt"; actionReceiptId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "memory_candidate"; memoryCandidateId: string }
  | { kind: "memory_record"; memoryRecordId: string }
  | {
      kind: "external";
      provider: string;
      externalIdentifier: string;
      externalLocator?: string | null;
      label?: string | null;
      observedAt?: string | null;
      contentHash?: string | null;
    };

export interface AddDirectiveProvenanceInput {
  tenantId: string;
  directiveId: string;
  source: DirectiveProvenanceSource;
  metadata?: Record<string, unknown>;
}

// Maps each internal source kind to its target table -- fixed, hardcoded
// literals only, per assertTenantScopedReference.ts's own requirement.
const SOURCE_KIND_TABLE: Record<Exclude<DirectiveProvenanceSource["kind"], "external">, string> = {
  message: "messages",
  work_order: "work_orders",
  run: "runs",
  authority_decision: "authority_decisions",
  tool_invocation: "tool_invocations",
  action_receipt: "action_receipts",
  artifact: "artifacts",
  memory_candidate: "memory_candidates",
  memory_record: "memory_records",
};

function validateSource(source: DirectiveProvenanceSource): void {
  if (source.kind === "external") {
    if (!source.provider.trim() || !source.externalIdentifier.trim()) {
      throw new InvalidDirectiveInputError("external provenance requires both provider and externalIdentifier");
    }
  }
}

/**
 * Client-taking core -- reused by createOrMergeDirective.ts so a
 * detection event's directive mutation (create/revise/reopen) and its
 * provenance record commit as one atomic unit, on the same transaction,
 * rather than two independently-committed operations (which would let a
 * later failure leave provenance pointing at a directive state that
 * itself got rolled back). Plain single-column FKs throughout (Option B,
 * locked in Phase A review) -- no composite tenant-safe FK treatment even
 * for work_order_id/memory_candidate_id.
 */
export async function insertDirectiveProvenanceRow(
  client: PoolClient,
  input: AddDirectiveProvenanceInput,
): Promise<OperatorDirectiveProvenance> {
  validateSource(input.source);

  const directiveResult = await client.query("SELECT id FROM operator_directives WHERE id = $1 AND tenant_id = $2", [
    input.directiveId,
    input.tenantId,
  ]);
  if (directiveResult.rows.length === 0) {
    throw new DirectiveNotFoundError(input.directiveId);
  }

  const source = input.source;

  if (source.kind !== "external") {
    const idByKind: Record<Exclude<DirectiveProvenanceSource["kind"], "external">, string> = {
      message: source.kind === "message" ? source.messageId : "",
      work_order: source.kind === "work_order" ? source.workOrderId : "",
      run: source.kind === "run" ? source.runId : "",
      authority_decision: source.kind === "authority_decision" ? source.authorityDecisionId : "",
      tool_invocation: source.kind === "tool_invocation" ? source.toolInvocationId : "",
      action_receipt: source.kind === "action_receipt" ? source.actionReceiptId : "",
      artifact: source.kind === "artifact" ? source.artifactId : "",
      memory_candidate: source.kind === "memory_candidate" ? source.memoryCandidateId : "",
      memory_record: source.kind === "memory_record" ? source.memoryRecordId : "",
    };
    await assertTenantScopedReference(client, SOURCE_KIND_TABLE[source.kind], idByKind[source.kind], input.tenantId, source.kind);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const columns = {
    message_id: source.kind === "message" ? source.messageId : null,
    work_order_id: source.kind === "work_order" ? source.workOrderId : null,
    run_id: source.kind === "run" ? source.runId : null,
    authority_decision_id: source.kind === "authority_decision" ? source.authorityDecisionId : null,
    tool_invocation_id: source.kind === "tool_invocation" ? source.toolInvocationId : null,
    action_receipt_id: source.kind === "action_receipt" ? source.actionReceiptId : null,
    artifact_id: source.kind === "artifact" ? source.artifactId : null,
    memory_candidate_id: source.kind === "memory_candidate" ? source.memoryCandidateId : null,
    memory_record_id: source.kind === "memory_record" ? source.memoryRecordId : null,
    provider: source.kind === "external" ? source.provider : null,
    external_identifier: source.kind === "external" ? source.externalIdentifier : null,
    external_locator: source.kind === "external" ? (source.externalLocator ?? null) : null,
    label: source.kind === "external" ? (source.label ?? null) : null,
    observed_at: source.kind === "external" ? (source.observedAt ?? null) : null,
    content_hash: source.kind === "external" ? (source.contentHash ?? null) : null,
  };

  try {
    const result = await client.query(
      `INSERT INTO operator_directive_provenance
         (id, tenant_id, directive_id, message_id, work_order_id, run_id, authority_decision_id,
          tool_invocation_id, action_receipt_id, artifact_id, memory_candidate_id, memory_record_id,
          provider, external_identifier, external_locator, label, observed_at, content_hash, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.directiveId,
        columns.message_id,
        columns.work_order_id,
        columns.run_id,
        columns.authority_decision_id,
        columns.tool_invocation_id,
        columns.action_receipt_id,
        columns.artifact_id,
        columns.memory_candidate_id,
        columns.memory_record_id,
        columns.provider,
        columns.external_identifier,
        columns.external_locator,
        columns.label,
        columns.observed_at,
        columns.content_hash,
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    return rowToProvenance(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    throw new DirectivePersistenceError(
      `operator_directive_provenance insert failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Public entry point -- one of the eight core services. Opens its own transaction. */
export async function addDirectiveProvenance(input: AddDirectiveProvenanceInput): Promise<OperatorDirectiveProvenance> {
  return withTenantTransaction(input.tenantId, (client) => insertDirectiveProvenanceRow(client, input));
}
