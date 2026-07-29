import {
  operatorDirectiveProvenanceSchema,
  operatorDirectiveRevisionSchema,
  operatorDirectiveSchema,
  operatorDirectiveSuppressionSchema,
  operatorDirectiveTransitionSchema,
  type OperatorDirective,
  type OperatorDirectiveProvenance,
  type OperatorDirectiveRevision,
  type OperatorDirectiveSuppression,
  type OperatorDirectiveTransition,
} from "../schemas/operatorDirective.js";

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : (value as string);
}

export function rowToDirective(row: Record<string, unknown>): OperatorDirective {
  return operatorDirectiveSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    directive_type: row.directive_type,
    state: row.state,
    dedupe_key: row.dedupe_key,
    cycle_number: row.cycle_number,
    issuing_actor_id: row.issuing_actor_id,
    owning_actor_id: row.owning_actor_id,
    first_seen_at: toIso(row.first_seen_at),
    last_seen_at: toIso(row.last_seen_at),
    accepted_at: toIso(row.accepted_at),
    started_at: toIso(row.started_at),
    completed_at: toIso(row.completed_at),
    deferred_at: toIso(row.deferred_at),
    dismissed_at: toIso(row.dismissed_at),
    expires_at: toIso(row.expires_at),
    due_at: toIso(row.due_at),
    window_start_at: toIso(row.window_start_at),
    window_end_at: toIso(row.window_end_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

export function rowToRevision(row: Record<string, unknown>): OperatorDirectiveRevision {
  return operatorDirectiveRevisionSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    directive_id: row.directive_id,
    revision_number: row.revision_number,
    title: row.title,
    body: row.body,
    why_now: row.why_now,
    priority: row.priority,
    proposed_owner_actor_id: row.proposed_owner_actor_id,
    due_at: toIso(row.due_at),
    window_start_at: toIso(row.window_start_at),
    window_end_at: toIso(row.window_end_at),
    expires_at: toIso(row.expires_at),
    content_hash: row.content_hash,
    change_reason: row.change_reason,
    created_by_actor_id: row.created_by_actor_id,
    created_at: toIso(row.created_at),
  });
}

export function rowToTransition(row: Record<string, unknown>): OperatorDirectiveTransition {
  return operatorDirectiveTransitionSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    directive_id: row.directive_id,
    from_state: row.from_state,
    to_state: row.to_state,
    actor_id: row.actor_id,
    transition_type: row.transition_type,
    reason: row.reason,
    metadata: row.metadata,
    created_at: toIso(row.created_at),
  });
}

export function rowToProvenance(row: Record<string, unknown>): OperatorDirectiveProvenance {
  return operatorDirectiveProvenanceSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    directive_id: row.directive_id,
    message_id: row.message_id,
    work_order_id: row.work_order_id,
    run_id: row.run_id,
    authority_decision_id: row.authority_decision_id,
    tool_invocation_id: row.tool_invocation_id,
    action_receipt_id: row.action_receipt_id,
    artifact_id: row.artifact_id,
    memory_candidate_id: row.memory_candidate_id,
    memory_record_id: row.memory_record_id,
    provider: row.provider,
    external_identifier: row.external_identifier,
    external_locator: row.external_locator,
    label: row.label,
    observed_at: toIso(row.observed_at),
    content_hash: row.content_hash,
    metadata: row.metadata,
    created_at: toIso(row.created_at),
  });
}

export function rowToSuppression(row: Record<string, unknown>): OperatorDirectiveSuppression {
  return operatorDirectiveSuppressionSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    dedupe_key: row.dedupe_key,
    reason: row.reason,
    suppressed_by_actor_id: row.suppressed_by_actor_id,
    suppressed_until: toIso(row.suppressed_until),
    created_at: toIso(row.created_at),
  });
}
