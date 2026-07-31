-- Vireon CORE Phase 6L: Briefing Issue and Carry-Forward Engine.
--
-- Creates historical briefing issues from persisted Directives (6K) and
-- existing CORE state (WorkOrders, ActionReceipts, MemoryCandidates,
-- scheduled-trigger-failure receipts). Adds two tables and no execution-
-- authority hooks -- issued_by_actor_id is an audit/attribution column
-- only, never consulted by any resolution/dispatch path (confirmed
-- directly against the service code in this same phase, not just
-- asserted here) -- same posture as 6K's issuing_actor_id/owning_actor_id
-- and 6I's owningActorId/createdByActorId.
--
-- Fork resolution (Phase B go-ahead, mirrors 6K's Option B): every
-- reference column below is a plain single-column FK, tenant safety
-- enforced at the application layer via assertTenantScopedReference()
-- (src/db/) for the one caller-suppliable column (issued_by_actor_id),
-- and by construction (derived from an already tenant-scoped read in the
-- same transaction) for every other reference column -- see the Phase A
-- memo / Phase B go-ahead for the column-by-column verification.
--
-- The transcribed schema for briefing_issue_entries names only
-- directive_id/directive_revision_id as reference columns, but the
-- spec's own candidate-collector list includes WorkOrders, ActionReceipts,
-- and MemoryCandidates as first-class candidate sources -- none of which
-- are Directives. Rather than force every non-Directive candidate through
-- 6K's Directive pipeline (which the spec does not ask for and 6K's own
-- non-goals for this phase forbid -- "no changes to 6K's Directive
-- services beyond reading from them"), this migration extends the entry
-- schema with three more nullable typed reference columns
-- (work_order_id, action_receipt_id, memory_candidate_id), mirroring the
-- exact multi-typed-reference pattern operator_directive_provenance
-- already established in 0011 (a CHECK enforcing exactly one source
-- form). This is flagged here as a schema addition beyond the literal
-- transcription, not silently done.

-- =========================================================================
-- briefing_issues: canonical issue row. One durable identity per
-- (tenant_id, briefing_type, local_issue_date, timezone) -- acceptance
-- criterion 1. idempotency_key is derived from exactly those three
-- fields (see src/briefing/issueBriefing.ts), the same
-- UNIQUE(tenant_id, idempotency_key) + ON CONFLICT DO NOTHING pattern
-- already used by work_orders/runs/scheduled_triggers, proposed in the
-- Phase A memo and confirmed in the Phase B go-ahead.
--
-- status vocabulary is the spec's own (ASSEMBLING, ISSUED, UPDATED,
-- CLOSED, FAILED); this phase's issueBriefing() service only ever
-- produces ISSUED as a durably-observed end state (the whole assembly
-- runs as one atomic transaction, so a crash mid-assembly leaves zero
-- row for that idempotency key rather than a stale ASSEMBLING row, and a
-- restart's insert-or-fetch simply reassembles from scratch -- see
-- issueBriefing.ts's own doc comment). UPDATED/CLOSED/FAILED as durably
-- reachable states are schema-complete but service-incomplete: flagged
-- explicitly, not built, since nothing in this phase's 10 acceptance
-- criteria requires re-issuance-during-the-day or explicit closing, and
-- inventing that machinery ahead of an actual caller (6M/6N) would be
-- exactly the speculative-infrastructure this phase's own non-goals warn
-- against.
-- =========================================================================
CREATE TABLE briefing_issues (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id),

    briefing_type            text NOT NULL,
    local_issue_date         date NOT NULL,
    timezone                 text NOT NULL,

    status                   text NOT NULL DEFAULT 'ASSEMBLING' CHECK (
        status IN ('ASSEMBLING', 'ISSUED', 'UPDATED', 'CLOSED', 'FAILED')
    ),

    issued_by_actor_id       uuid NOT NULL REFERENCES actors(id),
    source_message_id        uuid REFERENCES messages(id),
    source_work_order_id     uuid REFERENCES work_orders(id),
    first_move_directive_id  uuid REFERENCES operator_directives(id),
    prose_artifact_id        uuid REFERENCES artifacts(id),

    idempotency_key          text NOT NULL,

    generated_at             timestamptz,
    published_at             timestamptz,
    closed_at                timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_briefing_issues_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_briefing_issues_tenant_id ON briefing_issues (tenant_id);
CREATE INDEX idx_briefing_issues_tenant_type_date ON briefing_issues (tenant_id, briefing_type, local_issue_date);

-- =========================================================================
-- briefing_issue_entries: one row per candidate included in a given
-- issue. Deliberately immutable once created (acceptance criterion 4) --
-- the four *_snapshot columns freeze what was true about the underlying
-- record at issuance time; nothing in this domain ever UPDATEs them.
-- entry_status exists for the same reason operator_directives' state
-- machine exists on the parent but not the child rows: an issue that
-- later moves ASSEMBLING/ISSUED -> UPDATED can flip an entry from
-- 'active' to 'removed' (the underlying record resolved/expired/was
-- superseded since the entry was created) without ever rewriting its
-- snapshot fields -- but as with UPDATED status above, no service in
-- this phase actually performs that transition yet; 'active' is the only
-- value this phase's code ever writes. Flagged, not built.
--
-- Exactly one candidate-source form, enforced by CHECK, same shape as
-- 0011's operator_directive_provenance: exactly one of directive_id,
-- work_order_id, action_receipt_id, memory_candidate_id.
-- =========================================================================
CREATE TABLE briefing_issue_entries (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id),
    briefing_issue_id          uuid NOT NULL REFERENCES briefing_issues(id),

    directive_id               uuid REFERENCES operator_directives(id),
    directive_revision_id      uuid REFERENCES operator_directive_revisions(id),
    work_order_id              uuid REFERENCES work_orders(id),
    action_receipt_id          uuid REFERENCES action_receipts(id),
    memory_candidate_id        uuid REFERENCES memory_candidates(id),

    lane                       text NOT NULL CHECK (
        lane IN ('decision', 'focus', 'action', 'blocker', 'watch', 'completed', 'evidence')
    ),
    rank                       integer NOT NULL,
    entry_status               text NOT NULL DEFAULT 'active' CHECK (entry_status IN ('active', 'removed')),

    new_to_issue               boolean NOT NULL,
    carried_from_issue_id      uuid REFERENCES briefing_issues(id),

    age_days_snapshot          integer,
    carry_count_snapshot       integer,
    defer_count_snapshot       integer,
    escalation_level_snapshot  integer,

    inclusion_reason           text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_briefing_issue_entries_exactly_one_source CHECK (
        (
            (CASE WHEN directive_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN work_order_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN action_receipt_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN memory_candidate_id IS NOT NULL THEN 1 ELSE 0 END)
        ) = 1
    ),
    CONSTRAINT chk_briefing_issue_entries_revision_requires_directive CHECK (
        directive_revision_id IS NULL OR directive_id IS NOT NULL
    )
);

CREATE INDEX idx_briefing_issue_entries_tenant_id ON briefing_issue_entries (tenant_id);
CREATE INDEX idx_briefing_issue_entries_issue_id ON briefing_issue_entries (briefing_issue_id);
CREATE INDEX idx_briefing_issue_entries_directive_id ON briefing_issue_entries (directive_id);

-- =========================================================================
-- Row-Level Security -- mandatory on every tenant-scoped table, same
-- USING+WITH CHECK form as 0004/0009/0011.
-- =========================================================================
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'briefing_issues', 'briefing_issue_entries'
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
