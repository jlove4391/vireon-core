import { withTenantTransaction } from "../../db/withTenantTransaction.js";
import type { EmbeddingProvider } from "../llm/embeddingProvider.js";
import type { ModelOperationErrorKind } from "../llm/errors.js";
import { runEmbedding } from "../llm/operations/embedding.js";
import type { RetrievedMemoryRecord } from "../retrieveRelevantMemory.js";
import { serializeVector } from "./vectorSerialization.js";

// PR 6 §18: standard, untuned RRF. Never adjusted from the golden dataset --
// tuning k against the very dataset used to prove Recall@5 would make the
// evaluation circular.
export const RRF_K = 60;

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_CANDIDATE_LIMIT = 20;
const CANDIDATE_LIMIT_MULTIPLIER = 4;
// PR 6 §14.2: a reasonable hard maximum, to prevent an accidental
// unbounded-retrieval request regardless of what a caller passes.
const MAX_CANDIDATE_LIMIT = 100;

export interface RetrieveHybridMemoryFilters {
  scopes?: string[];
  recordTypes?: string[];
  /** Inclusive lower bound. */
  currentVersionCreatedAfter?: string;
  /** Exclusive upper bound. */
  currentVersionCreatedBefore?: string;
}

export interface RetrieveHybridMemoryInput {
  tenantId: string;
  queryText: string;
  invocationKey: string;
  attemptNumber?: number;
  limit?: number;
  candidateLimit?: number;
  requestingPersonaDomain?: string | null;
  filters?: RetrieveHybridMemoryFilters;
}

/** Injected separately from the input -- construction (and its OPENAI_API_KEY requirement) is the caller's concern, not this function's. See §14.4/§2.3: a missing key is a configuration error at the construction site, never a runtime degradation this function decides on its own. */
export interface RetrieveHybridMemoryDependencies {
  embeddingProvider: EmbeddingProvider;
}

export interface HybridRetrievedMemoryRecord extends RetrievedMemoryRecord {
  memoryRecordVersionId: string;
  versionNumber: number;
  versionCreatedAt: string;
  citation: {
    kind: "memory_record_version";
    memoryRecordId: string;
    memoryRecordVersionId: string;
    versionNumber: number;
    sourceCandidateId: string | null;
  };
  retrieval: {
    sources: Array<"fts" | "vector">;
    ftsRank: number | null;
    vectorRank: number | null;
    rrfScore: number;
    vectorDistance: number | null;
    /**
     * PR 7 §20: query-term highlighting markup (Postgres's own
     * ts_headline(), default StartSel/StopSel of <b>/</b>) over the exact
     * content the FTS ranking already scored -- never a new LLM call
     * generating a written explanation, same "do not make the model invent
     * citations from prose" discipline PR 6 already locked for citations.
     * null (never an empty string) specifically when this result came from
     * vector search alone with no FTS match at all -- there is nothing to
     * highlight, so nothing is fabricated to stand in for it.
     */
    matchedSnippet: string | null;
  };
}

export type VectorRetrievalStatus =
  | "AVAILABLE"
  | "PROVIDER_FAILED"
  | "TIMED_OUT"
  | "POLICY_BLOCKED"
  | "PERSISTENCE_FAILED";

export interface HybridMemoryRetrievalResult {
  records: HybridRetrievedMemoryRecord[];
  queryModelInvocationId: string | null;
  vectorStatus: VectorRetrievalStatus;
  ftsCandidateCount: number;
  vectorCandidateCount: number;
}

/** PR 6 §19: `memory:<memoryRecordId>@version:<versionNumber>` -- a retrieval-provenance citation, never something a model invents from prose. */
export function buildMemoryCitationLabel(memoryRecordId: string, versionNumber: number): string {
  return `memory:${memoryRecordId}@version:${versionNumber}`;
}

export interface RrfFusedEntry {
  id: string;
  rrfScore: number;
  ftsRank: number | null;
  vectorRank: number | null;
  sources: Array<"fts" | "vector">;
}

