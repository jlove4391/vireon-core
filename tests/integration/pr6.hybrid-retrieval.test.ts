import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { withTenantTransaction } from "../../src/db/withTenantTransaction.js";
import { MODEL_OPERATION_KINDS } from "../../src/elora/llm/executeModelOperation.js";
import { FakeEmbeddingProvider, computeFeatureHashEmbedding } from "../../src/elora/llm/fakeEmbeddingProvider.js";
import { FakeLlmProvider } from "../../src/elora/llm/fakeProvider.js";
import { runIntentInterpretation } from "../../src/elora/llm/operations/intentInterpretation.js";
import { runEmbedding } from "../../src/elora/llm/operations/embedding.js";
import { DELETION_TOMBSTONE_CONTENT, deleteMemoryRecord, deleteMemoryRecordForTest } from "../../src/elora/memory/deleteMemoryRecord.js";
import {
  MemoryRecordAlreadyDeletedError,
  MemoryRecordVersionIsDeletionMarkerError,
  MemoryRecordVersionNotFoundError,
} from "../../src/elora/memory/errors.js";
import { embedMemoryRecordVersion } from "../../src/elora/memory/embedMemoryRecordVersion.js";
import { promoteMemoryCandidate } from "../../src/elora/memory/promoteMemoryCandidate.js";
import {
  fuseRankings,
  retrieveHybridMemory,
  type HybridMemoryRetrievalResult,
} from "../../src/elora/memory/retrieveHybridMemory.js";
import {
  InvalidMemoryRetrievalStrategyError,
  readMemoryRetrievalStrategyFromEnv,
} from "../../src/elora/memory/retrievalStrategy.js";
import { supersedeMemoryRecord } from "../../src/elora/memory/supersedeMemoryRecord.js";
import { writeMemoryEmbedding, writeMemoryEmbeddingForTest } from "../../src/elora/memory/writeMemoryEmbedding.js";
import { retrieveRelevantMemory } from "../../src/elora/retrieveRelevantMemory.js";
import type { MemoryRecord } from "../../src/schemas/memoryRecord.js";
import { GOLDEN_MEMORY_QUERIES, GOLDEN_MEMORY_RECORDS, type GoldenMemoryQueryFixture } from "../fixtures/pr6.memory-retrieval-golden.js";
import { evaluateRetrieval, formatEvaluationReport, type RetrievalEvaluationReport } from "../shared/retrievalMetrics.js";
import { seedBaseContext, type SeededContext } from "../../test-utils/dbTestContext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0017_PATH = path.resolve(__dirname, "../../migrations/0017_embedding_operation_kind.sql");

// PR 6 §22: ingestUserMessage.ts's hybrid branch always calls
// createConfiguredEmbeddingProvider() (the real OpenAI provider). Mocking
// this one module -- not the raw OpenAI SDK -- lets §26.23's end-to-end
// wiring test prove the hybrid path is genuinely selected without a live
// network call, the same "mock the provider construction, not the
// transport" technique phase6f.llm-integration.test.ts already established
// for generateEloraResponse.ts's own provider resolution.
vi.mock("../../src/elora/llm/embeddingProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/elora/llm/embeddingProvider.js")>();
  return {
    ...actual,
    createConfiguredEmbeddingProvider: () => {
      if (!process.env.OPENAI_API_KEY) {
        throw new actual.EmbeddingProviderConfigurationError(
          "OPENAI_API_KEY is required when MEMORY_RETRIEVAL_STRATEGY=hybrid",
        );
      }
      return new FakeEmbeddingProvider();
    },
  };
});

// Imported after the mock above so ingestUserMessage.ts picks up the mocked
// construction function transitively (vi.mock intercepts by resolved
// module path, independent of import order in source, but importing here
// after the mock declaration keeps this file's own intent legible).
const { ingestUserMessage } = await import("../../src/elora/ingestUserMessage.js");
const { createConfiguredEmbeddingProvider, EmbeddingProviderConfigurationError } = await import(
  "../../src/elora/llm/embeddingProvider.js"
);

function extractReconciliationSql(): string {
  const fullText = readFileSync(MIGRATION_0017_PATH, "utf8");
  const beginMarker = "-- PR6_RECONCILIATION_BEGIN";
  const endMarker = "-- PR6_RECONCILIATION_END";
  const beginIndex = fullText.indexOf(beginMarker);
  const endIndex = fullText.indexOf(endMarker);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error("pr6 test: could not find reconciliation markers in migration 0017");
  }
  return fullText.slice(beginIndex + beginMarker.length, endIndex);
}

async function runReconciliation(): Promise<void> {
  await pool.query(extractReconciliationSql());
}

async function seedApprovedCandidate(
  ctx: SeededContext,
  content: string,
  scope?: string | null,
  recordType?: string | null,
): Promise<string> {
  return withTenantTransaction(ctx.tenantId, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO memory_candidates (id, tenant_id, source_message_id, candidate_content, candidate_type, scope, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved')`,
      [id, ctx.tenantId, ctx.messageId, content, recordType ?? null, scope ?? null],
    );
    return id;
  });
}

async function promoteRecord(
  ctx: SeededContext,
  content: string,
  scope?: string | null,
  recordType?: string | null,
): Promise<MemoryRecord> {
  const candidateId = await seedApprovedCandidate(ctx, content, scope, recordType);
  return promoteMemoryCandidate({ tenantId: ctx.tenantId, candidateId, actorId: ctx.actorId });
}

async function fetchMemoryRecordRow(tenantId: string, memoryRecordId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM memory_records WHERE id = $1 AND tenant_id = $2", [
      memoryRecordId,
      tenantId,
    ]);
    return result.rows[0];
  });
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

async function countVersionsForRecord(tenantId: string, memoryRecordId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM memory_record_versions WHERE tenant_id = $1 AND memory_record_id = $2",
      [tenantId, memoryRecordId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

async function fetchEmbeddingsForVersion(tenantId: string, versionId: string): Promise<Record<string, unknown>[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT * FROM memory_embeddings WHERE tenant_id = $1 AND memory_record_version_id = $2 ORDER BY created_at ASC",
      [tenantId, versionId],
    );
    return result.rows;
  });
}

