-- Vireon CORE Phase 6K: Operator Directive Ledger.
--
-- Directive records are canonical; rendered cards/prose (6M) are views.
-- This migration adds five tables and no execution-authority hooks --
-- owning_actor_id/issuing_actor_id are audit/attribution columns only,
-- never consulted by any resolution/dispatch path (confirmed directly
-- against the service code in this same phase, not just asserted here).
--
-- Fork resolution (locked, Phase A review): Option B -- every reference
-- column in operator_directive_provenance is a plain single-column FK,
-- uniform across all nine, including work_order_id/memory_candidate_id
-- despite those two target tables already carrying UNIQUE(tenant_id, id)
-- from 0006/0007. Tenant safety rides on RLS + tenant-scoped queries,
-- matching what authority_decisions/memory_candidates/action_receipts
-- already do for their own multi-typed nullable references today -- this
-- is the actual established norm, not the composite-FK pattern (which in
-- this codebase exists only for genuine self-references: actors and
-- work_orders reporting to/delegating from their own table). The same
-- "plain FK, RLS-backed" choice is applied uniformly to every actor
-- reference in this migration too (issuing_actor_id, owning_actor_id,
-- created_by_actor_id, proposed_owner_actor_id, actor_id,
-- suppressed_by_actor_id) and every directive_id back-reference, for the
-- same reason and for internal consistency across the whole ledger.

-- =========================================================================
-- operator_directives: canonical ledger row. One durable identity per
-- semantic issue via (tenant_id, dedupe_key) -- carrying, completion, and
-- reopening all reuse the same row. Recurring items must fold their own
-- occurrence/period into the dedupe key at the call site; this table has
-- no separate occurrence column of its own.
--
-- issuing_actor_id: who/what issued this directive (a deterministic
-- internal service, a diagnostic CLI invocation, etc. -- see
-- createOrMergeDirective.ts). owning_actor_id: who/what it's attributed to
-- for display and lifecycle purposes. Neither is ever consulted for an
-- authority decision -- there is no tool-execution or ingestion path
-- downstream of a Directive row in this phase at all (explicit non-goal:
-- no direct tool execution from a Directive row).
-- =========================================================================
CREATE TABLE operator_directives (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id),

    directive_type    text NOT NULL CHECK (
        directive_type IN ('decision', 'focus', 'action', 'blocker', 'watch')
    ),
    state             text NOT NULL DEFAULT 'PROPOSED' CHECK (
        state IN ('PROPOSED', 'OPEN', 'IN_PROGRESS', 'DEFERRED', 'COMPLETED',
                  'DISMISSED', 'EXPIRED', 'SUPERSEDED')
    ),
    dedupe_key        text NOT NULL,
    cycle_number      integer,

    issuing_actor_id  uuid NOT NULL REFERENCES actors(id),
    owning_actor_id   uuid NOT NULL REFERENCES actors(id),

    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now(),
    accepted_at       timestamptz,
    started_at        timestamptz,
    completed_at      timestamptz,
    deferred_at       timestamptz,
    dismissed_at      timestamptz,
    expires_at        timestamptz,

    due_at            timestamptz,
    window_start_at   timestamptz,
    window_end_at     timestamptz,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_operator_directives_tenant_dedupe UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX idx_operator_directives_tenant_id ON operator_directives (tenant_id);
CREATE INDEX idx_operator_directives_state ON operator_directives (tenant_id, state);
CREATE INDEX idx_operator_directives_owning_actor_id ON operator_directives (owning_actor_id);

-- =========================================================================
-- operator_directive_revisions: append-only. No idempotency key -- same
-- posture as `messages` (core-runtime.md 3.2): a revision is a recorded
-- fact, not itself a side-effecting retry target. content_hash lets
-- createOrMergeDirective.ts detect "material content changed" cheaply,
-- same shape as createWorkOrder.ts's own intentFingerprint.
-- =========================================================================
CREATE TABLE operator_directive_revisions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id),
    directive_id           uuid NOT NULL REFERENCES operator_directives(id),
    revision_number        integer NOT NULL,

    title                  text NOT NULL,
    body                   text,
    why_now                text,
    priority               text,

    proposed_owner_actor_id uuid REFERENCES actors(id),

    due_at                 timestamptz,
    window_start_at        timestamptz,
    window_end_at          timestamptz,
    expires_at             timestamptz,

    content_hash           text NOT NULL,
    change_reason          text,
    created_by_actor_id    uuid NOT NULL REFERENCES actors(id),
    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_operator_directive_revisions_number UNIQUE (tenant_id, directive_id, revision_number)
);

CREATE INDEX idx_operator_directive_revisions_tenant_id ON operator_directive_revisions (tenant_id);
CREATE INDEX idx_operator_directive_revisions_directive_id ON operator_directive_revisions (directive_id);

