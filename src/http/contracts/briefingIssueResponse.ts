import { BriefingIssueDTOSchema, type BriefingIssueDTO } from "@vireon/contracts";
import { LANE_HEADINGS, LANE_ORDER } from "../../briefing/generateProse.js";
import type { BriefingIssueDetailWithDisplay } from "../../briefing/getLatestBriefingIssue.js";

// Phase 6M §5 (mirrors eloraMessageResponse.ts): the one place allowed to
// import both the internal BriefingIssueDetailWithDisplay type and the
// shared contract schema -- backend-only code, not part of the shared
// package itself. laneOrder/laneLabels come straight from
// generateProse.ts's own LANE_ORDER/LANE_HEADINGS, resolved here once per
// response rather than the frontend carrying its own copy.
export function toBriefingIssueDTO(detail: BriefingIssueDetailWithDisplay): BriefingIssueDTO {
  const firstMoveEntry =
    detail.issue.first_move_directive_id === null
      ? null
      : (detail.entries.find((entry) => entry.directive_id === detail.issue.first_move_directive_id) ?? null);

  const response = {
    schemaVersion: "1" as const,
    id: detail.issue.id,
    briefingType: detail.issue.briefing_type,
    localIssueDate: detail.issue.local_issue_date,
    timezone: detail.issue.timezone,
    status: detail.issue.status,
    publishedAt: detail.issue.published_at,
    firstMoveEntryId: firstMoveEntry?.id ?? null,
    laneOrder: LANE_ORDER,
    laneLabels: LANE_HEADINGS,
    entries: detail.entries.map((entry) => {
      const display = detail.displayByEntryId.get(entry.id);
      return {
        id: entry.id,
        lane: entry.lane,
        rank: entry.rank,
        title: display?.title ?? "(untitled)",
        detail: display?.detail ?? null,
        newToIssue: entry.new_to_issue,
        ageDaysSnapshot: entry.age_days_snapshot,
        carryCountSnapshot: entry.carry_count_snapshot,
        deferCountSnapshot: entry.defer_count_snapshot,
        escalationLevelSnapshot: entry.escalation_level_snapshot,
      };
    }),
  };

  // Validate the backend's own output before it goes on the wire -- same
  // discipline as toEloraMessageResponse().
  return BriefingIssueDTOSchema.parse(response);
}
