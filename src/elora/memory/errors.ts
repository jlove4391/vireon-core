/**
 * Base class for every memory review/promotion error, so callers can catch
 * broadly with `instanceof MemoryReviewError`. PR 5 also uses this base for
 * memory_records versioning/supersession/deletion errors -- same "memory
 * lifecycle" domain, not a separate error family.
 */
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

/** PR 5: raised by supersedeMemoryRecord.ts/deleteMemoryRecord.ts when the referenced memory_records row doesn't exist for the given tenant. */
export class MemoryRecordNotFoundError extends MemoryReviewError {
  constructor(public readonly memoryRecordId: string) {
    super(`MemoryRecord ${memoryRecordId} not found`);
    this.name = "MemoryRecordNotFoundError";
  }
}

/**
 * PR 5: a memory_records row that already has deleted_at set cannot be
 * superseded or deleted again. Deletion is a terminal state for a memory
 * record's content lifecycle in this PR -- there is no "undelete" or
 * re-supersede-after-deletion path.
 */
export class MemoryRecordAlreadyDeletedError extends MemoryReviewError {
  constructor(public readonly memoryRecordId: string) {
    super(`MemoryRecord ${memoryRecordId} was already deleted and cannot be modified further`);
    this.name = "MemoryRecordAlreadyDeletedError";
  }
}

/** PR 6: raised by writeMemoryEmbedding.ts/embedMemoryRecordVersion.ts when the referenced memory_record_versions row doesn't exist for the given tenant. */
export class MemoryRecordVersionNotFoundError extends MemoryReviewError {
  constructor(public readonly memoryRecordVersionId: string) {
    super(`MemoryRecordVersion ${memoryRecordVersionId} not found`);
    this.name = "MemoryRecordVersionNotFoundError";
  }
}

/**
 * PR 6: a deletion-marker version (is_deletion_marker = true) can never be
 * embedded -- its content is always the deletion tombstone, never real
 * memory content. In practice this is implied by its parent record already
 * being deleted (deleteMemoryRecord.ts always sets both together), but
 * writeMemoryEmbedding.ts checks it independently as defense-in-depth
 * rather than relying solely on the parent-deletion check.
 */
export class MemoryRecordVersionIsDeletionMarkerError extends MemoryReviewError {
  constructor(public readonly memoryRecordVersionId: string) {
    super(`MemoryRecordVersion ${memoryRecordVersionId} is a deletion marker and cannot be embedded`);
    this.name = "MemoryRecordVersionIsDeletionMarkerError";
  }
}
