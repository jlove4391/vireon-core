import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { BriefingIssue, BriefingIssueEntry } from "../schemas/briefingIssue.js";
import { rowToBriefingIssue, rowToBriefingIssueEntry } from "./rowMappers.js";

export interface EntryDisplayText {
  title: string;
  detail: string | null;
}

export interface BriefingIssueDetailWithDisplay {
  issue: BriefingIssue;
  entries: BriefingIssueEntry[];
  /** Keyed by entry.id -- resolved fresh from each entry's referenced row, same shape as collectCandidates.ts's own per-collector title/detail logic. Not persisted anywhere (briefing_issue_entries has no title/detail column), so this reflects the referenced row's *current* content, not a frozen-at-issuance snapshot -- only the four numeric *_snapshot columns on the entry itself are historically frozen. */
  displayByEntryId: Map<string, EntryDisplayText>;
}

/**
 * Resolves title/detail for a batch of entries, one query per distinct
 * source kind actually present (not per entry) -- same batching shape as
 * listUnresolvedDirectives.ts's own provenance/defer-count aggregation.
 * Directive-sourced entries use the entry's own frozen
 * directive_revision_id (the revision that was actually current when the
 * entry was created), not "whatever the directive's latest revision is
 * today" -- consistent with 6L's own historical-immutability principle,
 * even though this specific text isn't one of the schema's declared
 * snapshot columns.
 */
async function resolveDisplayText(
  client: PoolClient,
  tenantId: string,
  entries: readonly BriefingIssueEntry[],
): Promise<Map<string, EntryDisplayText>> {
  const displayByEntryId = new Map<string, EntryDisplayText>();

  const revisionIds = entries.map((e) => e.directive_revision_id).filter((id): id is string => id !== null);
  if (revisionIds.length > 0) {
    const result = await client.query<{ id: string; title: string; why_now: string | null; body: string | null }>(
      "SELECT id, title, why_now, body FROM operator_directive_revisions WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, revisionIds],
    );
    const byRevisionId = new Map(result.rows.map((row) => [row.id, row]));
    for (const entry of entries) {
      if (entry.directive_id === null) continue;
      const revision = entry.directive_revision_id ? byRevisionId.get(entry.directive_revision_id) : undefined;
      displayByEntryId.set(entry.id, {
        title: revision?.title ?? "(untitled Directive)",
        detail: revision?.why_now ?? revision?.body ?? null,
      });
    }
  }

  const workOrderIds = entries.map((e) => e.work_order_id).filter((id): id is string => id !== null);
  if (workOrderIds.length > 0) {
    const result = await client.query<{ id: string; task_type: string; interpreted_intent: string | null; status: string }>(
      "SELECT id, task_type, interpreted_intent, status FROM work_orders WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, workOrderIds],
    );
    const byWorkOrderId = new Map(result.rows.map((row) => [row.id, row]));
    for (const entry of entries) {
      if (entry.work_order_id === null) continue;
      const row = byWorkOrderId.get(entry.work_order_id);
      displayByEntryId.set(entry.id, {
        title: row?.interpreted_intent ?? row?.task_type ?? "(WorkOrder)",
        detail: row ? `task_type: ${row.task_type}, status: ${row.status}` : null,
      });
    }
  }

  const receiptIds = entries.map((e) => e.action_receipt_id).filter((id): id is string => id !== null);
  if (receiptIds.length > 0) {
    const result = await client.query<{ id: string; receipt_type: string; payload: { reason?: string } }>(
      "SELECT id, receipt_type, payload FROM action_receipts WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, receiptIds],
    );
    const byReceiptId = new Map(result.rows.map((row) => [row.id, row]));
    for (const entry of entries) {
      if (entry.action_receipt_id === null) continue;
      const row = byReceiptId.get(entry.action_receipt_id);
      const title =
        row?.receipt_type === "trigger_fire_skipped"
          ? `Trigger fire skipped: ${row.payload?.reason ?? "unknown reason"}`
          : (row?.receipt_type ?? "(ActionReceipt)");
      displayByEntryId.set(entry.id, { title, detail: null });
    }
  }

  const memoryCandidateIds = entries.map((e) => e.memory_candidate_id).filter((id): id is string => id !== null);
  if (memoryCandidateIds.length > 0) {
    const result = await client.query<{ id: string; candidate_content: string }>(
      "SELECT id, candidate_content FROM memory_candidates WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, memoryCandidateIds],
    );
    const byCandidateId = new Map(result.rows.map((row) => [row.id, row]));
    for (const entry of entries) {
      if (entry.memory_candidate_id === null) continue;
      const content = byCandidateId.get(entry.memory_candidate_id)?.candidate_content;
      const title = content ? (content.length > 80 ? `${content.slice(0, 80)}…` : content) : "(MemoryCandidate)";
      displayByEntryId.set(entry.id, { title, detail: null });
    }
  }

  return displayByEntryId;
}

/**
 * Read-only, same shape as getBriefingIssueDetail.ts, but keyed on "most
 * recent issue of this type for this tenant" instead of a specific issue
 * id -- what the operator deck actually wants on load. Returns null (not
 * a thrown error) when no issue exists yet for that type -- an expected
 * first-run state, not a fault.
 */
export async function getLatestBriefingIssue(tenantId: string, briefingType: string): Promise<BriefingIssueDetailWithDisplay | null> {
  return withTenantTransaction(tenantId, async (client) => {
    const issueResult = await client.query(
      "SELECT * FROM briefing_issues WHERE tenant_id = $1 AND briefing_type = $2 ORDER BY published_at DESC LIMIT 1",
      [tenantId, briefingType],
    );
    const issueRow = issueResult.rows[0] as Record<string, unknown> | undefined;
    if (!issueRow) {
      return null;
    }

    const entriesResult = await client.query(
      "SELECT * FROM briefing_issue_entries WHERE tenant_id = $1 AND briefing_issue_id = $2 AND entry_status = 'active' ORDER BY lane, rank",
      [tenantId, issueRow.id],
    );
    const entries = (entriesResult.rows as Record<string, unknown>[]).map(rowToBriefingIssueEntry);
    const displayByEntryId = await resolveDisplayText(client, tenantId, entries);

    return { issue: rowToBriefingIssue(issueRow), entries, displayByEntryId };
  });
}
