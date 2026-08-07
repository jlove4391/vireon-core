import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { createMemoryRecordWithVersion } from "../../src/elora/memory/createMemoryRecordWithVersion.js";
import type { MemoryRecord } from "../../src/schemas/memoryRecord.js";

const TEST_FIXTURE_CHANGE_REASON = "Test fixture seed record.";

export interface SeedMemoryRecordInput {
  tenantId: string;
  content: string;
  recordType?: string | null;
  scope?: string | null;
}

/**
 * Reusable, non-production test infrastructure -- the seeding-side
 * counterpart to retrievalMetrics.ts's precedent for shared test utilities.
 * Calls the same createMemoryRecordWithVersion() core that
 * promoteMemoryCandidate.ts uses in production, so every fixture record this
 * produces is genuinely version-having (a real memory_record_versions row,
 * current_version_id actually set) rather than a raw INSERT that happens to
 * look complete. Without this, a fixture-seeded record is retrievable via
 * retrieveRelevantMemory() (reads content directly, no version requirement)
 * but structurally invisible to retrieveHybridMemory() (requires
 * current_version_id IS NOT NULL) -- exactly the corpus mismatch this helper
 * exists to close.
 */
export async function seedMemoryRecord(input: SeedMemoryRecordInput): Promise<MemoryRecord> {
  return withTenantTransaction(input.tenantId, (client) =>
    createMemoryRecordWithVersion(client, {
      tenantId: input.tenantId,
      content: input.content,
      recordType: input.recordType ?? null,
      scope: input.scope ?? null,
      sourceCandidateId: null,
      changeReason: TEST_FIXTURE_CHANGE_REASON,
    }),
  );
}
