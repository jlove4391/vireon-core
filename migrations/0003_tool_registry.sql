-- Vireon CORE Phase 5: tool registry v1 -- bounded local artifact creation.
-- Constrains tool_invocations.status (new vocabulary -- confirmed via
-- repo-wide grep during Phase 5 planning that nothing has ever written to
-- this table) and extends artifacts with the columns/idempotency needed for
-- truthful invocation evidence. Both tables confirmed empty (0 rows) in the
-- live persistent Docker volume during planning, so no data normalization
-- is required before adding either constraint (unlike 0002's work_orders
-- normalization, which was needed because that table already had rows).

-- =========================================================================
-- tool_invocations: status vocabulary. Matches the naming style of
-- runs.status (migration 0002) -- pending / succeeded / failed. No
-- EXECUTING/VALIDATING granularity at the invocation level; that
-- distinction already lives on the parent WorkOrder's own status.
-- =========================================================================
ALTER TABLE tool_invocations ADD CONSTRAINT chk_tool_invocations_status CHECK (
    status IN ('pending', 'succeeded', 'failed')
);

-- =========================================================================
-- artifacts: add the columns needed for truthful artifact evidence, plus
-- idempotency. No unique constraint of any kind existed on this table
-- before this migration.
-- =========================================================================
ALTER TABLE artifacts ADD COLUMN mime_type text;
ALTER TABLE artifacts ADD COLUMN byte_count integer;
ALTER TABLE artifacts ADD COLUMN content_hash text;
ALTER TABLE artifacts ADD COLUMN idempotency_key text;

-- Table confirmed empty during planning -- safe to set NOT NULL directly,
-- no backfill required.
ALTER TABLE artifacts ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE artifacts ADD CONSTRAINT uq_artifacts_tenant_idempotency UNIQUE (tenant_id, idempotency_key);
