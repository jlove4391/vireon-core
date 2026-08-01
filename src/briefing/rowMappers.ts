import { briefingIssueEntrySchema, briefingIssueSchema, type BriefingIssue, type BriefingIssueEntry } from "../schemas/briefingIssue.js";

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : (value as string);
}

function toDateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value as string;
}

export function rowToBriefingIssue(row: Record<string, unknown>): BriefingIssue {
  return briefingIssueSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    briefing_type: row.briefing_type,
    local_issue_date: toDateOnly(row.local_issue_date),
    timezone: row.timezone,
    status: row.status,
    issued_by_actor_id: row.issued_by_actor_id,
    source_message_id: row.source_message_id,
    source_work_order_id: row.source_work_order_id,
    first_move_directive_id: row.first_move_directive_id,
    prose_artifact_id: row.prose_artifact_id,
    idempotency_key: row.idempotency_key,
    generated_at: toIso(row.generated_at),
    published_at: toIso(row.published_at),
    closed_at: toIso(row.closed_at),
    created_at: toIso(row.created_at),
  });
}

export function rowToBriefingIssueEntry(row: Record<string, unknown>): BriefingIssueEntry {
  return briefingIssueEntrySchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    briefing_issue_id: row.briefing_issue_id,
    directive_id: row.directive_id,
    directive_revision_id: row.directive_revision_id,
    work_order_id: row.work_order_id,
    action_receipt_id: row.action_receipt_id,
    memory_candidate_id: row.memory_candidate_id,
    lane: row.lane,
    rank: row.rank,
    entry_status: row.entry_status,
    new_to_issue: row.new_to_issue,
    carried_from_issue_id: row.carried_from_issue_id,
    age_days_snapshot: row.age_days_snapshot,
    carry_count_snapshot: row.carry_count_snapshot,
    defer_count_snapshot: row.defer_count_snapshot,
    escalation_level_snapshot: row.escalation_level_snapshot,
    inclusion_reason: row.inclusion_reason,
    created_at: toIso(row.created_at),
  });
}