/**
 * PR 6 §18: pure Reciprocal Rank Fusion, exported standalone so its
 * arithmetic is independently testable. One-based ranks (`index + 1`), no
 * score normalization, no per-source weighting, k fixed at RRF_K. A record
 * appearing in only one list still gets a real score and remains eligible
 * -- there is no "must appear in both" requirement anywhere in this
 * function.
 */
export function fuseRankings(ftsIds: readonly string[], vectorIds: readonly string[]): RrfFusedEntry[] {
  const entries = new Map<string, RrfFusedEntry>();

  function entryFor(id: string): RrfFusedEntry {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, rrfScore: 0, ftsRank: null, vectorRank: null, sources: [] };
      entries.set(id, entry);
    }
    return entry;
  }

  ftsIds.forEach((id, index) => {
    const rank = index + 1;
    const entry = entryFor(id);
    entry.ftsRank = rank;
    entry.rrfScore += 1 / (RRF_K + rank);
    entry.sources.push("fts");
  });

  vectorIds.forEach((id, index) => {
    const rank = index + 1;
    const entry = entryFor(id);
    entry.vectorRank = rank;
    entry.rrfScore += 1 / (RRF_K + rank);
    entry.sources.push("vector");
  });

  return Array.from(entries.values());
}

/**
 * §20: maps the executor's generic error taxonomy onto the four failure
 * variants of VectorRetrievalStatus without ever exposing a raw provider
 * error. INVALID_OUTPUT/MODEL_REFUSAL/INCOMPLETE_OUTPUT are not realistic
 * outcomes for an embedding call (they're Responses-API-specific concepts
 * that don't apply to OpenAIEmbeddingProvider) but fall into PROVIDER_FAILED
 * as a safe catch-all rather than being left unhandled.
 */
function mapEmbeddingErrorToVectorStatus(kind: ModelOperationErrorKind): VectorRetrievalStatus {
  switch (kind) {
    case "TIMEOUT":
      return "TIMED_OUT";
    case "SENSITIVE_CONTEXT_BLOCKED":
      return "POLICY_BLOCKED";
    case "PERSISTENCE_FAILURE":
      return "PERSISTENCE_FAILED";
    default:
      return "PROVIDER_FAILED";
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface NormalizedFilters {
  scopes: string[] | null;
  recordTypes: string[] | null;
  currentVersionCreatedAfter: string | null;
  currentVersionCreatedBefore: string | null;
}

/**
 * §15: validates timestamps and normalizes empty filter arrays to "no
 * filter" once, up front -- before either candidate query is built. An
 * empty `scopes: []`/`recordTypes: []` must never silently compile into
 * `= ANY('{}')` (which would return zero rows with no indication why); it
 * is treated identically to the filter being omitted entirely.
 */
function normalizeFilters(filters: RetrieveHybridMemoryFilters | undefined): NormalizedFilters {
  const scopes = filters?.scopes && filters.scopes.length > 0 ? filters.scopes : null;
  const recordTypes = filters?.recordTypes && filters.recordTypes.length > 0 ? filters.recordTypes : null;

  function validateTimestamp(label: string, raw: string | undefined): string | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`retrieveHybridMemory: filters.${label} is not a valid timestamp: ${raw}`);
    }
    return parsed.toISOString();
  }

  return {
    scopes,
    recordTypes,
    currentVersionCreatedAfter: validateTimestamp("currentVersionCreatedAfter", filters?.currentVersionCreatedAfter),
    currentVersionCreatedBefore: validateTimestamp("currentVersionCreatedBefore", filters?.currentVersionCreatedBefore),
  };
}

interface FilterClauseResult {
  clauses: string[];
  params: unknown[];
}

