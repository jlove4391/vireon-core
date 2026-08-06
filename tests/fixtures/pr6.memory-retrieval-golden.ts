/**
 * PR 6 §24: a small, curated retrieval evaluation dataset. Pure data only --
 * no database calls live here (tests/integration/pr6.hybrid-retrieval.test.ts
 * owns seeding, since that requires live promoteMemoryCandidate/
 * supersedeMemoryRecord/deleteMemoryRecord/embedMemoryRecordVersion calls
 * and a real tenant context this module doesn't have).
 *
 * Every content pair below was verified directly against a real PostgreSQL
 * `to_tsvector('english', ...) @@ plainto_tsquery('english', ...)` check and
 * the real computeFeatureHashEmbedding() cosine similarity before being
 * committed here -- not assumed to behave a certain way. In particular:
 * `plainto_tsquery` combines every content-bearing stem with AND, so a
 * document must contain *all* of a query's stems to match via FTS at all;
 * several fixtures below are deliberately missing exactly one query stem so
 * they participate in vector ranking only, never FTS.
 *
 * Relevance judgments (`relevantKeys`) are hand-authored here, independent
 * of retrieveHybridMemory.ts's own ranking logic -- never derived by running
 * the algorithm under test and calling whatever it returns "relevant."
 */

export interface GoldenMemoryRecordFixture {
  key: string;
  content: string;
  scope?: string;
  recordType?: string;
  /** Skip embedMemoryRecordVersion for this record -- the FTS-only-participation case (§11.3: a version without an embedding remains eligible for FTS). */
  skipEmbedding?: boolean;
  /** After promotion (and embedding, unless skipped), supersede with this new, unrelated content -- the historical-superseded-version case: the OLD content must never leak into retrieval once superseded. */
  supersedeWithContent?: string;
  /** After promotion (and embedding/supersession), delete this record -- the deleted-distractor case. */
  deleteAfterSeeding?: boolean;
  /** Backdate/forward-date the current version's created_at to this ISO string -- the temporal-filter case. */
  versionCreatedAtOverride?: string;
}

export interface GoldenMemoryQueryFixture {
  key: string;
  query: string;
  relevantMemoryRecordKeys: string[];
  filters?: {
    scopes?: string[];
    recordTypes?: string[];
    currentVersionCreatedAfter?: string;
    currentVersionCreatedBefore?: string;
  };
}

