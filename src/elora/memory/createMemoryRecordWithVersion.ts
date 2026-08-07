import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { memoryRecordSchema, type MemoryRecord } from "../../schemas/memoryRecord.js";
import { memoryRecordVersionSchema } from "../../schemas/memoryRecordVersion.js";

export interface CreateMemoryRecordWithVersionInput {
  tenantId: string;
  content: string;
  recordType: string | null;
  scope: string | null;
  sourceCandidateId: string | null;
  changeReason: string;
}

/**
 * Client-taking core, shared by promoteMemoryCandidate.ts (real promotions,
 * sourceCandidateId set) and tests/shared/seedMemoryRecord.ts (fixture
 * seeding, sourceCandidateId null) -- the one place that creates a
 * memory_records row together with its mandatory first
 * memory_record_versions row, so no caller (production or test) can create
 * one without the other. Takes an already-open transactional client rather
 * than opening its own withTenantTransaction, so it composes into a
 * caller's existing transaction (e.g. promoteMemoryCandidate's candidate
 * lock + final candidate-status update).
 *
 * Insertion order is load-bearing, not incidental: memory_records.id and
 * memory_record_versions.id are mutually referenced (current_version_id ->
 * versions.id; versions.memory_record_id -> records.id), and neither FK in
 * this codebase is DEFERRABLE. The record is inserted first with
 * current_version_id left NULL (the column is nullable for exactly this
 * bootstrap reason), then the version row (which can now legally reference
 * the record's real id), then a final UPDATE points the record at it -- all
 * three statements share the caller's transaction, so a failure at any step
 * rolls back all of them.
 */
export async function createMemoryRecordWithVersion(
  client: PoolClient,
  input: CreateMemoryRecordWithVersionInput,
): Promise<MemoryRecord> {
  const now = new Date().toISOString();
  const recordId = randomUUID();
  const versionId = randomUUID();

  const parsedVersion = memoryRecordVersionSchema.parse({
    id: versionId,
    tenant_id: input.tenantId,
    memory_record_id: recordId,
    version_number: 1,
    content: input.content,
    change_reason: input.changeReason,
    is_deletion_marker: false,
    created_at: now,
  });

  const parsedRecord = memoryRecordSchema.parse({
    id: recordId,
    tenant_id: input.tenantId,
    source_candidate_id: input.sourceCandidateId,
    content: input.content,
    record_type: input.recordType,
    scope: input.scope,
    current_version_id: versionId,
    deleted_at: null,
    created_at: now,
  });

  await client.query(
    `INSERT INTO memory_records (id, tenant_id, source_candidate_id, content, record_type, scope, current_version_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)`,
    [
      parsedRecord.id,
      parsedRecord.tenant_id,
      parsedRecord.source_candidate_id,
      parsedRecord.content,
      parsedRecord.record_type,
      parsedRecord.scope,
      parsedRecord.created_at,
    ],
  );

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

  await client.query(`UPDATE memory_records SET current_version_id = $1 WHERE id = $2 AND tenant_id = $3`, [
    versionId,
    parsedRecord.id,
    input.tenantId,
  ]);

  return parsedRecord;
}
