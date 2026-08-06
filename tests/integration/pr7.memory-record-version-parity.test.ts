import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { countUnversionedActiveMemoryRecords } from "../../src/elora/memory/index.js";
import { retrieveHybridMemory } from "../../src/elora/memory/retrieveHybridMemory.js";
import { FakeEmbeddingProvider } from "../../src/elora/llm/fakeEmbeddingProvider.js";
import { retrieveRelevantMemory } from "../../src/elora/retrieveRelevantMemory.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";
import { seedMemoryRecord } from "../shared/seedMemoryRecord.js";

/**
 * Regression coverage for the fix closing the hybrid/deterministic corpus
 * mismatch: four test fixtures (phase3, phase6g, phase6h, pr4) used to
 * create memory_records rows via a raw INSERT that never set
 * current_version_id. Such a row is retrievable via retrieveRelevantMemory()
 * (reads content directly) but structurally invisible to
 * retrieveHybridMemory() (requires current_version_id IS NOT NULL) -- so
 * switching MEMORY_RETRIEVAL_STRATEGY from deterministic to hybrid could
 * silently shrink the eligible corpus, not just re-rank it. seedMemoryRecord()
 * (tests/shared/seedMemoryRecord.ts) now routes through the same
 * createMemoryRecordWithVersion() core promoteMemoryCandidate.ts uses in
 * production, closing that gap for every current and future caller.
 */
describe("PR 7: memory record version parity in test seeding", () => {
  let ctx: SeededContext;

  beforeAll(async () => {
    await migrate();
    ctx = await seedBaseContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("a record seeded via seedMemoryRecord() is retrievable via both retrieveRelevantMemory() and retrieveHybridMemory() -- the actual regression this fix closes", async () => {
    const uniqueToken = `parityprobe${randomUUID().replace(/-/g, "")}`;
    const content = `This note mentions ${uniqueToken} for the version parity test.`;
    const seeded = await seedMemoryRecord({ tenantId: ctx.tenantId, content, recordType: "note", scope: "general" });

    // Prerequisite for the parity claim to mean anything: the seeded row
    // must actually have a version, unlike the old raw-SQL fixtures.
    expect(seeded.current_version_id).not.toBeNull();

    const deterministicResults = await retrieveRelevantMemory({ tenantId: ctx.tenantId, queryText: uniqueToken });
    expect(deterministicResults.map((record) => record.id)).toContain(seeded.id);

    const hybridResult = await retrieveHybridMemory(
      { tenantId: ctx.tenantId, queryText: uniqueToken, invocationKey: `pr7-parity:${randomUUID()}` },
      { embeddingProvider: new FakeEmbeddingProvider() },
    );
    expect(hybridResult.records.map((record) => record.id)).toContain(seeded.id);
  });

  it("countUnversionedActiveMemoryRecords() is 0 after seeding exclusively via seedMemoryRecord(), and correctly nonzero once a row deliberately bypasses it", async () => {
    const freshCtx = await seedBaseContext();

    await seedMemoryRecord({ tenantId: freshCtx.tenantId, content: "a properly versioned record" });
    expect(await countUnversionedActiveMemoryRecords(freshCtx.tenantId)).toBe(0);

    // Deliberate, intentional bypass -- the one place in this whole fix
    // where a raw INSERT is correct, because the counter's entire purpose
    // is to detect exactly this condition.
    const unversionedId = randomUUID();
    await withTenantTransaction(freshCtx.tenantId, async (client) => {
      await client.query("INSERT INTO memory_records (id, tenant_id, content, scope) VALUES ($1, $2, $3, $4)", [
        unversionedId,
        freshCtx.tenantId,
        "a deliberately unversioned record",
        "general",
      ]);
    });

    expect(await countUnversionedActiveMemoryRecords(freshCtx.tenantId)).toBe(1);
  });
});
