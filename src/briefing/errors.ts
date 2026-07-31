/** Base class for every briefing-domain error, so callers can catch broadly with `instanceof BriefingError`. */
export class BriefingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefingError";
  }
}

export class InvalidBriefingInputError extends BriefingError {
  constructor(reason: string) {
    super(`Invalid BriefingIssue input: ${reason}`);
    this.name = "InvalidBriefingInputError";
  }
}

/**
 * Raised when a caller-influenced internal reference (currently only
 * issued_by_actor_id -- see collectCandidates.ts/issueBriefing.ts's own
 * comments for why every other reference column is internally derived
 * instead) points at a row that doesn't exist at all, or exists but
 * belongs to a different tenant. Same rationale as
 * DirectiveReferenceNotFoundError/StateReferenceNotFoundError -- a plain
 * FK only proves the row exists SOMEWHERE, not that it belongs to this
 * tenant, since FK constraint checks run independent of RLS.
 */
export class BriefingReferenceNotFoundError extends BriefingError {
  constructor(
    public readonly field: string,
    public readonly id: string,
  ) {
    super(`Referenced ${field} ${id} not found for the given tenant`);
    this.name = "BriefingReferenceNotFoundError";
  }
}

export class BriefingIssueNotFoundError extends BriefingError {
  constructor(public readonly briefingIssueId: string) {
    super(`BriefingIssue ${briefingIssueId} not found`);
    this.name = "BriefingIssueNotFoundError";
  }
}

export class BriefingPersistenceError extends BriefingError {
  constructor(reason: string) {
    super(`Failed to persist BriefingIssue record: ${reason}`);
    this.name = "BriefingPersistenceError";
  }
}
