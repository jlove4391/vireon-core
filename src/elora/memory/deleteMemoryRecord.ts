import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryRecordSchema, type MemoryRecord } from "../../schemas/memoryRecord.js";
import { memoryRecordVersionSchema, type MemoryRecordVersion } from "../../schemas/memoryRecordVersion.js";
import { MemoryRecordAlreadyDeletedError, MemoryRecordNotFoundError } from "./errors.js";

export interface DeleteMemoryRecordInput {
  tenantId: string;
  memoryRecordId: string;
  actorId: string;
  reason: string;
}

export interface DeleteMemoryRecordResult {
  memoryRecord: MemoryRecord;
  deletionVersion: MemoryRecordVersion;
}

/**
 * The tombstone marker written to both memory_records.content and the final
 * version row's content on deletion. Fixed and content-free by design: the
 * whole point of a real deletion (as opposed to supersession, which is a
 * correction that deliberately keeps old content queryable as history) is
 * that the sensitive content is genuinely gone, not merely flagged. This
 * constant must never vary by what was actually deleted.
 */
export const DELETION_TOMBSTONE_CONTENT = "[content removed by deletion]";

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Deletion is a distinct operation from supersession, not a "soft delete"
 * variant of it. Locked behavior (PR 5): memory_records.content is genuinely
 * cleared to DELETION_TOMBSTONE_CONTENT, deleted_at is set to a real
 * timestamp, and the fact that a deletion happened is itself durably
 * recorded as a final memory_record_versions row (is_deletion_marker =
 * true) whose own content is also the tombstone -- never the original
 * sensitive content.
 *
 * Critically, this also scrubs `content` on every *pre-existing* version
 * row for this record, not only the new final marker row. The decision
 * doc is explicit that a "soft delete that leaves the original sensitive
 * content sitting in a queryable historical version wouldn't actually
 * satisfy [deletion's] reason" -- supersession deliberately keeps prior
 * content queryable as history; deletion deliberately does not, since that
 * would leave the "deleted" content trivially recoverable from
 * memory_record_versions. Structural fields on prior versions
 * (version_number, created_at, and the caller-supplied free-text
 * change_reason) are left untouched -- only `content` is cleared -- so the
 * shape of the correction history (how many times it was corrected, when)
 * stays honestly auditable without the actual content surviving anywhere.
 * Known limitation: a caller-supplied `change_reason` on an earlier
 * supersession could itself incidentally quote sensitive content; this PR
 * does not scrub that free-text field, only `content`.
 *
 * PR 6 §12: for the exact same reason, every derived embedding for every
 * version of this record is deleted outright -- not merely marked
 * SUPERSEDED -- before content scrubbing. An embedding is a lossy but real
 * encoding of the content it was derived from; leaving it in place after
 * deletion would be the identical "recoverable from a queryable row"
 * failure the version-content scrub exists to close, just in vector form
 * instead of text form. The atomic sequence is: lock record -> remove
 * derived embeddings -> scrub historical version content -> insert
 * deletion marker -> tombstone parent -> commit. A rollback at any point
 * restores all of it (embeddings, content, parent state) -- see this
 * function's test coverage for the forced-failure proof.
 *
 * A memory record can only be deleted once -- MemoryRecordAlreadyDeletedError
 * on a second attempt, the same terminal-state posture
 * supersedeMemoryRecord.ts uses for the identical precondition.
 */
async function runDeleteMemoryRecord(
  input: DeleteMemoryRecordInput,
  options: { injectFailureAfterEmbeddingDeletion: boolean },
): Promise<DeleteMemoryRecordResult> {
  return withTenantTransaction(input.tenantId, async (client) => {
    const existing = await client.query(
      "SELECT * FROM memory_records WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [input.memoryRecordId, input.tenantId],
    );
    const recordRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (!recordRow) {
      throw new MemoryRecordNotFoundError(input.memoryRecordId);
    }
    if (recordRow.deleted_at) {
      throw new MemoryRecordAlreadyDeletedError(input.memoryRecordId);
    }

    // Remove every derived embedding for every version of this record --
    // before scrubbing version content, per this function's own doc
    // comment. A DELETE, never a SUPERSEDED status flip: the embedding
    // itself must stop existing, not merely stop being marked current.
    await client.query(
      `DELETE FROM memory_embeddings
       WHERE tenant_id = $1
         AND memory_record_version_id IN (
             SELECT id
             FROM memory_record_versions
             WHERE tenant_id = $1
               AND memory_record_id = $2
         )`,
      [input.tenantId, input.memoryRecordId],
    );

    if (options.injectFailureAfterEmbeddingDeletion) {
      throw new Error("deleteMemoryRecord: test-only failure injection after embedding deletion, before version scrubbing");
    }

    const maxVersionResult = await client.query<{ max_version: number }>(
      "SELECT COALESCE(MAX(version_number), 0) AS max_version FROM memory_record_versions WHERE tenant_id = $1 AND memory_record_id = $2",
      [input.tenantId, input.memoryRecordId],
    );
    const nextVersionNumber = Number(maxVersionResult.rows[0]!.max_version) + 1;

    // Scrub content on every pre-existing version row -- see this
    // function's own doc comment for why this is required for a real
    // deletion, not merely a nice-to-have. Structural fields
    // (version_number, change_reason, created_at) are left untouched.
    await client.query(
      "UPDATE memory_record_versions SET content = $1 WHERE tenant_id = $2 AND memory_record_id = $3",
      [DELETION_TOMBSTONE_CONTENT, input.tenantId, input.memoryRecordId],
    );

    const now = new Date().toISOString();
    const versionId = randomUUID();

    const parsedVersion = memoryRecordVersionSchema.parse({
      id: versionId,
      tenant_id: input.tenantId,
      memory_record_id: input.memoryRecordId,
      version_number: nextVersionNumber,
      content: DELETION_TOMBSTONE_CONTENT,
      change_reason: input.reason,
      is_deletion_marker: true,
      created_at: now,
    });

    await client.query(
      `INSERT INTO memory_record_versions (id, tenant_id, memory_record_id, version_number, content, change_reason, is_deletion_marker, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        parsedVersion.id,
        parsedVersion.tenant_id,
        parsedVersion.memory_record_id,
        parsedVersion.version_number,
        parsedVersion.content,
        parsedVersion.change_reason,
        parsedVersion.is_deletion_marker,
        parsedVersion.created_at,
      ],
    );

    const updated = await client.query(
      `UPDATE memory_records SET content = $1, deleted_at = $2, current_version_id = $3 WHERE id = $4 AND tenant_id = $5 RETURNING *`,
      [DELETION_TOMBSTONE_CONTENT, now, versionId, input.memoryRecordId, input.tenantId],
    );
    const updatedRow = updated.rows[0] as Record<string, unknown>;

    const parsedRecord = memoryRecordSchema.parse({
      id: updatedRow.id,
      tenant_id: updatedRow.tenant_id,
      source_candidate_id: updatedRow.source_candidate_id,
      content: updatedRow.content,
      record_type: updatedRow.record_type,
      scope: updatedRow.scope,
      current_version_id: updatedRow.current_version_id,
      deleted_at: toIso(updatedRow.deleted_at as string | Date),
      created_at: toIso(updatedRow.created_at as string | Date),
    });

    return { memoryRecord: parsedRecord, deletionVersion: parsedVersion };
  });
}

/** Production entry point. Never accepts failure-injection input. */
export async function deleteMemoryRecord(input: DeleteMemoryRecordInput): Promise<DeleteMemoryRecordResult> {
  return runDeleteMemoryRecord(input, { injectFailureAfterEmbeddingDeletion: false });
}

/**
 * PR 6 §28: test-only atomicity seam, mirroring
 * transitionCognitiveRunForTest's exact pattern -- forces a rollback after
 * derived embeddings are deleted but before version content scrubbing
 * commits, to prove a mid-deletion failure restores everything (embeddings,
 * historical content, parent state, current_version_id, deleted_at) rather
 * than leaving a partially-deleted record. Rejected outside test context so
 * this is not a reachable production code path.
 */
export async function deleteMemoryRecordForTest(input: DeleteMemoryRecordInput): Promise<DeleteMemoryRecordResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("deleteMemoryRecordForTest may only be called with NODE_ENV=test");
  }
  return runDeleteMemoryRecord(input, { injectFailureAfterEmbeddingDeletion: true });
}
