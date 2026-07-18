-- Vireon CORE Phase 6G: memory review and promotion. Since Phase 3, ELORA
-- has been able to propose memory candidates, but nothing has ever let a
-- human review them or turn an approved one into a real, durable
-- memory_records row this system will actually retrieve. This migration
-- adds the schema this phase's review/promotion service layer needs.
--
-- Domain-weighted retrieval (using `scope` to bias retrieveRelevantMemory.ts
-- toward a persona's own domain) is explicitly out of scope here -- that's
-- 6H. This migration only reconciles the existing placeholder scope value
-- and adds reviewer-accountability columns.

-- =========================================================================
-- Data reconciliation: "project" was never a real domain value -- confirmed
-- during planning to be a leftover hardcoded placeholder written by every
-- existing call site, not a meaningful label. Relabeling to "general" is
-- the honest resolution: it does not pretend to reverse-engineer what
-- domain those rows were "really" about. Same RLS-disable/re-enable
-- pattern migration 0002 used for its own work_orders data-normalizing
-- UPDATE -- the migration role has no tenant context set, and both tables
-- carry FORCE ROW LEVEL SECURITY, so a normal UPDATE would be silently
-- filtered to zero rows rather than actually fixing the pre-existing data.
-- =========================================================================
ALTER TABLE memory_candidates DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records DISABLE ROW LEVEL SECURITY;

UPDATE memory_candidates SET scope = 'general' WHERE scope = 'project';
UPDATE memory_records SET scope = 'general' WHERE scope = 'project';

ALTER TABLE memory_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- Reviewer accountability columns. Composite tenant-safe FK, same pattern
-- established in 6B/6D -- a plain `uuid REFERENCES actors(id)` would not
-- prove the reviewer belongs to the same tenant. All three stay nullable --
-- only populated once a candidate is actually reviewed. No new columns
-- needed for promotion itself: promoted_memory_record_id already exists
-- (migration 0001) with its own FK to memory_records.
-- =========================================================================
ALTER TABLE memory_candidates ADD COLUMN reviewed_by_actor_id uuid;
ALTER TABLE memory_candidates ADD COLUMN reviewed_at timestamptz;
ALTER TABLE memory_candidates ADD COLUMN review_note text;

ALTER TABLE memory_candidates ADD CONSTRAINT uq_memory_candidates_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE memory_candidates ADD CONSTRAINT fk_memory_candidates_reviewed_by
    FOREIGN KEY (tenant_id, reviewed_by_actor_id) REFERENCES actors (tenant_id, id);