export const GOLDEN_MEMORY_RECORDS: GoldenMemoryRecordFixture[] = [
  // -- Acme renewal cluster: exact match, related match, vector-only,
  // FTS-only, and one record relevant to a second query too. --
  {
    key: "acme-exact",
    content: "The vendor renewal timeline for Acme Corp is scheduled for review each spring.",
    scope: "vendor",
    recordType: "contract",
  },
  {
    key: "acme-related",
    content:
      "Acme Corp's vendor contract is up for renewal, and the timeline for that renewal review is set each spring.",
    scope: "vendor",
    recordType: "contract",
  },
  {
    // Verified: does NOT satisfy FTS's AND-match for the acme-renewal query
    // (missing the "renewal"/"timeline" stems entirely) but shares enough
    // raw vocabulary ("Acme", "Corp", "vendor") for real, verified cosine
    // similarity (~0.50) via the deterministic fake embedding.
    key: "acme-vector-only",
    content: "Acme Corp is a vendor we've worked with for the office supply contract since 2019.",
    scope: "vendor",
    recordType: "contract",
  },
  {
    // Never embedded -- structurally cannot appear in vector candidates
    // (the vector query INNER JOINs to memory_embeddings), while still
    // fully eligible for FTS.
    key: "acme-fts-only",
    content: "The Acme Corp vendor renewal timeline was finalized last week after a long review.",
    scope: "vendor",
    recordType: "contract",
    skipEmbedding: true,
  },
  {
    key: "acme-relocation-multi",
    content:
      "Acme Corp's vendor renewal timeline and their office relocation plans were both discussed in the Q2 vendor review meeting.",
    scope: "vendor",
    recordType: "note",
  },

  // -- Office relocation query's own dedicated record. --
  {
    key: "office-relocation",
    content: "The office relocation plans for next quarter include moving to a larger downtown location.",
    scope: "facilities",
    recordType: "note",
  },

  // -- Clearly irrelevant distractors. --
  {
    key: "distractor-bananas",
    content: "Bananas are a good source of potassium and fiber, according to the nutrition guide.",
    scope: "general",
  },
  {
    key: "distractor-budget",
    content: "The quarterly budget review is scheduled for next Tuesday afternoon in the main conference room.",
    scope: "finance",
  },

  // -- One deleted distractor: matches the acme-renewal query via FTS, but
  // is deleted after seeding and must never be retrieved. --
  {
    key: "acme-deleted",
    content: "The Acme Corp vendor renewal timeline is being renegotiated due to budget cuts this quarter.",
    scope: "vendor",
    recordType: "contract",
    deleteAfterSeeding: true,
  },

  // -- One historical superseded version: the ORIGINAL content matches the
  // acme-renewal query strongly; the record is then superseded with
  // genuinely unrelated content. Only the CURRENT (unrelated) content may
  // ever be searchable -- the historical match must not leak through. --
  {
    key: "acme-historical",
    content: "Acme Corp vendor renewal timeline was completed early this year, well ahead of schedule.",
    supersedeWithContent: "The office recycling program was updated to include glass and plastic bins.",
    scope: "vendor",
    recordType: "contract",
  },

  // -- Scope / record-type filter fixtures: both records match the same
  // query without a filter; the filter must exclude exactly one. --
  {
    key: "scope-engineering",
    content: "The database migration decision was finalized by the engineering team this week.",
    scope: "engineering",
    recordType: "decision",
  },
  {
    key: "scope-sales",
    content: "The sales team's database migration timeline was communicated to the client this week.",
    scope: "sales",
    recordType: "note",
  },

  // -- Temporal filter fixtures: three versions of "the same kind of fact,"
  // deliberately time-shifted outside/inside a target window. --
  {
    key: "temporal-old",
    content: "The annual conference schedule was updated for attendees.",
    versionCreatedAtOverride: "2020-01-15T00:00:00.000Z",
  },
  {
    key: "temporal-current",
    content: "The annual conference schedule was updated for this year's attendees.",
    versionCreatedAtOverride: "2026-06-01T00:00:00.000Z",
  },
  {
    key: "temporal-future",
    content: "The annual conference schedule update was announced for future attendees.",
    versionCreatedAtOverride: "2030-01-15T00:00:00.000Z",
  },
];

export const GOLDEN_MEMORY_QUERIES: GoldenMemoryQueryFixture[] = [
  {
    key: "acme-renewal",
    query: "What is the vendor renewal timeline for Acme Corp?",
    relevantMemoryRecordKeys: ["acme-exact", "acme-related", "acme-vector-only", "acme-fts-only", "acme-relocation-multi"],
  },
  {
    key: "office-relocation",
    query: "What are the office relocation plans?",
    relevantMemoryRecordKeys: ["office-relocation", "acme-relocation-multi"],
  },
  {
    key: "scope-filter",
    query: "database migration",
    filters: { scopes: ["engineering"] },
    relevantMemoryRecordKeys: ["scope-engineering"],
  },
  {
    key: "recordtype-filter",
    query: "database migration",
    filters: { recordTypes: ["decision"] },
    relevantMemoryRecordKeys: ["scope-engineering"],
  },
  {
    key: "temporal-filter",
    query: "annual conference schedule",
    filters: {
      currentVersionCreatedAfter: "2025-01-01T00:00:00.000Z",
      currentVersionCreatedBefore: "2027-01-01T00:00:00.000Z",
    },
    relevantMemoryRecordKeys: ["temporal-current"],
  },
];
