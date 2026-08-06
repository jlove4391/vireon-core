-- Vireon CORE — Cognitive Plane PR 6: Hybrid Memory Retrieval — Embedding Operation Kind
-- Widens model_invocations.operation_kind to accept 'embedding', the seventh concrete
-- operation anticipated by migrations/0014's own doctrine. Also performs a bounded,
-- idempotent reconciliation of legacy memory_records rows whose current_version_id
-- (migrations/0016) was never populated.
--
-- Confirmed directly (not assumed) before writing this: several of this codebase's own
-- test fixtures insert memory_records rows via direct SQL, bypassing
-- promoteMemoryCandidate.ts entirely, and never set current_version_id --
-- tests/integration/phase3.elora-ingestion.test.ts, phase6g.memory-review.test.ts,
-- phase6h.domain-weighted-retrieval.test.ts, and pr4.cognitive-coordinator.test.ts all do
-- this. Whether any such row actually existed in this database at the moment this
-- migration ran (as opposed to being created afterward, by tests that run once migrations
-- have already completed) is reported explicitly in the PR 6 implementation report -- this
-- comment states that the gap is real and reachable, not that a specific row was caught by
-- it here.
--
-- RLS correctness note (load-bearing, not incidental): migrate() runs as the `vireon`
-- role -- a genuine non-superuser (docker/init/01-bootstrap-app-role.sql) -- against tables
-- with FORCE ROW LEVEL SECURITY (memory_records / memory_record_versions, both since
-- migrations/0001 and /0016). FORCE means even the table owner is subject to the tenant
-- policy. migrate() never sets vireon.current_tenant_id. A reconciliation query written as
-- plain cross-tenant DML would therefore see zero rows and silently do nothing, regardless
-- of how much real data needed fixing -- not a hypothetical risk, the exact mechanism
-- pr1/pr2/pr5's own RLS-enforcement tests already prove empirically (an unset tenant
-- context sees zero rows against a real table). The DO block below explicitly loops over
-- every tenant and sets vireon.current_tenant_id per iteration -- the same mechanism
-- withTenantTransaction() uses at the application layer -- specifically so this
-- reconciliation actually reaches every tenant's data instead of appearing to run while
-- doing nothing. `tenants` itself carries no RLS policy (migrations/0001), so it's safe to
-- enumerate without a tenant context already set.

-- =========================================================================
-- 1. Widen operation_kind to accept the seventh operation: embedding.
-- =========================================================================
ALTER TABLE model_invocations
    DROP CONSTRAINT chk_model_invocations_operation_kind;

ALTER TABLE model_invocations
    ADD CONSTRAINT chk_model_invocations_operation_kind
    CHECK (
        operation_kind IN (
            'response_synthesis',
            'intent_interpretation',
            'planning',
            'critique',
            'extraction',
            'reranking',
            'embedding'
        )
    );

-- =========================================================================
-- 2. Legacy current_version_id reconciliation.
--
-- Bounded and idempotent: every branch is gated by
-- `current_version_id IS NULL`, so a record already reconciled -- by an
-- earlier run of this exact block, or by promoteMemoryCandidate.ts's own
-- correct write path -- is never touched twice and never gains a duplicate
-- version row. Safe to re-execute verbatim (proven directly in
-- tests/integration/pr6.hybrid-retrieval.test.ts by running this same
-- reconciliation SQL twice against freshly-seeded legacy rows).
-- =========================================================================
-- PR6_RECONCILIATION_BEGIN
DO $$
DECLARE
    tenant_row RECORD;
BEGIN
    FOR tenant_row IN SELECT id FROM tenants LOOP
        PERFORM set_config('vireon.current_tenant_id', tenant_row.id::text, true);

        -- 2a. Records that already have version rows but no pointer: point
        -- at the highest version_number that exists for each.
        UPDATE memory_records mr
        SET current_version_id = latest.id
        FROM (
            SELECT DISTINCT ON (memory_record_id)
                id, memory_record_id
            FROM memory_record_versions
            WHERE tenant_id = tenant_row.id
            ORDER BY memory_record_id, version_number DESC
        ) AS latest
        WHERE mr.id = latest.memory_record_id
          AND mr.tenant_id = tenant_row.id
          AND mr.current_version_id IS NULL;

        -- 2b. Records with no version rows at all: create version 1 from
        -- the record's own denormalized content, then point at it.
        WITH legacy AS (
            SELECT id, content, deleted_at
            FROM memory_records
            WHERE tenant_id = tenant_row.id
              AND current_version_id IS NULL
        ),
        inserted AS (
            INSERT INTO memory_record_versions
                (id, tenant_id, memory_record_id, version_number, content, change_reason, is_deletion_marker, created_at)
            SELECT
                gen_random_uuid(),
                tenant_row.id,
                legacy.id,
                1,
                legacy.content,
                'PR 6 legacy-version reconciliation.',
                (legacy.deleted_at IS NOT NULL),
                now()
            FROM legacy
            RETURNING id AS version_id, memory_record_id
        )
        UPDATE memory_records mr
        SET current_version_id = inserted.version_id
        FROM inserted
        WHERE mr.id = inserted.memory_record_id
          AND mr.tenant_id = tenant_row.id;
    END LOOP;

    -- Never leave a leftover tenant scope active for whatever runs next in
    -- this migration transaction.
    PERFORM set_config('vireon.current_tenant_id', '', true);
END $$;
-- PR6_RECONCILIATION_END

-- current_version_id is deliberately NOT made NOT NULL here.
-- promoteMemoryCandidate.ts's current implementation bootstraps the parent
-- row with a temporary NULL pointer before inserting version 1 inside the
-- same transaction (see that file's own doc comment on insertion order) --
-- a NOT NULL constraint would break that transaction's first statement.
-- migrations/0016 is not rewritten by this migration.
