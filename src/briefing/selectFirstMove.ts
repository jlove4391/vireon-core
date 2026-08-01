import type { CandidateEntryDraft } from "./collectCandidates.js";

/**
 * Fork 2 resolution (Phase B go-ahead) -- deterministic tiebreak chain,
 * v1/explicitly provisional, same posture as getDirectiveDetail.ts's own
 * escalation_level placeholder comment: not a final formula, meant to be
 * tuned from real daily use once the deck (6M) exists.
 *
 *   1. blocker type always ranks first.
 *   2. Overdue or nearest hard deadline (due_at) -- implemented as plain
 *      ascending due_at with nulls last: an overdue due_at is numerically
 *      earlier than "now" or any future due_at, so ascending order
 *      naturally surfaces "most overdue" before "soonest upcoming" before
 *      "further out" before "no deadline at all," without needing a
 *      separate is-overdue branch.
 *   3. Blocking impact -- count of linked dependent WorkOrders via
 *      provenance, descending.
 *   4. Age (oldest unresolved) as final tiebreak, descending age (oldest
 *      first).
 *
 * Array.prototype.sort is a stable sort (guaranteed since ES2019), so any
 * remaining tie preserves input order -- and input order is itself
 * deterministic (collectCandidates.ts's own queries are consistently
 * ordered), which is what makes the whole chain deterministic end to end
 * (acceptance criterion 7), not just "usually the same."
 */
function compareByDeadline(aDueAt: string | null, bDueAt: string | null): number {
  if (aDueAt === null && bDueAt === null) return 0;
  if (aDueAt === null) return 1;
  if (bDueAt === null) return -1;
  return new Date(aDueAt).getTime() - new Date(bDueAt).getTime();
}

export function compareForFirstMove(a: CandidateEntryDraft, b: CandidateEntryDraft): number {
  if (a.scoring.isBlockerType !== b.scoring.isBlockerType) {
    return a.scoring.isBlockerType ? -1 : 1;
  }
  const deadlineCompare = compareByDeadline(a.scoring.dueAt, b.scoring.dueAt);
  if (deadlineCompare !== 0) return deadlineCompare;

  if (a.scoring.dependentWorkOrderCount !== b.scoring.dependentWorkOrderCount) {
    return b.scoring.dependentWorkOrderCount - a.scoring.dependentWorkOrderCount;
  }

  return b.scoring.ageDays - a.scoring.ageDays;
}

/**
 * Selects the single first-move candidate, or null if nothing in the
 * collected set is first-move eligible (decision/action/blocker-type
 * Directives only -- see collectCandidates.ts's own comment for why
 * Watch/Focus and every non-Directive lane are excluded). Never mutates
 * or re-sorts the input array.
 */
export function selectFirstMove(drafts: readonly CandidateEntryDraft[]): CandidateEntryDraft | null {
  const eligible = drafts.filter((draft) => draft.scoring.firstMoveEligible);
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareForFirstMove)[0]!;
}

/**
 * Assigns a stable, deterministic 1-indexed `rank` to every draft within
 * its own lane, using the same comparator as first-move selection (for
 * lanes with no deadline/blocking-impact data -- every non-Directive
 * lane -- criteria 1-3 are uniformly tied, so this reduces to
 * oldest-first, a reasonable default display order).
 */
export function rankWithinLane(drafts: readonly CandidateEntryDraft[]): Map<CandidateEntryDraft, number> {
  const byLane = new Map<string, CandidateEntryDraft[]>();
  for (const draft of drafts) {
    const bucket = byLane.get(draft.lane) ?? [];
    bucket.push(draft);
    byLane.set(draft.lane, bucket);
  }

  const rankByDraft = new Map<CandidateEntryDraft, number>();
  for (const bucket of byLane.values()) {
    const sorted = [...bucket].sort(compareForFirstMove);
    sorted.forEach((draft, index) => rankByDraft.set(draft, index + 1));
  }
  return rankByDraft;
}
