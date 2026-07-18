/** Base class for every memory review/promotion error, so callers can catch broadly with `instanceof MemoryReviewError`. */
export class MemoryReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryReviewError";
  }
}

export class MemoryCandidateNotFoundError extends MemoryReviewError {
  constructor(public readonly candidateId: string) {
    super(`MemoryCandidate ${candidateId} not found`);
    this.name = "MemoryCandidateNotFoundError";
  }
}

export class InvalidCandidateReviewStateError extends MemoryReviewError {
  constructor(
    public readonly candidateId: string,
    public readonly currentStatus: string,
  ) {
    super(
      `MemoryCandidate ${candidateId} cannot be reviewed: current review_status is '${currentStatus}', expected 'proposed'`,
    );
    this.name = "InvalidCandidateReviewStateError";
  }
}

export class CandidateNotApprovedError extends MemoryReviewError {
  constructor(
    public readonly candidateId: string,
    public readonly currentStatus: string,
  ) {
    super(
      `MemoryCandidate ${candidateId} cannot be promoted: current review_status is '${currentStatus}', expected 'approved'`,
    );
    this.name = "CandidateNotApprovedError";
  }
}
