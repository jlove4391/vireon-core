import type { AcceptanceReportSummary } from "./acceptanceReports.js";
import type { MemoryCandidateSummaryRow } from "./memory.js";
import type { TenantRow, WorkOrderSummaryRow } from "./tenants.js";
import type { WorkOrderDetail } from "./workOrder.js";

export function printTenantsTable(tenants: TenantRow[]): void {
  if (tenants.length === 0) {
    console.log("No tenants found.");
    return;
  }
  console.table(tenants);
}

export function printWorkOrdersTable(workOrders: WorkOrderSummaryRow[]): void {
  if (workOrders.length === 0) {
    console.log("No WorkOrders found for this tenant.");
    return;
  }
  console.table(workOrders);
}

export function printMemoryCandidatesTable(candidates: MemoryCandidateSummaryRow[]): void {
  if (candidates.length === 0) {
    console.log("No MemoryCandidates found for this tenant (with the given filters, if any).");
    return;
  }
  console.table(
    candidates.map((candidate) => ({
      ...candidate,
      candidate_content: candidate.candidate_content.slice(0, 80),
    })),
  );
}

export function printAcceptanceReports(reports: AcceptanceReportSummary[]): void {
  if (reports.length === 0) {
    console.log("No acceptance reports found in core-records/.");
    return;
  }
  console.table(reports);
}

/**
 * The transition history is sequential/narrative, not tabular, so it gets
 * an indented chronological print rather than console.table().
 */
function printTransitionHistory(detail: WorkOrderDetail): void {
  console.log("\nTransition history:");
  for (const transition of detail.transitions) {
    const from = transition.from_status ?? "(none)";
    console.log(
      `  ${transition.created_at}  ${from} -> ${transition.to_status}  ` +
        `[actor: ${transition.actor_id ?? "-"}]  ${transition.reason}`,
    );
  }
}

export function printWorkOrderDetail(detail: WorkOrderDetail): void {
  console.log(`WorkOrder ${detail.workOrder.id}`);
  console.table([detail.workOrder]);

  printTransitionHistory(detail);

  if (detail.authorityDecision) {
    console.log("\nAuthorityDecision:");
    console.table([detail.authorityDecision]);
  }

  if (detail.runs.length > 0) {
    console.log("\nRuns:");
    console.table(detail.runs);
  }

  if (detail.actionReceipts.length > 0) {
    console.log("\nActionReceipts:");
    console.table(detail.actionReceipts.map((receipt) => ({ ...receipt, payload: JSON.stringify(receipt.payload) })));
  }

  if (detail.memoryCandidates.length > 0) {
    console.log("\nMemoryCandidates:");
    console.table(detail.memoryCandidates);
  }
}