async function countEmbeddingsForRecord(tenantId: string, memoryRecordId: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM memory_embeddings me
       WHERE me.tenant_id = $1
         AND me.memory_record_version_id IN (
             SELECT id FROM memory_record_versions WHERE tenant_id = $1 AND memory_record_id = $2
         )`,
      [tenantId, memoryRecordId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

async function fetchModelInvocationRow(tenantId: string, invocationId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query("SELECT * FROM model_invocations WHERE id = $1 AND tenant_id = $2", [
      invocationId,
      tenantId,
    ]);
    return result.rows[0];
  });
}

async function countModelInvocationsByOperation(tenantId: string, operationKind: string): Promise<number> {
  return withTenantTransaction(tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM model_invocations WHERE tenant_id = $1 AND operation_kind = $2",
      [tenantId, operationKind],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

interface SeededGoldenRecord {
  memoryRecordId: string;
  memoryRecordVersionId: string;
}

/** Seeds the golden dataset (tests/fixtures/pr6.memory-retrieval-golden.ts) for one tenant, applying each fixture's embed/supersede/backdate/delete steps in order. */
async function seedGoldenDataset(
  ctx: SeededContext,
  embeddingProvider: FakeEmbeddingProvider,
): Promise<Map<string, SeededGoldenRecord>> {
  const byKey = new Map<string, SeededGoldenRecord>();

  for (const fixture of GOLDEN_MEMORY_RECORDS) {
    const record = await promoteRecord(ctx, fixture.content, fixture.scope, fixture.recordType);
    let currentVersionId = record.current_version_id!;

    if (!fixture.skipEmbedding) {
      const embedResult = await embedMemoryRecordVersion({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: currentVersionId,
        provider: embeddingProvider,
      });
      if (!embedResult.ok) {
        throw new Error(`golden fixture "${fixture.key}" failed to embed: ${embedResult.error.kind}`);
      }
    }

    if (fixture.supersedeWithContent) {
      const superseded = await supersedeMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        newContent: fixture.supersedeWithContent,
        changeReason: "golden fixture supersession",
      });
      currentVersionId = superseded.version.id;
      // Deliberately not re-embedded -- proves the vector query's
      // source-hash freshness check would reject a stale embedding anyway;
      // here there simply isn't one for the new content at all.
    }

    if (fixture.versionCreatedAtOverride) {
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("UPDATE memory_record_versions SET created_at = $1 WHERE id = $2 AND tenant_id = $3", [
          fixture.versionCreatedAtOverride,
          currentVersionId,
          ctx.tenantId,
        ]);
      });
    }

    if (fixture.deleteAfterSeeding) {
      await deleteMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        reason: "golden fixture deletion",
      });
    }

    byKey.set(fixture.key, { memoryRecordId: record.id, memoryRecordVersionId: currentVersionId });
  }

  return byKey;
}

describe("PR 6: hybrid memory retrieval acceptance", () => {
  let originalEnv: { strategy?: string; openaiKey?: string };

  beforeAll(async () => {
    await migrate();
    originalEnv = {
      strategy: process.env.MEMORY_RETRIEVAL_STRATEGY,
      openaiKey: process.env.OPENAI_API_KEY,
    };
  });

  afterAll(async () => {
    if (originalEnv.strategy === undefined) delete process.env.MEMORY_RETRIEVAL_STRATEGY;
    else process.env.MEMORY_RETRIEVAL_STRATEGY = originalEnv.strategy;
    if (originalEnv.openaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv.openaiKey;
    await pool.end();
  });

  beforeEach(() => {
    delete process.env.MEMORY_RETRIEVAL_STRATEGY;
    delete process.env.OPENAI_API_KEY;
  });

  describe("26.1: migration", () => {
    it("accepts 'embedding' as a model_invocations operation_kind and still rejects an unknown one", async () => {
      const ctx = await seedBaseContext();
      expect(MODEL_OPERATION_KINDS).toContain("embedding");

      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO model_invocations (id, tenant_id, operation_kind, provider, model, status, invocation_key)
           VALUES ($1, $2, 'embedding', 'fake', 'fake-model', 'STARTED', $3)`,
          [randomUUID(), ctx.tenantId, `pr6-migration-accept:${randomUUID()}`],
        );
      });

      await expect(
        withTenantTransaction(ctx.tenantId, async (client) => {
          await client.query(
            `INSERT INTO model_invocations (id, tenant_id, operation_kind, provider, model, status, invocation_key)
             VALUES ($1, $2, 'not_a_real_operation', 'fake', 'fake-model', 'STARTED', $3)`,
            [randomUUID(), ctx.tenantId, `pr6-migration-reject:${randomUUID()}`],
          );
        }),
      ).rejects.toThrow();
    });

    it("reconciles legacy current_version_id gaps, leaves correct records unchanged, and is idempotent on re-run", async () => {
      const ctx = await seedBaseContext();

      // Case A: a legacy row with no version rows at all (mirrors this
      // codebase's own real direct-SQL test fixtures, e.g.
      // phase3.elora-ingestion.test.ts's seedMemoryRecord()).
      const noVersionRecordId = randomUUID();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("INSERT INTO memory_records (id, tenant_id, content, scope) VALUES ($1, $2, $3, 'legacy-probe')", [
          noVersionRecordId,
          ctx.tenantId,
          "Legacy content with no version row at all.",
        ]);
      });

      // Case B: version rows already exist, but no pointer.
      const hasVersionsRecordId = randomUUID();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("INSERT INTO memory_records (id, tenant_id, content, scope) VALUES ($1, $2, $3, 'legacy-probe')", [
          hasVersionsRecordId,
          ctx.tenantId,
          "stale denormalized content",
        ]);
        await client.query(
          `INSERT INTO memory_record_versions (id, tenant_id, memory_record_id, version_number, content, change_reason)
           VALUES ($1, $2, $3, 1, 'first version content', 'seed')`,
          [randomUUID(), ctx.tenantId, hasVersionsRecordId],
        );
        await client.query(
          `INSERT INTO memory_record_versions (id, tenant_id, memory_record_id, version_number, content, change_reason)
           VALUES ($1, $2, $3, 2, 'second, newer version content', 'seed')`,
          [randomUUID(), ctx.tenantId, hasVersionsRecordId],
        );
      });

      // Case C: a correctly-versioned record via the real promotion path --
      // must be left completely unchanged.
      const correctRecord = await promoteRecord(ctx, "Correctly versioned via promoteMemoryCandidate.");

      await runReconciliation();

      const noVersionRow = await fetchMemoryRecordRow(ctx.tenantId, noVersionRecordId);
      expect(noVersionRow.current_version_id).not.toBeNull();
      const createdVersion = await fetchVersionRow(ctx.tenantId, noVersionRow.current_version_id as string);
      expect(createdVersion.version_number).toBe(1);
      expect(createdVersion.content).toBe("Legacy content with no version row at all.");
      expect(createdVersion.is_deletion_marker).toBe(false);

      const hasVersionsRow = await fetchMemoryRecordRow(ctx.tenantId, hasVersionsRecordId);
      const pointedVersion = await fetchVersionRow(ctx.tenantId, hasVersionsRow.current_version_id as string);
      expect(pointedVersion.version_number).toBe(2);

      const correctRow = await fetchMemoryRecordRow(ctx.tenantId, correctRecord.id);
      expect(correctRow.current_version_id).toBe(correctRecord.current_version_id);

      const countBefore = await countVersionsForRecord(ctx.tenantId, noVersionRecordId);
      await runReconciliation();
      const countAfter = await countVersionsForRecord(ctx.tenantId, noVersionRecordId);
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("26.2: executor provider generalization", () => {
    it("existing LlmProvider operations still work unchanged", async () => {
      const ctx = await seedBaseContext();
      const result = await runIntentInterpretation(
        { content: "post-generalization probe" },
        { tenantId: ctx.tenantId, provider: new FakeLlmProvider(), invocationKey: `pr6-exec-llm:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
    });

    it("an EmbeddingProvider with no chat methods can call executeModelOperation() directly -- proving the executor was generalized, not the embedding provider forced to fake chat methods", async () => {
      const ctx = await seedBaseContext();
      const provider = new FakeEmbeddingProvider();
      const result = await runEmbedding(
        { text: "generalization probe text", purpose: "query", dimensions: provider.dimensions },
        { tenantId: ctx.tenantId, provider, invocationKey: `pr6-exec-embedding:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("26.3-26.4: embedding operation success and invalid-output classification", () => {
    it("succeeds via the fake provider with correct evidence", async () => {
      const ctx = await seedBaseContext();
      const provider = new FakeEmbeddingProvider();
      const result = await runEmbedding(
        { text: "a normal embedding probe sentence", purpose: "query", dimensions: provider.dimensions },
        { tenantId: ctx.tenantId, provider, invocationKey: `pr6-embed-success:${randomUUID()}` },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.embedding).toHaveLength(provider.dimensions);
      expect(result.value.dimensions).toBe(provider.dimensions);

      const row = await fetchModelInvocationRow(ctx.tenantId, result.invocationId);
      expect(row.operation_kind).toBe("embedding");
      expect(row.status).toBe("SUCCEEDED");
      expect(row.cognitive_run_id).toBeNull();
      expect(row.provider).toBe(provider.providerId);
      expect(row.model).toBe(provider.modelId);
      expect(row.input_tokens).not.toBeNull();
    });

    it("wrong dimensions, NaN, Infinity, and an empty vector are all classified INVALID_OUTPUT", async () => {
      const ctx = await seedBaseContext();
      const scenarios: Array<{ label: string; embedding: number[] }> = [
        { label: "wrong-dimensions", embedding: [0.1, 0.2, 0.3] },
        { label: "nan", embedding: [...Array(1536).keys()].map((i) => (i === 0 ? NaN : 0)) },
        { label: "infinity", embedding: [...Array(1536).keys()].map((i) => (i === 0 ? Infinity : 0)) },
        { label: "empty", embedding: [] },
      ];

      for (const scenario of scenarios) {
        const provider = new FakeEmbeddingProvider({
          embed: async () => ({
            output: { embedding: scenario.embedding, model: "fake-model", dimensions: scenario.embedding.length },
            usage: {},
          }),
        });
        const result = await runEmbedding(
          { text: "invalid output probe", purpose: "query", dimensions: 1536 },
          { tenantId: ctx.tenantId, provider, invocationKey: `pr6-embed-invalid:${scenario.label}:${randomUUID()}` },
        );
        expect(result.ok, scenario.label).toBe(false);
        if (!result.ok) {
          expect(result.error.kind, scenario.label).toBe("INVALID_OUTPUT");
        }
      }
    });
  });

  describe("26.5: deterministic fake embedding provider", () => {
    it("is deterministic, exact-dimensioned, finite, and gives related text higher similarity than a distractor", () => {
      const dims = 256;
      const text = "The team prefers Slack for urgent contact.";
      const v1 = computeFeatureHashEmbedding(text, dims);
      const v2 = computeFeatureHashEmbedding(text, dims);
      expect(v1).toEqual(v2);
      expect(v1).toHaveLength(dims);
      expect(v1.every(Number.isFinite)).toBe(true);

      const related = computeFeatureHashEmbedding("For urgent matters the team should be contacted via Slack.", dims);
      const distractor = computeFeatureHashEmbedding("Bananas are a great source of potassium.", dims);
      const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
      expect(cosine(v1, related)).toBeGreaterThan(cosine(v1, distractor));
    });

    it("returns an honest all-zero vector only when no valid token exists", () => {
      const v = computeFeatureHashEmbedding("   !!! ...", 128);
      expect(v.every((value) => value === 0)).toBe(true);
    });

    it("is stable across separate provider instances", async () => {
      const input = { text: "stability probe text", purpose: "query" as const, dimensions: 64 };
      const resultA = await new FakeEmbeddingProvider().embed(input, 5000);
      const resultB = await new FakeEmbeddingProvider().embed(input, 5000);
      expect((resultA.output as { embedding: number[] }).embedding).toEqual((resultB.output as { embedding: number[] }).embedding);
    });
  });

  describe("26.6: memory embedding write", () => {
    it("a version receives one active embedding with correct dimensions, source hash, and a real parsed vector", async () => {
      const ctx = await seedBaseContext();
      const content = "A fact worth embedding for real.";
      const record = await promoteRecord(ctx, content);
      const vector = computeFeatureHashEmbedding(content, 64);

      const written = await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: record.current_version_id!,
        embedding: vector,
        modelProvider: "fake",
        modelName: "fake-token-hash-embedding-v1",
        modelVersion: "fake-token-hash-embedding-v1",
      });

      expect(written.status).toBe("ACTIVE");
      expect(written.dimensions).toBe(vector.length);
      expect(Array.isArray(written.embedding)).toBe(true);
      expect(written.embedding).toHaveLength(vector.length);
      // pgvector's `vector` column is single-precision (float4) -- verified
      // directly by round-tripping a known value through Postgres, not
      // assumed. An exact-equality check against our double-precision JS
      // array would fail on real precision loss (e.g. 0.4082482904638631
      // round-trips as 0.4082483), so each element is compared with a
      // tolerance well inside float4's ~7-significant-digit precision.
      written.embedding.forEach((value, index) => {
        expect(value).toBeCloseTo(vector[index]!, 5);
      });
      expect(written.source_content_hash).toBe(createHash("sha256").update(content).digest("hex"));
    });

    it("rejects a not-found version, an already-deleted record's version, and a deletion-marker version", async () => {
      const ctx = await seedBaseContext();
      const record = await promoteRecord(ctx, "Will be deleted before embedding is attempted.");
      const originalVersionId = record.current_version_id!;
      const deletion = await deleteMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        reason: "test",
      });

      await expect(
        writeMemoryEmbedding({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: randomUUID(),
          embedding: computeFeatureHashEmbedding("x", 8),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ).rejects.toBeInstanceOf(MemoryRecordVersionNotFoundError);

      await expect(
        writeMemoryEmbedding({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: originalVersionId,
          embedding: computeFeatureHashEmbedding("x", 8),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ).rejects.toBeInstanceOf(MemoryRecordAlreadyDeletedError);

      await expect(
        writeMemoryEmbedding({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: deletion.deletionVersion.id,
          embedding: computeFeatureHashEmbedding("x", 8),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ).rejects.toBeInstanceOf(MemoryRecordVersionIsDeletionMarkerError);
    });

    it("a forced failure after insert, before supersede, leaves the prior ACTIVE embedding untouched (no orphaned new row)", async () => {
      const ctx = await seedBaseContext();
      const record = await promoteRecord(ctx, "Re-embed rollback probe content.");
      const versionId = record.current_version_id!;
      const first = await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: versionId,
        embedding: computeFeatureHashEmbedding("first embedding", 32),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });

      await expect(
        writeMemoryEmbeddingForTest({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: versionId,
          embedding: computeFeatureHashEmbedding("second embedding, should roll back", 32),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ).rejects.toThrow("test-only failure injection");

      const rows = await fetchEmbeddingsForVersion(ctx.tenantId, versionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(first.id);
      expect(rows[0]!.status).toBe("ACTIVE");
    });
  });

  describe("26.7-26.8: re-embedding lifecycle and concurrency", () => {
    it("re-embedding the same version supersedes the prior active embedding, leaving exactly one active row", async () => {
      const ctx = await seedBaseContext();
      const record = await promoteRecord(ctx, "Re-embed lifecycle probe content.");
      const versionId = record.current_version_id!;
      const first = await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: versionId,
        embedding: computeFeatureHashEmbedding("v1", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });
      const second = await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: versionId,
        embedding: computeFeatureHashEmbedding("v2", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });

      const rows = await fetchEmbeddingsForVersion(ctx.tenantId, versionId);
      expect(rows).toHaveLength(2);
      const firstRow = rows.find((row) => row.id === first.id)!;
      const secondRow = rows.find((row) => row.id === second.id)!;
      expect(firstRow.status).toBe("SUPERSEDED");
      expect(firstRow.superseded_by_embedding_id).toBe(second.id);
      expect(secondRow.status).toBe("ACTIVE");
      expect(secondRow.superseded_by_embedding_id).toBeNull();
      expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    });

    it("two concurrent writes for the same version leave exactly one active embedding", async () => {
      const ctx = await seedBaseContext();
      const record = await promoteRecord(ctx, "Concurrency probe content.");
      const versionId = record.current_version_id!;

      await Promise.all([
        writeMemoryEmbedding({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: versionId,
          embedding: computeFeatureHashEmbedding("concurrent-a", 16),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
        writeMemoryEmbedding({
          tenantId: ctx.tenantId,
          memoryRecordVersionId: versionId,
          embedding: computeFeatureHashEmbedding("concurrent-b", 16),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ]);

      const rows = await fetchEmbeddingsForVersion(ctx.tenantId, versionId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    });
  });

  describe("26.9-26.10: deletion removes embeddings, and rollback restores everything", () => {
    it("deleting a record with multiple embedded versions removes every embedding row atomically", async () => {
      const ctx = await seedBaseContext();
      const record = await promoteRecord(ctx, "Multi-version deletion probe.");
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: record.current_version_id!,
        embedding: computeFeatureHashEmbedding("v1", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });
      const superseded = await supersedeMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        newContent: "Second version content.",
        changeReason: "test",
      });
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: superseded.version.id,
        embedding: computeFeatureHashEmbedding("v2", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });

      expect(await countEmbeddingsForRecord(ctx.tenantId, record.id)).toBeGreaterThan(0);

      const deletion = await deleteMemoryRecord({
        tenantId: ctx.tenantId,
        memoryRecordId: record.id,
        actorId: ctx.actorId,
        reason: "test deletion",
      });

      expect(await countEmbeddingsForRecord(ctx.tenantId, record.id)).toBe(0);
      expect(deletion.memoryRecord.deleted_at).not.toBeNull();
      expect(deletion.deletionVersion.is_deletion_marker).toBe(true);
    });

    it("a forced failure after embedding deletion, before version scrubbing, rolls back everything", async () => {
      const ctx = await seedBaseContext();
      const content = "Deletion rollback probe content.";
      const record = await promoteRecord(ctx, content);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: record.current_version_id!,
        embedding: computeFeatureHashEmbedding("rollback", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });

      await expect(
        deleteMemoryRecordForTest({
          tenantId: ctx.tenantId,
          memoryRecordId: record.id,
          actorId: ctx.actorId,
          reason: "forced rollback probe",
        }),
      ).rejects.toThrow("test-only failure injection");

      expect(await countEmbeddingsForRecord(ctx.tenantId, record.id)).toBe(1);

      const recordRow = await fetchMemoryRecordRow(ctx.tenantId, record.id);
      expect(recordRow.deleted_at).toBeNull();
      expect(recordRow.content).toBe(content);
      expect(recordRow.current_version_id).toBe(record.current_version_id);

      const versionRow = await fetchVersionRow(ctx.tenantId, record.current_version_id!);
      expect(versionRow.content).toBe(content);
    });
  });

  describe("26.13-26.14: RRF fusion arithmetic", () => {
    it("computes exact RRF scores and final order for the hand-authored example", () => {
      const result = fuseRankings(["A", "B", "C"], ["B", "D", "A"]);
      const byId = Object.fromEntries(result.map((entry) => [entry.id, entry]));
      expect(byId.A!.rrfScore).toBeCloseTo(1 / 61 + 1 / 63, 12);
      expect(byId.B!.rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 12);
      expect(byId.C!.rrfScore).toBeCloseTo(1 / 63, 12);
      expect(byId.D!.rrfScore).toBeCloseTo(1 / 62, 12);

      const order = [...result].sort((a, b) => b.rrfScore - a.rrfScore).map((entry) => entry.id);
      expect(order).toEqual(["B", "A", "D", "C"]);
    });

    it("a record appearing in only one list still receives a valid score and remains eligible", () => {
      const result = fuseRankings(["only-fts"], ["only-vector"]);
      const byId = Object.fromEntries(result.map((entry) => [entry.id, entry]));
      expect(byId["only-fts"]!.rrfScore).toBeGreaterThan(0);
      expect(byId["only-fts"]!.vectorRank).toBeNull();
      expect(byId["only-vector"]!.rrfScore).toBeGreaterThan(0);
      expect(byId["only-vector"]!.ftsRank).toBeNull();
    });
  });

  describe("26.15-26.16: provider-call degradation and content-policy denial", () => {
    it("a query-embedding provider failure degrades to FTS-only without leaking a raw error", async () => {
      const ctx = await seedBaseContext();
      await promoteRecord(ctx, "Vendor renewal timeline content for degradation probe test.");
      const throwingProvider = new FakeEmbeddingProvider({
        embed: async () => {
          throw new Error("simulated provider failure");
        },
      });

      const result: HybridMemoryRetrievalResult = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: "vendor renewal timeline", invocationKey: `pr6-degradation:${randomUUID()}` },
        { embeddingProvider: throwingProvider },
      );

      expect(result.vectorStatus).toBe("PROVIDER_FAILED");
      expect(result.vectorCandidateCount).toBe(0);
      expect(result.ftsCandidateCount).toBeGreaterThan(0);
      expect(result.records.every((record) => !record.retrieval.sources.includes("vector"))).toBe(true);
      expect(result.queryModelInvocationId).not.toBeNull();

      const invocationRow = await fetchModelInvocationRow(ctx.tenantId, result.queryModelInvocationId!);
      expect(invocationRow.status).toBe("FAILED");
    });

    it("content-policy denial blocks the embedding call before invocation creation, and FTS still executes", async () => {
      const ctx = await seedBaseContext();
      await promoteRecord(ctx, "Vendor renewal timeline content for policy probe test.");
      const sensitiveQuery = `vendor renewal timeline Bearer ${"A".repeat(30)}`;

      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: sensitiveQuery, invocationKey: `pr6-policy:${randomUUID()}` },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );

      expect(result.vectorStatus).toBe("POLICY_BLOCKED");
      expect(result.queryModelInvocationId).toBeNull();
      expect(await countModelInvocationsByOperation(ctx.tenantId, "embedding")).toBe(0);
    });
  });

  describe("26.12 (dimension/model/hash safety): vector candidates require an exact model/dimension match and a fresh source hash", () => {
    it("excludes model-mismatched, dimension-mismatched, and stale-hash embeddings, while a correctly-embedded control record is still found", async () => {
      const ctx = await seedBaseContext();
      const sharedQuery = "quarterly widget production forecast review";

      const controlContent = "The quarterly widget production forecast review is complete.";
      const controlRecord = await promoteRecord(ctx, controlContent);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: controlRecord.current_version_id!,
        embedding: computeFeatureHashEmbedding(controlContent, 1536),
        modelProvider: "fake",
        modelName: "fake-token-hash-embedding-v1",
        modelVersion: "fake-token-hash-embedding-v1",
      });

      const modelMismatchContent = "The quarterly widget production forecast review needs updates.";
      const modelMismatchRecord = await promoteRecord(ctx, modelMismatchContent);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: modelMismatchRecord.current_version_id!,
        embedding: computeFeatureHashEmbedding(modelMismatchContent, 1536),
        modelProvider: "fake",
        modelName: "some-other-model",
        modelVersion: "some-other-model",
      });

      const dimensionMismatchContent = "The quarterly widget production forecast review was archived.";
      const dimensionMismatchRecord = await promoteRecord(ctx, dimensionMismatchContent);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: dimensionMismatchRecord.current_version_id!,
        // Wrong dimensions relative to the query provider's 1536 -- must be
        // filtered out before the `<=>` operator is ever evaluated (§17.1),
        // never left to produce a runtime operator error.
        embedding: computeFeatureHashEmbedding(dimensionMismatchContent, 64),
        modelProvider: "fake",
        modelName: "fake-token-hash-embedding-v1",
        modelVersion: "fake-token-hash-embedding-v1",
      });

      const staleHashContent = "The quarterly widget production forecast review was postponed.";
      const staleHashRecord = await promoteRecord(ctx, staleHashContent);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: staleHashRecord.current_version_id!,
        embedding: computeFeatureHashEmbedding(staleHashContent, 1536),
        modelProvider: "fake",
        modelName: "fake-token-hash-embedding-v1",
        modelVersion: "fake-token-hash-embedding-v1",
      });
      // Mutates the version's content directly, without re-embedding -- the
      // embedding written above now describes stale, no-longer-current
      // text. No real code path in this PR can reach this state (every
      // real write goes through supersedeMemoryRecord.ts, which creates a
      // new version rather than mutating an existing one), but the
      // source-hash freshness check exists as defense-in-depth regardless.
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("UPDATE memory_record_versions SET content = $1 WHERE id = $2 AND tenant_id = $3", [
          "Completely different content, never embedded.",
          staleHashRecord.current_version_id,
          ctx.tenantId,
        ]);
      });

      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: sharedQuery, invocationKey: `pr6-vector-safety:${randomUUID()}`, candidateLimit: 20 },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );

      const vectorSourcedIds = result.records.filter((record) => record.retrieval.sources.includes("vector")).map((record) => record.id);
      expect(vectorSourcedIds).toContain(controlRecord.id);
      expect(vectorSourcedIds).not.toContain(modelMismatchRecord.id);
      expect(vectorSourcedIds).not.toContain(dimensionMismatchRecord.id);
      expect(vectorSourcedIds).not.toContain(staleHashRecord.id);
    });
  });

  describe("26.17: deleted-record exclusion (both retrieval paths), isolated from content-scrubbing behavior", () => {
    it("retrieveRelevantMemory() excludes a record with deleted_at set even when its content would otherwise match", async () => {
      const ctx = await seedBaseContext();
      const uniqueToken = `deletedfilterprobe${randomUUID().replace(/-/g, "")}`;
      const record = await promoteRecord(ctx, `This mentions ${uniqueToken} prominently.`);
      // Directly sets deleted_at WITHOUT scrubbing content -- isolates
      // exactly what the deleted_at IS NULL filter itself excludes,
      // independent of deleteMemoryRecord.ts's own content-scrubbing
      // (already proven separately in pr5's own test suite).
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("UPDATE memory_records SET deleted_at = now() WHERE id = $1 AND tenant_id = $2", [
          record.id,
          ctx.tenantId,
        ]);
      });

      const result = await retrieveRelevantMemory({ tenantId: ctx.tenantId, queryText: uniqueToken });
      expect(result.find((row) => row.id === record.id)).toBeUndefined();
    });

    it("retrieveHybridMemory() excludes a record with deleted_at set from both FTS and vector candidates, even when content/embedding would otherwise match", async () => {
      const ctx = await seedBaseContext();
      const uniqueToken = `hybriddeletedprobe${randomUUID().replace(/-/g, "")}`;
      const content = `This mentions ${uniqueToken} prominently for the hybrid deleted filter test.`;
      const record = await promoteRecord(ctx, content);
      await writeMemoryEmbedding({
        tenantId: ctx.tenantId,
        memoryRecordVersionId: record.current_version_id!,
        embedding: computeFeatureHashEmbedding(content, 1536),
        modelProvider: "fake",
        modelName: "fake-token-hash-embedding-v1",
        modelVersion: "fake-token-hash-embedding-v1",
      });

      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query("UPDATE memory_records SET deleted_at = now() WHERE id = $1 AND tenant_id = $2", [
          record.id,
          ctx.tenantId,
        ]);
      });

      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: uniqueToken, invocationKey: `pr6-hybrid-deleted:${randomUUID()}` },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );
      expect(result.records.find((row) => row.id === record.id)).toBeUndefined();
    });
  });

  describe("26.21-26.25: feature flag", () => {
    it("unset defaults to deterministic -- no embedding provider constructed, OPENAI_API_KEY not required", async () => {
      expect(readMemoryRetrievalStrategyFromEnv()).toBe("deterministic");
      const ctx = await seedBaseContext();
      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        threadId: ctx.threadId,
        actorId: ctx.actorId,
        content: "What's the weather like today?",
      });
      expect(result.intent.intent_type).toBe("informational");
      expect(await countModelInvocationsByOperation(ctx.tenantId, "embedding")).toBe(0);
    });

    it("explicit 'deterministic' behaves identically to unset", () => {
      process.env.MEMORY_RETRIEVAL_STRATEGY = "deterministic";
      expect(readMemoryRetrievalStrategyFromEnv()).toBe("deterministic");
    });

    it("'hybrid' is a recognized, selectable value", () => {
      process.env.MEMORY_RETRIEVAL_STRATEGY = "hybrid";
      expect(readMemoryRetrievalStrategyFromEnv()).toBe("hybrid");
    });

    it("an unknown explicit value throws a typed configuration error", () => {
      process.env.MEMORY_RETRIEVAL_STRATEGY = "not-a-real-strategy";
      expect(() => readMemoryRetrievalStrategyFromEnv()).toThrow(InvalidMemoryRetrievalStrategyError);
    });

    it("hybrid strategy with no OPENAI_API_KEY fails provider configuration; deterministic remains fully operational without it", async () => {
      process.env.MEMORY_RETRIEVAL_STRATEGY = "hybrid";
      expect(() => createConfiguredEmbeddingProvider()).toThrow(EmbeddingProviderConfigurationError);

      delete process.env.MEMORY_RETRIEVAL_STRATEGY;
      const ctx = await seedBaseContext();
      await expect(
        ingestUserMessage({
          tenantId: ctx.tenantId,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          threadId: ctx.threadId,
          actorId: ctx.actorId,
          content: "What's the status update?",
        }),
      ).resolves.toBeDefined();
    });

    it("ingestUserMessage() selects the hybrid path end-to-end when MEMORY_RETRIEVAL_STRATEGY=hybrid, producing a real query embedding invocation", async () => {
      process.env.MEMORY_RETRIEVAL_STRATEGY = "hybrid";
      process.env.OPENAI_API_KEY = "test-openai-key";
      const ctx = await seedBaseContext();
      await promoteRecord(ctx, "The office relocation plans for next quarter include a downtown move.");

      const result = await ingestUserMessage({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        threadId: ctx.threadId,
        actorId: ctx.actorId,
        content: "What are the office relocation plans?",
      });

      expect(result.intent.intent_type).toBe("informational");
      expect(await countModelInvocationsByOperation(ctx.tenantId, "embedding")).toBeGreaterThan(0);
    });
  });

  describe("26.27: tenant isolation", () => {
    it("model_invocations, memory_records, memory_record_versions, and memory_embeddings are all tenant-isolated under the non-superuser role", async () => {
      const ctxA = await seedBaseContext();
      const ctxB = await seedBaseContext();

      const record = await promoteRecord(ctxA, "Tenant A secret vendor renewal plan.");
      const written = await writeMemoryEmbedding({
        tenantId: ctxA.tenantId,
        memoryRecordVersionId: record.current_version_id!,
        embedding: computeFeatureHashEmbedding("Tenant A secret vendor renewal plan.", 16),
        modelProvider: "fake",
        modelName: "fake",
        modelVersion: "fake",
      });

      const embeddingRun = await runEmbedding(
        { text: "tenant isolation embedding probe", purpose: "query", dimensions: 1536 },
        { tenantId: ctxA.tenantId, provider: new FakeEmbeddingProvider(), invocationKey: `pr6-tenant-isolation:${randomUUID()}` },
      );
      expect(embeddingRun.ok).toBe(true);

      const crossTenantRecord = await withTenantTransaction(ctxB.tenantId, (client) =>
        client.query("SELECT id FROM memory_records WHERE id = $1", [record.id]),
      );
      expect(crossTenantRecord.rows).toHaveLength(0);

      const crossTenantVersion = await withTenantTransaction(ctxB.tenantId, (client) =>
        client.query("SELECT id FROM memory_record_versions WHERE memory_record_id = $1", [record.id]),
      );
      expect(crossTenantVersion.rows).toHaveLength(0);

      const crossTenantEmbedding = await withTenantTransaction(ctxB.tenantId, (client) =>
        client.query("SELECT id FROM memory_embeddings WHERE id = $1", [written.id]),
      );
      expect(crossTenantEmbedding.rows).toHaveLength(0);

      if (embeddingRun.ok) {
        const crossTenantInvocation = await withTenantTransaction(ctxB.tenantId, (client) =>
          client.query("SELECT id FROM model_invocations WHERE id = $1", [embeddingRun.invocationId]),
        );
        expect(crossTenantInvocation.rows).toHaveLength(0);
      }

      // Tenant B cannot write an embedding against tenant A's version --
      // its tenant-scoped lookup simply never finds the version at all.
      await expect(
        writeMemoryEmbedding({
          tenantId: ctxB.tenantId,
          memoryRecordVersionId: record.current_version_id!,
          embedding: computeFeatureHashEmbedding("cross-tenant probe", 16),
          modelProvider: "fake",
          modelName: "fake",
          modelVersion: "fake",
        }),
      ).rejects.toBeInstanceOf(MemoryRecordVersionNotFoundError);

      const correctTenantRecord = await withTenantTransaction(ctxA.tenantId, (client) =>
        client.query("SELECT id FROM memory_records WHERE id = $1", [record.id]),
      );
      expect(correctTenantRecord.rows.length).toBeGreaterThan(0);

      const rlsRows = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`,
        [["model_invocations", "memory_records", "memory_record_versions", "memory_embeddings"]],
      );
      expect(rlsRows.rows).toHaveLength(4);
      for (const row of rlsRows.rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    });
  });

  describe("golden retrieval dataset: FTS/vector ranking, filters, citations, and Recall@5 (26.11/26.12/26.18-26.20/26.26)", () => {
    let ctx: SeededContext;
    let idsByKey: Map<string, SeededGoldenRecord>;

    beforeAll(async () => {
      ctx = await seedBaseContext();
      idsByKey = await seedGoldenDataset(ctx, new FakeEmbeddingProvider());
    });

    function relevantIdsFor(query: GoldenMemoryQueryFixture): string[] {
      return query.relevantMemoryRecordKeys.map((key) => idsByKey.get(key)!.memoryRecordId);
    }

    it("26.11: FTS ranking finds the FTS-eligible records, excluding historical and deleted rows", async () => {
      const queryFixture = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "acme-renewal")!;
      const ftsOnly = idsByKey.get("acme-fts-only")!;
      const historical = idsByKey.get("acme-historical")!;
      const deleted = idsByKey.get("acme-deleted")!;

      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: queryFixture.query, invocationKey: `pr6-golden-fts:${randomUUID()}`, limit: 20, candidateLimit: 20 },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );

      const ftsSourcedIds = result.records.filter((record) => record.retrieval.sources.includes("fts")).map((record) => record.id);
      expect(ftsSourcedIds).toContain(ftsOnly.memoryRecordId);
      expect(result.records.map((record) => record.id)).not.toContain(historical.memoryRecordId);
      expect(result.records.map((record) => record.id)).not.toContain(deleted.memoryRecordId);

      // PR 7 §20: an FTS-sourced result's matchedSnippet is real ts_headline()
      // markup over the query terms that actually matched -- structurally
      // derived from the same FTS computation that produced its ranking,
      // never a fabricated or empty stand-in.
      const ftsOnlyRecord = result.records.find((record) => record.id === ftsOnly.memoryRecordId)!;
      expect(ftsOnlyRecord.retrieval.matchedSnippet).not.toBeNull();
      expect(ftsOnlyRecord.retrieval.matchedSnippet).toContain("<b>");
    });

    it("26.12: vector ranking uses active/matching-model/fresh-hash current-version embeddings only", async () => {
      const queryFixture = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "acme-renewal")!;
      const vectorOnly = idsByKey.get("acme-vector-only")!;
      const ftsOnly = idsByKey.get("acme-fts-only")!;
      const historical = idsByKey.get("acme-historical")!;

      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: queryFixture.query, invocationKey: `pr6-golden-vector:${randomUUID()}`, limit: 20, candidateLimit: 20 },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );

      const vectorSourcedIds = result.records.filter((record) => record.retrieval.sources.includes("vector")).map((record) => record.id);
      expect(vectorSourcedIds).toContain(vectorOnly.memoryRecordId);
      expect(vectorSourcedIds).not.toContain(ftsOnly.memoryRecordId);
      expect(vectorSourcedIds).not.toContain(historical.memoryRecordId);

      const distances = result.records.map((record) => record.retrieval.vectorDistance).filter((value): value is number => value !== null);
      expect(distances.length).toBeGreaterThan(0);
      expect(distances.every(Number.isFinite)).toBe(true);

      // PR 7 §20: a result found via vector search alone, with no FTS match
      // at all, has nothing for ts_headline() to highlight -- matchedSnippet
      // must be null, never an empty string standing in for "nothing to show."
      const vectorOnlyRecord = result.records.find((record) => record.id === vectorOnly.memoryRecordId)!;
      expect(vectorOnlyRecord.retrieval.sources).not.toContain("fts");
      expect(vectorOnlyRecord.retrieval.matchedSnippet).toBeNull();
    });

    it("26.19: scope and record-type filters apply identically to FTS and vector candidate lists", async () => {
      const scopeQuery = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "scope-filter")!;
      const scopeResult = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: scopeQuery.query, invocationKey: `pr6-golden-scope:${randomUUID()}`, filters: scopeQuery.filters, limit: 10 },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );
      expect(scopeResult.records.map((record) => record.id)).toEqual([idsByKey.get("scope-engineering")!.memoryRecordId]);

      const recordTypeQuery = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "recordtype-filter")!;
      const recordTypeResult = await retrieveHybridMemory(
        {
          tenantId: ctx.tenantId,
          queryText: recordTypeQuery.query,
          invocationKey: `pr6-golden-recordtype:${randomUUID()}`,
          filters: recordTypeQuery.filters,
          limit: 10,
        },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );
      expect(recordTypeResult.records.map((record) => record.id)).toEqual([idsByKey.get("scope-engineering")!.memoryRecordId]);
    });

    it("26.18: temporal filters apply an inclusive lower bound and an exclusive upper bound", async () => {
      const temporalQuery = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "temporal-filter")!;
      const result = await retrieveHybridMemory(
        {
          tenantId: ctx.tenantId,
          queryText: temporalQuery.query,
          invocationKey: `pr6-golden-temporal:${randomUUID()}`,
          filters: temporalQuery.filters,
          limit: 10,
        },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );
      // Asserts inclusion/exclusion at the exact boundary rather than exact
      // array equality: the shared golden tenant has other records whose
      // version timestamp defaults to whenever this suite actually runs
      // (promoteMemoryCandidate.ts always uses "now"), which may coincide
      // with this filter's window by pure calendar coincidence and still
      // surface via vector similarity's baseline shared-stopword score --
      // that's environmental noise, not a boundary-behavior regression. The
      // one thing that must always hold, regardless of when this test runs,
      // is that -old (before the window) and -future (at/after the window)
      // never appear while -current (inside it) always does.
      const ids = result.records.map((record) => record.id);
      expect(ids).toContain(idsByKey.get("temporal-current")!.memoryRecordId);
      expect(ids).not.toContain(idsByKey.get("temporal-old")!.memoryRecordId);
      expect(ids).not.toContain(idsByKey.get("temporal-future")!.memoryRecordId);
    });

    it("26.20: every result's citation references the record's real current version", async () => {
      const queryFixture = GOLDEN_MEMORY_QUERIES.find((query) => query.key === "acme-renewal")!;
      const result = await retrieveHybridMemory(
        { tenantId: ctx.tenantId, queryText: queryFixture.query, invocationKey: `pr6-golden-citations:${randomUUID()}`, limit: 20, candidateLimit: 20 },
        { embeddingProvider: new FakeEmbeddingProvider() },
      );
      expect(result.records.length).toBeGreaterThan(0);

      for (const record of result.records) {
        expect(record.citation.kind).toBe("memory_record_version");
        expect(record.citation.memoryRecordId).toBe(record.id);
        expect(record.citation.memoryRecordVersionId).toBe(record.memoryRecordVersionId);
        expect(record.citation.versionNumber).toBe(record.versionNumber);

        const dbRow = await fetchMemoryRecordRow(ctx.tenantId, record.id);
        expect(dbRow.current_version_id).toBe(record.memoryRecordVersionId);
      }

      const historical = idsByKey.get("acme-historical")!;
      expect(result.records.find((record) => record.id === historical.memoryRecordId)).toBeUndefined();
    });

    it("26.26: hybrid Recall@5 = 1.0 across the entire golden dataset", async () => {
      const reports: RetrievalEvaluationReport[] = [];

      for (const queryFixture of GOLDEN_MEMORY_QUERIES) {
        const result = await retrieveHybridMemory(
          {
            tenantId: ctx.tenantId,
            queryText: queryFixture.query,
            invocationKey: `pr6-golden-eval:${queryFixture.key}:${randomUUID()}`,
            filters: queryFixture.filters,
            limit: 5,
            candidateLimit: 20,
          },
          { embeddingProvider: new FakeEmbeddingProvider() },
        );
        const retrievedIds = result.records.map((record) => record.id);
        const relevantIds = relevantIdsFor(queryFixture);
        const report = evaluateRetrieval(queryFixture.query, retrievedIds, relevantIds, 5);
        reports.push(report);

        expect(report.recallAt5, formatEvaluationReport(report)).toBe(1.0);
      }

      // eslint-disable-next-line no-console -- deliberate: the aggregate evaluation report is the point of this test, per §34's own reporting requirement.
      console.log(reports.map(formatEvaluationReport).join("\n\n"));

      // PR 7 §20: a durable evaluation artifact, written by this test run
      // itself -- not hand-authored -- so the actual Recall@5/Precision@5
      // numbers have provable, ongoing value beyond a single CI checkmark,
      // the same "materially provable, not just green" discipline every
      // core-records/*.json report from Phase 1 onward already established.
      const evaluationReport = {
        generatedAt: new Date().toISOString(),
        reports,
      };
      const reportPath = path.resolve(process.cwd(), "core-records/pr7-retrieval-evaluation.json");
      writeFileSync(reportPath, `${JSON.stringify(evaluationReport, null, 2)}\n`, "utf8");
    });
  });
});
