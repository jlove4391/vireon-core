-- Vireon CORE — Cognitive Plane PR 5: Memory Schema and Versioning
-- Governing document: "Deep Technical Research Report: Building Elora as a Real-World
-- Raphael" (canon), Section 20 PR 5. Extends memory_records (migrations/0001) rather than
-- replacing it -- that table already exists, is already the real promotion target for
-- promoteMemoryCandidate.ts, and already carries real rows. Its bare `embedding vector`
-- column has never once been populated by any code path (confirmed directly, not assumed)
-- and is dropped here in favor of a proper versioned lifecycle table, since there is no
-- data to migrate.

-- =========================================================================
-- memory_records: drop the never-populated legacy embedding column, add the
-- denormalized current-version pointer (fast-path read, no join needed for
-- the common "read current content" case -- same posture as
-- operator_directives.state staying denormalized while full history lives
-- in operator_directive_revisions) and a real deletion timestamp.
--
-- current_version_id has no FK yet at this point in the script --
-- memory_record_versions doesn't exist until the CREATE TABLE below.
-- Resolved via a second ALTER after that table exists, the same
-- forward-reference pattern migrations/0001 already used for
-- memory_candidates.promoted_memory_record_id -> memory_records.
-- =========================================================================
ALTER TABLE memory_records DROP COLUMN embedding;
ALTER TABLE memory_records ADD COLUMN current_version_id uuid;
ALTER TABLE memory_records ADD COLUMN deleted_at timestamptz;

-- =========================================================================
-- memory_record_versions: the companion table, same "identity row + versions/
-- transitions companion table" pattern already proven by
-- work_order_state_transitions (0002), operator_directive_revisions (0011),
-- and cognitive_run_transitions (0013). Supersession creates a new version
-- under the same memory_record_id -- a remembered fact gets corrected over
-- time, it isn't replaced by an unrelated new record (the directive-revision
-- pattern, not the receipt-supersession pattern).
--
-- Deletion is recorded as a final version row here too
-- (is_deletion_marker = true) whose own `content` is also cleared to the
-- tombstone marker -- the fact that a deletion happened, and when, stays
-- durable and queryable without the deleted content being recoverable from
-- history. No idempotency key -- same posture as every other
-- transition/revision table in this codebase: a version is a recorded fact,
-- not itself a side-effecting retry target.
-- =========================================================================
CREATE TABLE memory_record_versions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),
    memory_record_id   uuid NOT NULL REFERENCES memory_records(id),
    version_number     integer NOT NULL CHECK (version_number > 0),
    content            text NOT NULL,
    change_reason      text NOT NULL,
    is_deletion_marker boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_memory_record_versions_number
        UNIQUE (tenant_id, memory_record_id, version_number)
);

CREATE INDEX idx_memory_record_versions_tenant_id ON memory_record_versions (tenant_id);
CREATE INDEX idx_memory_record_versions_record_id ON memory_record_versions (memory_record_id);

-- Resolve memory_records.current_version_id's forward reference now that
-- memory_record_versions exists.
ALTER TABLE memory_records
    ADD CONSTRAINT fk_memory_records_current_version
    FOREIGN KEY (current_version_id) REFERENCES memory_record_versions(id);

-- =========================================================================
-- memory_embeddings: an embedding has its own independent lifecycle from the
-- content it's derived from -- the same content can be re-embedded under a
-- newer model without the memory content itself changing, so this is a
-- separate table, not a bare vector column. References a specific
-- *version's* content (not memory_records directly): if that content is
-- later superseded, an old embedding shouldn't silently appear to describe
-- content that no longer represents the record's current state.
--
-- Schema and lifecycle only in this PR -- no embedding-generation API is
-- called here (same "mechanism and schema first, zero live callers yet"
-- pattern PR 1's cognitive_runs and PR 2's six structured operations both
-- used). Never overwritten in place: a re-embed marks the old row
-- SUPERSEDED via superseded_by_embedding_id and inserts a new row, mirroring
-- migrations/0014's own model_invocations append-only evidence doctrine.
-- =========================================================================
CREATE TABLE memory_embeddings (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id),
    memory_record_version_id   uuid NOT NULL REFERENCES memory_record_versions(id),

    embedding                  vector NOT NULL,
    model_provider             text NOT NULL,
    model_name                 text NOT NULL,
    model_version              text NOT NULL,
    dimensions                 integer NOT NULL CHECK (dimensions > 0),
    source_content_hash        text NOT NULL,

    status                     text NOT NULL DEFAULT 'ACTIVE'
        CONSTRAINT chk_memory_embeddings_status
        CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
    superseded_by_embedding_id uuid REFERENCES memory_embeddings(id),

    created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_embeddings_tenant_id ON memory_embeddings (tenant_id);
CREATE INDEX idx_memory_embeddings_version_id ON memory_embeddings (memory_record_version_id);

-- Efficiently finds the active embedding(s) for a given version -- the
-- operational query this table's whole versioning scheme exists to make
-- answerable, mirroring migrations/0014's idx_model_invocations_incomplete
-- partial-index reasoning.
CREATE INDEX idx_memory_embeddings_active
    ON memory_embeddings (memory_record_version_id)
    WHERE status = 'ACTIVE';

-- =========================================================================
-- Row-Level Security -- mandatory on every tenant-scoped table, same
-- ENABLE + FORCE + USING/WITH CHECK form as every migration since 0002.
-- memory_records already has RLS from migration 0001; adding columns to an
-- existing RLS-protected table doesn't require re-declaring its policy.
-- Tested against the non-superuser vireon role, never as superuser.
-- =========================================================================
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'memory_record_versions', 'memory_embeddings'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''vireon.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''vireon.current_tenant_id'', true), '''')::uuid)',
            tbl
        );
    END LOOP;
END $$;