-- =========================================================================
-- operator_directive_transitions: append-only, mandatory state evidence
-- (spec's own core rule -- selective ActionReceipt variants only where a
-- clean fit is proven, not a parallel receipt family). from_state/to_state
-- CHECK-enumerated inline, same shape as work_order_state_transitions
-- (migration 0002) rather than a foreign-keyed lookup table. No
-- idempotency key -- rides on the parent directive row, same as
-- work_order_state_transitions rides on work_orders.
-- =========================================================================
CREATE TABLE operator_directive_transitions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    directive_id    uuid NOT NULL REFERENCES operator_directives(id),

    from_state      text CHECK (
        from_state IS NULL OR from_state IN
        ('PROPOSED', 'OPEN', 'IN_PROGRESS', 'DEFERRED', 'COMPLETED',
         'DISMISSED', 'EXPIRED', 'SUPERSEDED')
    ),
    to_state        text NOT NULL CHECK (
        to_state IN ('PROPOSED', 'OPEN', 'IN_PROGRESS', 'DEFERRED', 'COMPLETED',
                     'DISMISSED', 'EXPIRED', 'SUPERSEDED')
    ),
    actor_id        uuid REFERENCES actors(id),
    transition_type text NOT NULL DEFAULT 'state_change',
    reason          text NOT NULL,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_operator_directive_transitions_tenant_id ON operator_directive_transitions (tenant_id);
CREATE INDEX idx_operator_directive_transitions_directive_id ON operator_directive_transitions (directive_id);

-- =========================================================================
-- operator_directive_provenance: evidence trail. Every occurrence of
-- re-detecting the same semantic issue adds a row here rather than a
-- duplicate Directive (acceptance criterion #2) -- rows are allowed to
-- accumulate per directive_id/source, deliberately not deduplicated at
-- the schema layer (no uniqueness constraint on the reference columns):
-- each detection event is its own audit entry, and nothing in the spec
-- asks for row-level provenance dedup, only Directive-level dedup.
--
-- Exactly one provenance source form, enforced by CHECK: exactly one of
-- the nine internal typed references, OR the external form (marked by
-- `provider`), never both, never neither.
-- =========================================================================
CREATE TABLE operator_directive_provenance (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id),
    directive_id         uuid NOT NULL REFERENCES operator_directives(id),

    message_id           uuid REFERENCES messages(id),
    work_order_id        uuid REFERENCES work_orders(id),
    run_id               uuid REFERENCES runs(id),
    authority_decision_id uuid REFERENCES authority_decisions(id),
    tool_invocation_id   uuid REFERENCES tool_invocations(id),
    action_receipt_id    uuid REFERENCES action_receipts(id),
    artifact_id          uuid REFERENCES artifacts(id),
    memory_candidate_id  uuid REFERENCES memory_candidates(id),
    memory_record_id     uuid REFERENCES memory_records(id),

    provider             text,
    external_identifier  text,
    external_locator     text,
    label                text,
    observed_at          timestamptz,
    content_hash         text,
    metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_operator_directive_provenance_exactly_one_source CHECK (
        (
            (CASE WHEN message_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN work_order_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN run_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN authority_decision_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN tool_invocation_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN action_receipt_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN artifact_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN memory_candidate_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN memory_record_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN provider IS NOT NULL THEN 1 ELSE 0 END)
        ) = 1
    ),
    CONSTRAINT chk_operator_directive_provenance_external_identifier CHECK (
        provider IS NULL OR external_identifier IS NOT NULL
    )
);

CREATE INDEX idx_operator_directive_provenance_tenant_id ON operator_directive_provenance (tenant_id);
CREATE INDEX idx_operator_directive_provenance_directive_id ON operator_directive_provenance (directive_id);

-- =========================================================================
-- operator_directive_suppressions: append-only history, not a single
-- mutable per-key row -- no uniqueness constraint on dedupe_key. Whether a
-- key is "currently suppressed" is a read-time question (does any row for
-- this dedupe_key have suppressed_until > now()?), not a stored boolean --
-- same "derive, don't store" posture as carry_count/defer_count/
-- escalation_level.
-- =========================================================================
CREATE TABLE operator_directive_suppressions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id),
    dedupe_key           text NOT NULL,
    reason               text NOT NULL,
    suppressed_by_actor_id uuid NOT NULL REFERENCES actors(id),
    suppressed_until     timestamptz NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_operator_directive_suppressions_tenant_id ON operator_directive_suppressions (tenant_id);
CREATE INDEX idx_operator_directive_suppressions_dedupe_key ON operator_directive_suppressions (tenant_id, dedupe_key);

-- =========================================================================
-- Row-Level Security -- mandatory on every tenant-scoped table, same
-- USING+WITH CHECK form as 0004/0009 (the fuller form, not 0001's
-- USING-only original).
-- =========================================================================
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'operator_directives', 'operator_directive_revisions',
        'operator_directive_transitions', 'operator_directive_provenance',
        'operator_directive_suppressions'
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
