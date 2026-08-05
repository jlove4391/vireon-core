import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import { memoryRecordSchema, type MemoryRecord } from "../../schemas/memoryRecord.js";
import { memoryRecordVersionSchema, type MemoryRecordVersion } from "../../schemas/memoryRecordVersion.js";
import { MemoryRecordAlreadyDeletedError, MemoryRecordNotFoundError } from "./errors.js";

export interface SupersedeMemoryRecordInput {
  tenantId: string;
  memoryRecordId: string;
  actorId: string;
  newContent: string;
  changeReason: string;
}

export interface SupersedeMemoryRecordResult {
  memoryRecord: MemoryRecord;
  version: MemoryRecordVersion;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Supersession is a correction, not a replacement: it creates version N+1
 * under the same memory_records.id (the directive-revision pattern, not the
 * receipt-supersession pattern) -- a remembered fact has a persistent
 * identity that gets corrected over time. The old version row is left
 * exactly as it was and remains queryable as history; only the parent's
 * denormalized `content` and `current_version_id` fast-path pointer move
 * forward.
 *
 * Locks the parent memory_records row FOR UPDATE before computing the next
 * version_number, so two concurrent supersessions of the same record can't
 * race to claim the same version_number -- the row lock is the actual
 * concurrency guard here; the table's own UNIQUE(tenant_id, memory_record_id,
 * version_number) constraint is defense-in-depth, not the primary mechanism.
 */
export async function supersedeMemoryRecord(input: SupersedeMemoryRecordInput): Promise<SupersedeMemoryRecordResult> {
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

    const maxVersionResult = await client.query<{ max_version: number }>(
      "SELECT COALESCE(MAX(version_number), 0) AS max_version FROM memory_record_versions WHERE tenant_id = $1 AND memory_record_id = $2",
      [input.tenantId, input.memoryRecordId],
    );
    const nextVersionNumber = Number(maxVersionResult.rows[0]!.max_version) + 1;

    const now = new Date().toISOString();
    const versionId = randomUUID();

    const parsedVersion = memoryRecordVersionSchema.parse({
      id: versionId,
      tenant_id: input.tenantId,
      memory_record_id: input.memoryRecordId,
      version_number: nextVersionNumber,
      content: input.newContent,
      change_reason: input.changeReason,
      is_deletion_marker: false,
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
      `UPDATE memory_records SET content = $1, current_version_id = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
      [input.newContent, versionId, input.memoryRecordId, input.tenantId],
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
      deleted_at: updatedRow.deleted_at ? toIso(updatedRow.deleted_at as string | Date) : null,
      created_at: toIso(updatedRow.created_at as string | Date),
    });

    return { memoryRecord: parsedRecord, version: parsedVersion };
  });
}
