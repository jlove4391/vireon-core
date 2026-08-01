import type { PoolClient } from "pg";
import { listUnresolvedDirectivesWithClient } from "../directives/listUnresolvedDirectives.js";
import type { DirectiveType } from "../schemas/operatorDirective.js";
import type { BriefingEntryLane } from "../schemas/briefingIssue.js";

/**
 * Draft of one candidate entry, before it's been ranked/assigned a
 * first-move and inserted. `source` is the exactly-one-of-four reference
 * this candidate will be persisted under (mirrors
 * briefing_issue_entries' own CHECK constraint) -- every id here is
 * always drawn from a tenant-scoped collector query in this same
 * transaction, never caller input (see each collector's own comment for
 * its specific tenant-scoped query).
 */
export interface CandidateEntryDraft {
  lane: BriefingEntryLane;
  source:
    | { kind: "directive"; directiveId: string; directiveRevisionId: string | null; directiveType: DirectiveType }
    | { kind: "work_order"; workOrderId: string }
    | { kind: "action_receipt"; actionReceiptId: string }
    | { kind: "memory_candidate"; memoryCandidateId: string };
  inclusionReason: string;
  /** Rendered by generateProse.ts directly -- always derived from the same row this collector already fetched, never a second query. */
  displayTitle: string;
  displayDetail: string | null;
  ageDaysSnapshot: number | null;
  carryCountSnapshot: number | null;
  deferCountSnapshot: number | null;
  escalationLevelSnapshot: number | null;
  /** Inputs to selectFirstMove.ts's scoring/rank-ordering -- not persisted directly, only via the snapshot fields above where applicable. */
  scoring: {
    firstMoveEligible: boolean;
    isBlockerType: boolean;
    dueAt: string | null;
    dependentWorkOrderCount: number;
    ageDays: number;
  };
}

export interface CollectCandidatesResult {
  drafts: CandidateEntryDraft[];
  /** The "recent" window boundary used by the WorkOrder/ActionReceipt collectors -- surfaced for prose's "Completed Since Last Issue"/"Evidence Summary" section headers. */
  sinceTimestamp: string;
}

function ageDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Fork 1 resolution: "recent" = since the tenant's last issued briefing
 * of this type, falling back to a fixed 24h default only for a tenant's
 * first-ever issue of this type -- the source document's own stated
 * operating principle ("tomorrow's briefing incorporates yesterday's
 * actions"), used as the concrete window definition. Tenant-scoped by
 * construction (`WHERE tenant_id = $1 AND briefing_type = $2`) --
 * excludes CLOSED/nothing-filter needed since this only looks at
 * published_at, which is only ever set once an issue reaches ISSUED.
 */
async function resolveSinceTimestamp(
  client: PoolClient,
  tenantId: string,
  briefingType: string,
  now: Date,
): Promise<Date> {
  const result = await client.query<{ published_at: Date | null }>(
    `SELECT published_at FROM briefing_issues
     WHERE tenant_id = $1 AND briefing_type = $2 AND published_at IS NOT NULL
     ORDER BY published_at DESC LIMIT 1`,
    [tenantId, briefingType],
  );
  const lastPublishedAt = result.rows[0]?.published_at ?? null;
  if (lastPublishedAt) {
    return new Date(lastPublishedAt);
  }
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * Unresolved Directives collector. Lane mapping is a direct 1:1 with
 * directive_type (decision/focus/action/blocker/watch) -- the five
 * type-specific carry policies in the 6L spec are exactly the five
 * prose-section lanes. First-move eligibility (Fork 2) is restricted to
 * decision/action/blocker: Watch's own policy explicitly says "don't
 * escalate solely for being carried" and Focus's says "don't
 * automatically occupy future operator time" -- neither type is meant to
 * ever be the thing an operator is pointed at first.
 */
async function collectUnresolvedDirectives(client: PoolClient, tenantId: string, now: Date): Promise<CandidateEntryDraft[]> {
  const candidates = await listUnresolvedDirectivesWithClient(client, tenantId, now);
  return candidates.map((candidate): CandidateEntryDraft => {
    const directiveType = candidate.directive.directive_type;
    const firstMoveEligible = directiveType === "decision" || directiveType === "action" || directiveType === "blocker";
    return {
      lane: directiveType as BriefingEntryLane,
      source: {
        kind: "directive",
        directiveId: candidate.directive.id,
        directiveRevisionId: candidate.latestRevision?.id ?? null,
        directiveType,
      },
      inclusionReason: `Unresolved ${directiveType} Directive (state: ${candidate.directive.state})`,
      displayTitle: candidate.latestRevision?.title ?? "(untitled Directive)",
      displayDetail: candidate.latestRevision?.why_now ?? candidate.latestRevision?.body ?? null,
      ageDaysSnapshot: ageDaysBetween(new Date(candidate.directive.first_seen_at), now),
      carryCountSnapshot: candidate.carryCount,
      deferCountSnapshot: candidate.deferCount,
      escalationLevelSnapshot: candidate.escalationLevel,
      scoring: {
        firstMoveEligible,
        isBlockerType: directiveType === "blocker",
        dueAt: candidate.directive.due_at,
        dependentWorkOrderCount: candidate.dependentWorkOrderCount,
        ageDays: ageDaysBetween(new Date(candidate.directive.first_seen_at), now),
      },
    };
  });
}

const ACTIVE_WORK_ORDER_STATUSES = [
  "RECEIVED",
  "INTENT_PARSED",
  "AUTHORITY_CLASSIFIED",
  "READY_TO_ACT",
  "EXECUTING",
  "VALIDATING",
  "RECEIPT_WRITTEN",
  "MEMORY_CANDIDATES_CREATED",
];
const BLOCKED_WORK_ORDER_STATUSES = ["FAILED", "AWAITING_AUTHORIZATION", "SETUP_REQUIRED", "CAPABILITY_MISSING", "REFUSED"];

/**
 * Active / blocked / recently-completed WorkOrders, one tenant-scoped
 * query covering every WORK_ORDER_STATUSES value (no status is left
 * uncollected): the four "in flight" statuses feed lane='action'
 * (WorkOrders actively being worked need the same attention as an
 * Action Directive), the five blocked-shaped statuses (FAILED,
 * AWAITING_AUTHORIZATION, SETUP_REQUIRED, CAPABILITY_MISSING, REFUSED --
 * the last two aren't named individually in the spec's collector list
 * but are exactly the same "needs operator attention, can't proceed on
 * its own" shape as the three that are) feed lane='blocker', and
 * COMPLETED-since-the-last-issue feeds lane='completed'.
 */
async function collectWorkOrders(client: PoolClient, tenantId: string, sinceTimestamp: Date, now: Date): Promise<CandidateEntryDraft[]> {
  const result = await client.query<{
    id: string;
    status: string;
    task_type: string;
    interpreted_intent: string | null;
    updated_at: Date;
    created_at: Date;
  }>(
    `SELECT id, status, task_type, interpreted_intent, updated_at, created_at FROM work_orders
     WHERE tenant_id = $1
       AND (
         status = ANY($2)
         OR status = ANY($3)
         OR (status = 'COMPLETED' AND updated_at >= $4)
       )
     ORDER BY updated_at ASC`,
    [tenantId, ACTIVE_WORK_ORDER_STATUSES, BLOCKED_WORK_ORDER_STATUSES, sinceTimestamp.toISOString()],
  );

  return result.rows.map((row): CandidateEntryDraft => {
    const lane: BriefingEntryLane = BLOCKED_WORK_ORDER_STATUSES.includes(row.status)
      ? "blocker"
      : row.status === "COMPLETED"
        ? "completed"
        : "action";
    return {
      lane,
      source: { kind: "work_order", workOrderId: row.id },
      inclusionReason: `WorkOrder status: ${row.status}`,
      displayTitle: row.interpreted_intent ?? row.task_type,
      displayDetail: `task_type: ${row.task_type}, status: ${row.status}`,
      ageDaysSnapshot: ageDaysBetween(new Date(row.created_at), now),
      carryCountSnapshot: null,
      deferCountSnapshot: null,
      escalationLevelSnapshot: null,
      scoring: {
        // WorkOrders are informational lanes, not first-move candidates --
        // the spec's scoring factors (blocking impact, dependent
        // WorkOrders, declared focus window) are all Directive-shaped
        // concepts; a first move is always something an operator *decides
        // or acts on*, which in this domain's vocabulary is a Directive.
        firstMoveEligible: false,
        isBlockerType: false,
        dueAt: null,
        dependentWorkOrderCount: 0,
        ageDays: ageDaysBetween(new Date(row.created_at), now),
      },
    };
  });
}

const EVIDENCE_RECEIPT_TYPES_EXCLUDED = new Set(["state_transitioned", "trigger_fire_skipped"]);

/**
 * Recent ActionReceipts collector, lane='evidence'. Excludes
 * 'state_transitioned' (fires on every single WorkOrder transition --
 * pure volume noise, and already represented by the WorkOrder collector
 * itself) and 'trigger_fire_skipped' (its own dedicated collector below,
 * to avoid double-counting the same receipt under two lanes).
 */
async function collectActionReceipts(client: PoolClient, tenantId: string, sinceTimestamp: Date, now: Date): Promise<CandidateEntryDraft[]> {
  const result = await client.query<{ id: string; receipt_type: string; created_at: Date }>(
    `SELECT id, receipt_type, created_at FROM action_receipts
     WHERE tenant_id = $1 AND created_at >= $2 AND receipt_type != ALL($3)
     ORDER BY created_at ASC`,
    [tenantId, sinceTimestamp.toISOString(), Array.from(EVIDENCE_RECEIPT_TYPES_EXCLUDED)],
  );

  return result.rows.map((row): CandidateEntryDraft => ({
    lane: "evidence",
    source: { kind: "action_receipt", actionReceiptId: row.id },
    inclusionReason: `Recent ActionReceipt (type: ${row.receipt_type})`,
    displayTitle: row.receipt_type,
    displayDetail: null,
    ageDaysSnapshot: ageDaysBetween(new Date(row.created_at), now),
    carryCountSnapshot: null,
    deferCountSnapshot: null,
    escalationLevelSnapshot: null,
    scoring: { firstMoveEligible: false, isBlockerType: false, dueAt: null, dependentWorkOrderCount: 0, ageDays: ageDaysBetween(new Date(row.created_at), now) },
  }));
}

/** Pending MemoryCandidates collector, lane='evidence' -- review_status = 'proposed' (awaiting operator review). */
async function collectMemoryCandidates(client: PoolClient, tenantId: string, now: Date): Promise<CandidateEntryDraft[]> {
  const result = await client.query<{ id: string; candidate_content: string; created_at: Date }>(
    `SELECT id, candidate_content, created_at FROM memory_candidates WHERE tenant_id = $1 AND review_status = 'proposed' ORDER BY created_at ASC`,
    [tenantId],
  );

  return result.rows.map((row): CandidateEntryDraft => ({
    lane: "evidence",
    source: { kind: "memory_candidate", memoryCandidateId: row.id },
    inclusionReason: "Pending MemoryCandidate awaiting review",
    displayTitle: row.candidate_content.length > 80 ? `${row.candidate_content.slice(0, 80)}…` : row.candidate_content,
    displayDetail: null,
    ageDaysSnapshot: ageDaysBetween(new Date(row.created_at), now),
    carryCountSnapshot: null,
    deferCountSnapshot: null,
    escalationLevelSnapshot: null,
    scoring: { firstMoveEligible: false, isBlockerType: false, dueAt: null, dependentWorkOrderCount: 0, ageDays: ageDaysBetween(new Date(row.created_at), now) },
  }));
}

/**
 * Scheduled-trigger failures collector, lane='blocker' -- 6J's
 * trigger_fire_skipped receipts (writeTriggerFireSkippedReceipt.ts).
 * That receipt type never sets work_order_id (nothing was created on
 * that branch -- it's a rejection before ingestUserMessage() is ever
 * called, confirmed by reading the writer directly), so this collector
 * references the receipt itself, same as the general ActionReceipts
 * collector, just filtered to this one type and given its own lane and
 * inclusion reason instead of landing in 'evidence'.
 */
async function collectScheduledTriggerFailures(client: PoolClient, tenantId: string, sinceTimestamp: Date, now: Date): Promise<CandidateEntryDraft[]> {
  const result = await client.query<{ id: string; created_at: Date; payload: { reason?: string } }>(
    `SELECT id, created_at, payload FROM action_receipts
     WHERE tenant_id = $1 AND receipt_type = 'trigger_fire_skipped' AND created_at >= $2
     ORDER BY created_at ASC`,
    [tenantId, sinceTimestamp.toISOString()],
  );

  return result.rows.map((row): CandidateEntryDraft => ({
    lane: "blocker",
    source: { kind: "action_receipt", actionReceiptId: row.id },
    inclusionReason: `Scheduled trigger fire skipped (reason: ${row.payload?.reason ?? "unknown"})`,
    displayTitle: `Trigger fire skipped: ${row.payload?.reason ?? "unknown reason"}`,
    displayDetail: null,
    ageDaysSnapshot: ageDaysBetween(new Date(row.created_at), now),
    carryCountSnapshot: null,
    deferCountSnapshot: null,
    escalationLevelSnapshot: null,
    scoring: { firstMoveEligible: false, isBlockerType: false, dueAt: null, dependentWorkOrderCount: 0, ageDays: ageDaysBetween(new Date(row.created_at), now) },
  }));
}

/**
 * Runs every collector for one briefing issuance, all tenant-scoped, all
 * within the caller's own transaction. Fork 3 ("explicit operator
 * holds") is deliberately not implemented here -- dropped from v1 scope
 * per the Phase B go-ahead: no existing mechanism fits (6K's
 * suppressions are dedupe-key/directive-detection-scoped, unrelated to
 * WorkOrders/ActionReceipts/MemoryCandidates), and this phase's own
 * non-goals warn against inventing new schema ahead of a real need.
 * Deferred, not forgotten -- likely resurfaces once 6M's UI gives an
 * operator something to actually invoke "hold" on.
 *
 * No Gmail/Calendar/Drive/GitHub/market/weather/web collector exists
 * here or anywhere in this codebase (confirmed in the Phase A memo) --
 * satisfies acceptance criterion 10 ("candidate collection never
 * fabricates provider evidence") structurally, by the complete absence
 * of any collector that isn't reading directly from an existing CORE
 * table.
 */
export async function collectCandidates(
  client: PoolClient,
  tenantId: string,
  briefingType: string,
  now: Date,
): Promise<CollectCandidatesResult> {
  const sinceTimestamp = await resolveSinceTimestamp(client, tenantId, briefingType, now);

  // Sequential, not Promise.all -- a single PoolClient represents one
  // Postgres connection, and every other multi-query function in this
  // codebase awaits each query in turn on a shared client rather than
  // firing concurrent queries against it.
  const directiveDrafts = await collectUnresolvedDirectives(client, tenantId, now);
  const workOrderDrafts = await collectWorkOrders(client, tenantId, sinceTimestamp, now);
  const receiptDrafts = await collectActionReceipts(client, tenantId, sinceTimestamp, now);
  const memoryCandidateDrafts = await collectMemoryCandidates(client, tenantId, now);
  const triggerFailureDrafts = await collectScheduledTriggerFailures(client, tenantId, sinceTimestamp, now);

  return {
    drafts: [...directiveDrafts, ...workOrderDrafts, ...receiptDrafts, ...memoryCandidateDrafts, ...triggerFailureDrafts],
    sinceTimestamp: sinceTimestamp.toISOString(),
  };
}