/** Shared by both the FTS and vector candidate queries (§15) -- the same eligibility constraints apply identically to both, generated from one place so they cannot silently drift apart. */
function buildFilterClauses(filters: NormalizedFilters, paramOffset: number): FilterClauseResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let index = paramOffset;

  if (filters.scopes) {
    index += 1;
    clauses.push(`mr.scope = ANY($${index}::text[])`);
    params.push(filters.scopes);
  }
  if (filters.recordTypes) {
    index += 1;
    clauses.push(`mr.record_type = ANY($${index}::text[])`);
    params.push(filters.recordTypes);
  }
  if (filters.currentVersionCreatedAfter) {
    index += 1;
    clauses.push(`mrv.created_at >= $${index}`);
    params.push(filters.currentVersionCreatedAfter);
  }
  if (filters.currentVersionCreatedBefore) {
    index += 1;
    clauses.push(`mrv.created_at < $${index}`);
    params.push(filters.currentVersionCreatedBefore);
  }

  return { clauses, params };
}

interface CandidateRow {
  memory_record_id: string;
  source_candidate_id: string | null;
  record_type: string | null;
  scope: string | null;
  memory_record_version_id: string;
  version_number: number;
  content: string;
  version_created_at: string | Date;
  /** Only ever present on an FTS-sourced row (queryVectorCandidates never selects it) -- absent, not null, on a vector-only row. */
  matched_snippet?: string;
}

interface FtsCandidateRow extends CandidateRow {
  fts_score: number;
  matched_snippet: string;
}

interface VectorCandidateRow extends CandidateRow {
  vector_distance: number;
}

/**
 * §16: FTS ranking over current-version content only. The
 * `mr.current_version_id`/`mrv.id` join is the eligibility gate that keeps
 * a historical superseded version from ever being returned, regardless of
 * whether its own content happens to match the query.
 */
async function queryFtsCandidates(
  tenantId: string,
  queryText: string,
  candidateLimit: number,
  filters: NormalizedFilters,
): Promise<FtsCandidateRow[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const { clauses, params: filterParams } = buildFilterClauses(filters, 2);
    const filterSql = clauses.map((clause) => `AND ${clause}`).join("\n         ");

    const params: unknown[] = [tenantId, queryText, ...filterParams];
    const limitIndex = params.length + 1;
    params.push(candidateLimit);

    const result = await client.query(
      `SELECT
          mr.id AS memory_record_id,
          mr.source_candidate_id,
          mr.record_type,
          mr.scope,
          mrv.id AS memory_record_version_id,
          mrv.version_number,
          mrv.content,
          mrv.created_at AS version_created_at,
          ts_rank_cd(to_tsvector('english', mrv.content), plainto_tsquery('english', $2)) AS fts_score,
          ts_headline('english', mrv.content, plainto_tsquery('english', $2)) AS matched_snippet
       FROM memory_records mr
       JOIN memory_record_versions mrv
         ON mrv.id = mr.current_version_id
        AND mrv.memory_record_id = mr.id
        AND mrv.tenant_id = mr.tenant_id
       WHERE mr.tenant_id = $1
         AND mr.deleted_at IS NULL
         AND mr.current_version_id IS NOT NULL
         AND mrv.is_deletion_marker = false
         AND to_tsvector('english', mrv.content) @@ plainto_tsquery('english', $2)
         ${filterSql}
       ORDER BY fts_score DESC, mrv.created_at DESC, mr.id ASC
       LIMIT $${limitIndex}`,
      params,
    );
    return result.rows as FtsCandidateRow[];
  });
}

/**
 * §17: vector ranking over current-version embeddings only. Every
 * eligibility predicate (status, model provider/name/version, dimensions,
 * source-hash freshness) is in the WHERE clause, evaluated before ORDER BY
 * ever touches the `<=>` operator -- a dimension or model mismatch is
 * filtered out before comparison is attempted, never left to produce a
 * runtime operator error (§17.1). source_content_hash freshness is checked
 * with pgcrypto's digest() (already enabled, migrations/0001) so a stale
 * embedding computed from superseded content can never participate, even
 * if some other bug left its status ACTIVE.
 */
