import { withTenantTransaction } from "../db/withTenantTransaction.js";
import type { BriefingIssue, BriefingIssueEntry } from "../schemas/briefingIssue.js";
import { BriefingIssueNotFoundError } from "./errors.js";
import { rowToBriefingIssue, rowToBriefingIssueEntry } from "./rowMappers.js";

export interface BriefingIssueDetail {
  issue: BriefingIssue;
  entries: BriefingIssueEntry[];
}

/** Read-only. Same shape as getDirectiveDetail.ts. */
export async function getBriefingIssueDetail(tenantId: string, briefingIssueId: string): Promise<BriefingIssueDetail> {
  return withTenantTransaction(tenantId, async (client) => {
    const issueResult = await client.query("SELECT * FROM briefing_issues WHERE id = $1 AND tenant_id = $2", [
      briefingIssueId,
      tenantId,
    ]);
    const issueRow = issueResult.rows[0] as Record<string, unknown> | undefined;
    if (!issueRow) {
      throw new BriefingIssueNotFoundError(briefingIssueId);
    }

    const entriesResult = await client.query(
      "SELECT * FROM briefing_issue_entries WHERE tenant_id = $1 AND briefing_issue_id = $2 ORDER BY lane, rank",
      [tenantId, briefingIssueId],
    );

    return {
      issue: rowToBriefingIssue(issueRow),
      entries: (entriesResult.rows as Record<string, unknown>[]).map(rowToBriefingIssueEntry),
    };
  });
}
