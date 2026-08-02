-- Vireon CORE — Cognitive Plane PR 1: Durable Cognitive Run Contract
-- Governing document: "Deep Technical Research Report: Building Elora as a Real-World
-- Raphael" (canon per direction, 2026-08-01), Section 20 PR 1 — schema and state machine
-- only, no model calls, no branches, no model_invocations/budgets tables. Those land in
-- later PRs once real model operations and parallel deliberation exist to attach them to.

-- Schema-only foundation. cognitive_runs anchors to (tenant_id, thread_id, message_id),
-- the same anchor pattern work_orders itself uses (migrations/0001_core_foundation.sql) --
-- cognition is upstream of and independent from WorkOrder creation, not nested inside it.
-- No work-order-output reference exists in this migration: a cognitive run may eventually
-- recommend zero, one, or many actions, and that cardinality is unproven at this
-- schema-only stage. A single produced_work_order_id column would assume a 1:1
-- relationship this phase has no coordinator or synthesis capability to actually produce.
-- Deferred to whichever future PR introduces a real run-to-proposal-to-WorkOrder contract.

CREATE TABLE cognitive_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id),

    -- Plain FKs, not composite. Matches work_orders.thread_id/message_id exactly
    -- (migrations/0001_core_foundation.sql). createCognitiveRun.ts must only ever be
    -- invoked from an already-tenant-scoped context, the same precedent createWorkOrder.ts
    -- documents for its own identical threadId/messageId/actorId fields: "already
    -- validated tenant-scoped upstream by the sole caller." Confirmed directly against
    -- work_order_state_transitions.work_order_id and every directive_id reference in
    -- migrations/0011_operator_directive_ledger.sql — all plain FKs, no exception. Composite
    -- tenant-safe FKs in this codebase are reserved for genuine same-table hierarchical
    -- self-references (actors.reports_to_actor_id, delegation's parent_work_order_id), not
    -- applied broadly to cross-table references, which rely on RLS plus a targeted
    -- assertTenantScopedReference call only where a value is genuinely caller-influenced
    -- beyond what the immediate calling context already guarantees.
    thread_id               uuid REFERENCES threads(id),
    message_id              uuid REFERENCES messages(id),

    -- Who requested this cognitive work — distinct from actor_id on the transitions table
    -- below, which records who performed each individual transition (may differ
    -- transition to transition; e.g. a system actor completing a run a human actor
    -- started). Same disambiguation reasoning as 6I/6J's owning_actor_id vs
    -- created_by_actor_id split. Plain FK — see reasoning above.
    initiated_by_actor_id   uuid REFERENCES actors(id),

    -- Open semantic vocabulary, closed lexical format. The full taxonomy of cognitive
    -- operation kinds is not known yet — PR 2–4 haven't landed. Same reasoning 6L applied
    -- to briefing_type: don't force a migration every time a legitimate new kind is
    -- introduced, but don't allow whitespace/casing/punctuation drift either.
    objective_kind          text NOT NULL
        CONSTRAINT chk_cognitive_runs_objective_kind_format
        CHECK (objective_kind ~ '^[a-z][a-z0-9_]{0,63}$'),

    status                  text NOT NULL DEFAULT 'PENDING'
        CONSTRAINT chk_cognitive_runs_status
        CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),

    idempotency_key         text NOT NULL,

    -- Set only by transitionCognitiveRun.ts on entering RUNNING / a terminal state, never
    -- caller-controlled. FAILED and CANCELLED are terminal too, so a single generic
    -- ended_at (not completed_at) is correct — a "completed" timestamp on a FAILED row
    -- would be a naming bug.
    started_at              timestamptz,
    ended_at                timestamptz,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_cognitive_runs_tenant_idempotency UNIQUE (tenant_id, idempotency_key),

    -- Prerequisite for any future genuine self-reference (e.g. branches spawning child
    -- cognitive runs referencing this same table). Postgres requires this unique
    -- constraint to exist before any composite FK could ever reference (tenant_id, id).
    -- Cheap to add now; a second migration to retrofit it later would not be.
    CONSTRAINT uq_cognitive_runs_tenant_id_id UNIQUE (tenant_id, id)
);

CREATE INDEX idx_cognitive_runs_tenant_status ON cognitive_runs (tenant_id, status);
CREATE INDEX idx_cognitive_runs_thread_id ON cognitive_runs (thread_id);

-- Durable, granular transition history — work_order_state_transitions's exact pattern.
-- Every state a cognitive run has ever held gets a row here, including the first
-- (NULL -> PENDING, written atomically with the run itself by createCognitiveRun.ts).
-- No idempotency key on this table, intentionally, for the identical reason
-- work_order_state_transitions has none: transitionCognitiveRun.ts locks the row
-- (FOR UPDATE), reads current status, and validates against the transition map — a
-- retried call targeting the already-current status fails validation rather than
-- duplicating a row.
CREATE TABLE cognitive_run_transitions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),

    -- Plain FK, matching work_order_state_transitions.work_order_id and every
    -- operator_directive_transitions/revisions/provenance directive_id reference exactly.
    -- Populated by the same function that just created or locked the parent row in the
    -- same transaction — cannot be cross-tenant by construction, unlike a caller-supplied
    -- override value.
    cognitive_run_id   uuid NOT NULL REFERENCES cognitive_runs(id),

    from_state         text
        CONSTRAINT chk_cognitive_run_transitions_from_state
        CHECK (from_state IS NULL OR from_state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
    to_state           text NOT NULL
        CONSTRAINT chk_cognitive_run_transitions_to_state
        CHECK (to_state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
    actor_id           uuid REFERENCES actors(id),
    reason             text NOT NULL,
    transition_type    text NOT NULL DEFAULT 'state_change',
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cognitive_run_transitions_tenant_run
    ON cognitive_run_transitions (tenant_id, cognitive_run_id, created_at);

-- RLS: ENABLE + FORCE, tenant_isolation policy, identical pattern to every migration
-- since 0002. Postgres superusers unconditionally bypass RLS regardless of ENABLE/FORCE,
-- so this must be tested against the non-superuser vireon role, never as superuser — the
-- exact bug Phase 1 caught and fixed once already.

ALTER TABLE cognitive_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cognitive_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cognitive_runs
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);

ALTER TABLE cognitive_run_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cognitive_run_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cognitive_run_transitions
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);