async function queryVectorCandidates(
  tenantId: string,
  queryVector: number[],
  queryDimensions: number,
  modelProvider: string,
  modelName: string,
  modelVersion: string,
  candidateLimit: number,
  filters: NormalizedFilters,
): Promise<VectorCandidateRow[]> {
  return withTenantTransaction(tenantId, async (client) => {
    const serializedQueryVector = serializeVector(queryVector);
    const { clauses, params: filterParams } = buildFilterClauses(filters, 6);
    const filterSql = clauses.map((clause) => `AND ${clause}`).join("\n         ");

    const params: unknown[] = [
      tenantId,
      serializedQueryVector,
      modelProvider,
      modelName,
      modelVersion,
      queryDimensions,
      ...filterParams,
    ];
    const limitIndex = params.length + 1;
    params.push(candidateLimit);

    const result = await client.query(
      `SELECT
          mr.id AS memory_record_id,
          mr.source_candidate_id,
          mr.record_type,
          mr.scope,
          mrv.id AS memory_record_version_id,
          mrv.version_number,
          mrv.content,
          mrv.created_at AS version_created_at,
          me.embedding <=> $2::vector AS vector_distance
       FROM memory_records mr
       JOIN memory_record_versions mrv
         ON mrv.id = mr.current_version_id
        AND mrv.memory_record_id = mr.id
        AND mrv.tenant_id = mr.tenant_id
       JOIN memory_embeddings me
         ON me.memory_record_version_id = mrv.id
        AND me.tenant_id = mrv.tenant_id
       WHERE mr.tenant_id = $1
         AND mr.deleted_at IS NULL
         AND mr.current_version_id IS NOT NULL
         AND mrv.is_deletion_marker = false
         AND me.status = 'ACTIVE'
         AND me.model_provider = $3
         AND me.model_name = $4
         AND me.model_version = $5
         AND me.dimensions = $6
         AND me.source_content_hash = encode(digest(mrv.content, 'sha256'), 'hex')
         ${filterSql}
       ORDER BY vector_distance ASC, mrv.created_at DESC, mr.id ASC
       LIMIT $${limitIndex}`,
      params,
    );
    return result.rows as VectorCandidateRow[];
  });
}

/**
 * PR 6 §14: query text -> PostgreSQL FTS + OpenAI query embedding +
 * pgvector cosine ranking + RRF -> ranked current memory versions with
 * stable citations. The deterministic path (retrieveRelevantMemory.ts)
 * remains independently callable and is not refactored into this function
 * -- this is a genuinely separate service, selected by
 * retrievalStrategy.ts's feature flag.
 */
