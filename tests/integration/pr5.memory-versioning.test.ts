import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { DELETION_TOMBSTONE_CONTENT, deleteMemoryRecord } from "../../src/elora/memory/deleteMemoryRecord.js";
import { MemoryRecordAlreadyDeletedError, MemoryRecordNotFoundError } from "../../src/elora/memory/errors.js";
import { promoteMemoryCandidate } from "../../src/elora/memory/promoteMemoryCandidate.js";
import { reviewMemoryCandidate } from "../../src/elora/memory/reviewMemoryCandidate.js";
import { supersedeMemoryRecord } from "../../src/elora/memory/supersedeMemoryRecord.js";
import type { MemoryRecord } from "../../src/schemas/memoryRecord.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

async function seedProposedCandidate(ctx: SeededContext, content: string): Promise<string> {
  return withTenantTransaction(ctx.tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO memory_candidates
         (id, tenant_id, source_message_id, candidate_content, candidate_type, scope, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'proposed')`,
      [id, ctx.tenantId, ctx.messageId, content, "observation", "general"],
    );
    return id;
  });
}

async function promoteFreshRecord(ctx: SeededContext, content: string): Promise<MemoryRecord> {
  const candidateId = await seedProposedCandidate(ctx, content);
  await reviewMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId, decision: "approved" });
  return promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId });
}

async function fetchVersionRow(tenantId: string, versionId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM memory_record_versions WHERE id = $1 AND tenant_id = $2", [
      versionId,
      tenantId,
    ]);
    return result.rows[0];
  });
}

async function fetchAllVersions(tenantId: string, memoryRecordId: string): Promise<Record<string, unknown>[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT * FROM memory_record_versions WHERE tenant_id = $1 AND memory_record_id = $2 ORDER BY version_number ASC",
      [tenantId, memoryRecordId],
    );
    return result.rows;
  });
}

describe("PR 5: memory schema and versioning acceptance", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("promotion creates the memory_records row and its version-1 row atomically, linked via current_version_id", async () => {
    const record = await promoteFreshRecord(ctx, "The team prefers async standups.");

    expect(record.current_version_id).not.toBeNull();
    expect(record.deleted_at).toBeNull();

    const versionRow = await fetchVersionRow(ctx.tenantId, record.current_version_id!);
    expect(versionRow).toBeDefined();
    expect(versionRow.memory_record_id).toBe(record.id);
    expect(versionRow.version_number).toBe(1);
    expect(versionRow.content).toBe("The team prefers async standups.");
    expect(versionRow.is_deletion_marker).toBe(false);

    const allVersions = await fetchAllVersions(ctx.tenantId, record.id);
    expect(allVersions).toHaveLength(1);
  });

  it("supersession creates version 2+ under the same memory_records.id, updates current_version_id, and the old version remains queryable", async () => {
    const record = await promoteFreshRecord(ctx, "User's preferred contact method is email.");
    const originalVersionId = record.current_version_id!;

    const result = await supersedeMemoryRecord({
      tenantId: ctx.tenantId,
      memoryRecordId: record.id,
      actorId: ctx.actorId,
      newContent: "User's preferred contact method is Slack.",
      changeReason: "User corrected their preference.",
    });

    expect(result.version.version_number).toBe(2);
    expect(result.memoryRecord.id).toBe(record.id);
    expect(result.memoryRecord.content).toBe("User's preferred contact method is Slack.");
    expect(result.memoryRecord.current_version_id).toBe(result.version.id);
    expect(result.memoryRecord.current_version_id).not.toBe(originalVersionId);

    // The old version row is untouched and still queryable -- supersession
    // is a correction, not an erasure of history.
    const oldVersionRow = await fetchVersionRow(ctx.tenantId, originalVersionId);
    expect(oldVersionRow.content).toBe("User's preferred contact method is email.");
    expect(oldVersionRow.version_number).toBe(1);

    // A second supersession continues the version sequence correctly.
    const second = await supersedeMemoryRecord({
      tenantId: ctx.tenantId,
      memoryRecordId: record.id,
      actorId: ctx.actorId,
      newContent: "User's preferred contact method is a carrier pigeon.",
      changeReason: "User corrected again.",
    });
    expect(second.version.version_number).toBe(3);

    const allVersions = await fetchAllVersions(ctx.tenantId, record.id);
    expect(allVersions).toHaveLength(3);
    expect(allVersions.map((row) => row.content)).toEqual([
      "User's preferred contact method is email.",
      "User's preferred contact method is Slack.",
      "User's preferred contact method is a carrier pigeon.",
    ]);
  });

  it("supersedeMemoryRecord() rejects a not-found record and an already-deleted record", async () => {
    await expect(
      supersedeMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: randomUUID(),
        actorId: ctx.actorId,
        newContent: "irrelevant",
        changeReason: "irrelevant",
      }),
    ).rejects.toBeInstanceOf(MemoryRecordNotFoundError);

    const record = await promoteFreshRecord(ctx, "A fact that will be deleted before being superseded.");
    await deleteMemoryRecord({ tenantId: ctx.tenantId, memoryRecordId: record.id, actorId: ctx.actorId, reason: "test cleanup" });

    await expect(
      supersedeMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        newContent: "should not be allowed",
        changeReason: "should not be allowed",
      }),
    ).rejects.toBeInstanceOf(MemoryRecordAlreadyDeletedError);
  });

  it("deletion clears content, sets deleted_at, and writes a deletion-marker version whose own content is also cleared", async () => {
    const record = await promoteFreshRecord(ctx, "The user's home address is 123 Main St.");

    const result = await deleteMemoryRecord({
      tenantId: ctx.tenantId,
      memoryRecordId: record.id,
      actorId: ctx.actorId,
      reason: "User requested removal of this information.",
    });

    expect(result.memoryRecord.content).toBe(DELETION_TOMBSTONE_CONTENT);
    expect(result.memoryRecord.deleted_at).not.toBeNull();
    expect(result.deletionVersion.is_deletion_marker).toBe(true);
    expect(result.deletionVersion.content).toBe(DELETION_TOMBSTONE_CONTENT);
    expect(result.deletionVersion.version_number).toBe(2);

    const persistedRecord = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query("SELECT * FROM memory_records WHERE id = $1", [record.id]);
      return r.rows[0];
    });
    expect(persistedRecord.content).toBe(DELETION_TOMBSTONE_CONTENT);
    expect(persistedRecord.deleted_at).not.toBeNull();
    expect(persistedRecord.current_version_id).toBe(result.deletionVersion.id);

    // The fact that a deletion occurred, and when, is durably recorded --
    // but the original content is not recoverable from any version row,
    // including the pre-existing version-1 row that used to hold it.
    const allVersions = await fetchAllVersions(ctx.tenantId, record.id);
    expect(allVersions).toHaveLength(2);
    for (const row of allVersions) {
      expect(row.content).not.toContain("123 Main St");
      expect(row.content).toBe(DELETION_TOMBSTONE_CONTENT);
    }
    // Structural history (that a correction/version existed, and when) is
    // still honestly preserved -- version_number and created_at survive.
    expect(allVersions[0]!.version_number).toBe(1);
    expect(allVersions[1]!.version_number).toBe(2);
    expect(allVersions[1]!.is_deletion_marker).toBe(true);
  });

  it("deleteMemoryRecord() rejects a not-found record and a second deletion attempt", async () => {
    await expect(
      deleteMemoryRecord({ tenantId: ctx.tenantId, memoryRecordId: randomUUID(), actorId: ctx.actorId, reason: "n/a" }),
    ).rejects.toBeInstanceOf(MemoryRecordNotFoundError);

    const record = await promoteFreshRecord(ctx, "A fact that will be deleted twice, the second time rejected.");
    await deleteMemoryRecord({ tenantId: ctx.tenantId, memoryRecordId: record.id, actorId: ctx.actorId, reason: "first deletion" });

    await expect(
      deleteMemoryRecord({ tenantId: ctx.tenantId, memoryRecordId: record.id, actorId: ctx.actorId, reason: "second deletion" }),
    ).rejects.toBeInstanceOf(MemoryRecordAlreadyDeletedError);
  });

  it("deletion after supersession scrubs every prior version's content, not just the newest one", async () => {
    const record = await promoteFreshRecord(ctx, "The user's SSN is 000-00-0000.");
    await supersedeMemoryRecord({
      tenantId: ctx.tenantId,
      memoryRecordId: record.id,
      actorId: ctx.actorId,
      newContent: "The user's SSN is 111-11-1111.",
      changeReason: "corrected typo",
    });

    await deleteMemoryRecord({
      tenantId: ctx.tenantId,
      memoryRecordId: record.id,
      actorId: ctx.actorId,
      reason: "removal request",
    });

    const allVersions = await fetchAllVersions(ctx.tenantId, record.id);
    expect(allVersions).toHaveLength(3);
    for (const row of allVersions) {
      expect(row.content).toBe(DELETION_TOMBSTONE_CONTENT);
    }
  });

  it("enforces row-level security on memory_record_versions and memory_embeddings", async () => {
    const record = await promoteFreshRecord(ctx, "RLS probe record.");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const unsetVersions = await client.query("SELECT id FROM memory_record_versions WHERE memory_record_id = $1", [
        record.id,
      ]);
      expect(unsetVersions.rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const otherTenantId = randomUUID();
    const wrongTenantVersions = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM memory_record_versions WHERE memory_record_id = $1", [record.id]),
    );
    expect(wrongTenantVersions.rows).toHaveLength(0);

    const correctTenantVersions = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM memory_record_versions WHERE memory_record_id = $1", [record.id]),
    );
    expect(correctTenantVersions.rows.length).toBeGreaterThan(0);

    // memory_embeddings has no live writer in this PR (schema only) -- seed
    // a row directly to prove RLS is enforced on the table itself.
    const embeddingId = randomUUID();
    await withTenantTransaction(ctx.tenantId, async (txClient) => {
      await txClient.query(
        `INSERT INTO memory_embeddings
           (id, tenant_id, memory_record_version_id, embedding, model_provider, model_name, model_version, dimensions, source_content_hash)
         VALUES ($1, $2, $3, '[0.1,0.2,0.3]', 'test-provider', 'test-model', '1', 3, 'deadbeef')`,
        [embeddingId, ctx.tenantId, record.current_version_id],
      );
    });

    const wrongTenantEmbeddings = await withTenantTransaction(otherTenantId, async (txClient) =>
      txClient.query("SELECT id FROM memory_embeddings WHERE id = $1", [embeddingId]),
    );
    expect(wrongTenantEmbeddings.rows).toHaveLength(0);

    const correctTenantEmbeddings = await withTenantTransaction(ctx.tenantId, async (txClient) =>
      txClient.query("SELECT id FROM memory_embeddings WHERE id = $1", [embeddingId]),
    );
    expect(correctTenantEmbeddings.rows).toHaveLength(1);
  });
});