export async function retrieveHybridMemory(
  input: RetrieveHybridMemoryInput,
  dependencies: RetrieveHybridMemoryDependencies,
): Promise<HybridMemoryRetrievalResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) {
    throw new Error(`retrieveHybridMemory: limit must be > 0, got ${limit}`);
  }
  const candidateLimit = input.candidateLimit ?? Math.max(DEFAULT_MIN_CANDIDATE_LIMIT, limit * CANDIDATE_LIMIT_MULTIPLIER);
  if (candidateLimit < limit) {
    throw new Error(`retrieveHybridMemory: candidateLimit (${candidateLimit}) must be >= limit (${limit})`);
  }
  if (candidateLimit > MAX_CANDIDATE_LIMIT) {
    throw new Error(`retrieveHybridMemory: candidateLimit (${candidateLimit}) exceeds the maximum of ${MAX_CANDIDATE_LIMIT}`);
  }

  const filters = normalizeFilters(input.filters);
  const provider = dependencies.embeddingProvider;

  // §14.3: ephemeral -- never persisted to memory_embeddings. The
  // corresponding model_invocations row (queryModelInvocationId below) is
  // this call's durable evidence.
  const embeddingResult = await runEmbedding(
    { text: input.queryText, purpose: "query", dimensions: provider.dimensions },
    {
      tenantId: input.tenantId,
      cognitiveRunId: null,
      provider,
      invocationKey: input.invocationKey,
      attemptNumber: input.attemptNumber,
    },
  );

  const ftsCandidates = await queryFtsCandidates(input.tenantId, input.queryText, candidateLimit, filters);

  let vectorCandidates: VectorCandidateRow[] = [];
  let vectorStatus: VectorRetrievalStatus = "AVAILABLE";

  if (embeddingResult.ok) {
    vectorCandidates = await queryVectorCandidates(
      input.tenantId,
      embeddingResult.value.embedding,
      provider.dimensions,
      provider.providerId,
      provider.modelId,
      embeddingResult.value.model,
      candidateLimit,
      filters,
    );
  } else {
    // §14.4: degrade to FTS-only. No raw error reaches the caller; FTS
    // already ran above regardless of this branch.
    vectorStatus = mapEmbeddingErrorToVectorStatus(embeddingResult.error.kind);
  }

  // Both queries return the same "current version" row shape for a given
  // record (same join path), so metadata is identical regardless of which
  // query it came from -- FTS is consulted first purely as an arbitrary,
  // stable precedence when both happen to have found the same record.
  const rowsById = new Map<string, CandidateRow>();
  for (const row of ftsCandidates) rowsById.set(row.memory_record_id, row);
  for (const row of vectorCandidates) if (!rowsById.has(row.memory_record_id)) rowsById.set(row.memory_record_id, row);

  const vectorDistanceById = new Map<string, number>();
  for (const row of vectorCandidates) vectorDistanceById.set(row.memory_record_id, row.vector_distance);

  const fused = fuseRankings(
    ftsCandidates.map((row) => row.memory_record_id),
    vectorCandidates.map((row) => row.memory_record_id),
  );

  function domainMatches(row: CandidateRow): boolean {
    return Boolean(input.requestingPersonaDomain) && row.scope === input.requestingPersonaDomain;
  }

  // §18 final ordering: rrfScore DESC, domain match DESC (tie-break only,
  // never folded into rrfScore itself), current-version timestamp DESC,
  // memory-record id ASC.
  const ranked = fused
    .map((entry) => ({ entry, row: rowsById.get(entry.id)! }))
    .sort((a, b) => {
      if (b.entry.rrfScore !== a.entry.rrfScore) return b.entry.rrfScore - a.entry.rrfScore;
      const domainDelta = (domainMatches(b.row) ? 1 : 0) - (domainMatches(a.row) ? 1 : 0);
      if (domainDelta !== 0) return domainDelta;
      const timeDelta = new Date(b.row.version_created_at).getTime() - new Date(a.row.version_created_at).getTime();
      if (timeDelta !== 0) return timeDelta;
      return a.row.memory_record_id < b.row.memory_record_id ? -1 : a.row.memory_record_id > b.row.memory_record_id ? 1 : 0;
    })
    .slice(0, limit);

  const records: HybridRetrievedMemoryRecord[] = ranked.map(({ entry, row }) => ({
    id: row.memory_record_id,
    content: row.content,
    recordType: row.record_type,
    scope: row.scope,
    memoryRecordVersionId: row.memory_record_version_id,
    versionNumber: row.version_number,
    versionCreatedAt: toIso(row.version_created_at),
    citation: {
      kind: "memory_record_version",
      memoryRecordId: row.memory_record_id,
      memoryRecordVersionId: row.memory_record_version_id,
      versionNumber: row.version_number,
      sourceCandidateId: row.source_candidate_id,
    },
    retrieval: {
      sources: entry.sources,
      ftsRank: entry.ftsRank,
      vectorRank: entry.vectorRank,
      rrfScore: entry.rrfScore,
      matchedSnippet: row.matched_snippet ?? null,
      vectorDistance: vectorDistanceById.get(row.memory_record_id) ?? null,
    },
  }));

  return {
    records,
    queryModelInvocationId: embeddingResult.invocationId ?? null,
    vectorStatus,
    ftsCandidateCount: ftsCandidates.length,
    vectorCandidateCount: vectorCandidates.length,
  };
}
