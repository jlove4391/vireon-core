-- Vireon CORE Phase 1: local infrastructure and database spine
-- Establishes the foundational CORE runtime tables, tenant-scoped RLS,
-- and idempotency constraints per ADR 0001, core-runtime.md, ELORA.md,
-- and NEXORA.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- =========================================================================
-- tenants: the tenant boundary itself. Not tenant-scoped -- no RLS policy.
-- =========================================================================
CREATE TABLE tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- users: human accounts within a tenant.
-- =========================================================================
CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id),
    email        text NOT NULL,
    display_name text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant_id ON users (tenant_id);

-- =========================================================================
-- actors: any entity that initiates, interprets, executes, delegates, or
-- records work (human, agent, system, tool). See core-runtime.md 4.1.
-- =========================================================================
CREATE TABLE actors (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id),
    actor_type     text NOT NULL, -- human | agent | system | tool
    actor_name     text NOT NULL,
    actor_role     text,
    user_id        uuid REFERENCES users(id),
    acting_system  text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_actors_tenant_id ON actors (tenant_id);

-- =========================================================================
-- workspaces: operational context within a tenant.
-- =========================================================================
CREATE TABLE workspaces (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workspaces_tenant_id ON workspaces (tenant_id);

-- =========================================================================
-- projects: scoped body of work within a tenant/workspace.
-- =========================================================================
CREATE TABLE projects (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id),
    workspace_id  uuid NOT NULL REFERENCES workspaces(id),
    name          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_tenant_id ON projects (tenant_id);
CREATE INDEX idx_projects_workspace_id ON projects (workspace_id);

-- =========================================================================
-- threads: durable conversation or work context. Ships in the first
-- migration alongside messages -- see core-runtime.md 4.2.
-- =========================================================================
CREATE TABLE threads (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),
    workspace_id       uuid REFERENCES workspaces(id),
    project_id         uuid REFERENCES projects(id),
    parent_thread_id   uuid REFERENCES threads(id),
    title              text,
    status             text NOT NULL DEFAULT 'active',
    originating_surface text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_threads_tenant_id ON threads (tenant_id);

-- =========================================================================
-- messages: durable, append-only input/response/system communication.
-- Follows the same append-only, supersession-based correction model as
-- action_receipts -- see core-runtime.md 4.3. Carries source_correlation_id
-- for inbound duplicate-submission handling (ELORA.md 7.2); this is
-- distinct from retry idempotency and does not carry a unique constraint.
-- =========================================================================
CREATE TABLE messages (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id),
    thread_id              uuid NOT NULL REFERENCES threads(id),
    actor_id               uuid NOT NULL REFERENCES actors(id),
    role                   text NOT NULL,
    content                text NOT NULL,
    metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_surface         text,
    source_correlation_id  text,
    supersedes_message_id  uuid REFERENCES messages(id),
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_tenant_id ON messages (tenant_id);
CREATE INDEX idx_messages_thread_id ON messages (thread_id);

-- =========================================================================
-- work_orders: structured unit of intended work.
-- =========================================================================
CREATE TABLE work_orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id),
    workspace_id        uuid REFERENCES workspaces(id),
    project_id          uuid REFERENCES projects(id),
    thread_id           uuid REFERENCES threads(id),
    message_id          uuid REFERENCES messages(id),
    owner_actor_id      uuid REFERENCES actors(id),
    task_type           text NOT NULL,
    interpreted_intent  text,
    status              text NOT NULL DEFAULT 'pending',
    idempotency_key     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_work_orders_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_work_orders_tenant_id ON work_orders (tenant_id);
CREATE INDEX idx_work_orders_thread_id ON work_orders (thread_id);

-- =========================================================================
-- runs: execution attempt/frame associated with a work order.
-- =========================================================================
CREATE TABLE runs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id),
    work_order_id          uuid NOT NULL REFERENCES work_orders(id),
    actor_id               uuid NOT NULL REFERENCES actors(id),
    status                 text NOT NULL DEFAULT 'pending',
    attempt_number         integer NOT NULL DEFAULT 1,
    started_at             timestamptz,
    ended_at               timestamptz,
    failure_classification text,
    idempotency_key        text NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_runs_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_runs_tenant_id ON runs (tenant_id);
CREATE INDEX idx_runs_work_order_id ON runs (work_order_id);

-- =========================================================================
-- authority_decisions: risk-based classification of whether/how a work
-- order, run, tool invocation, or delegation may proceed.
-- requires_human_gatekeeper is queried alongside outcome by NEXORA.md
-- 11.1's mutating-tool pre-flight check, and must be set exclusively by
-- deterministic CORE code -- never directly by model output.
-- The tool_invocation_id foreign key is added after tool_invocations
-- exists (see below) to resolve the forward reference.
-- =========================================================================
CREATE TABLE authority_decisions (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id),
    schema_version            integer NOT NULL DEFAULT 1,
    outcome                   text NOT NULL CHECK (
        outcome IN ('act', 'act_and_report', 'escalate', 'setup_required', 'capability_missing', 'refuse')
    ),
    requires_human_gatekeeper boolean NOT NULL DEFAULT false,
    reason                    text,
    risk_level                text,
    deciding_actor_id         uuid REFERENCES actors(id),
    work_order_id             uuid REFERENCES work_orders(id),
    run_id                    uuid REFERENCES runs(id),
    tool_invocation_id        uuid,
    required_setup            text,
    created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_authority_decisions_tenant_id ON authority_decisions (tenant_id);
CREATE INDEX idx_authority_decisions_work_order_id ON authority_decisions (work_order_id);

-- =========================================================================
-- tool_invocations: governed attempt to use a tool or capability.
-- Exists as a runtime audit primitive even before the full tool registry.
-- =========================================================================
CREATE TABLE tool_invocations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id),
    run_id                uuid REFERENCES runs(id),
    work_order_id         uuid REFERENCES work_orders(id),
    tool_identifier       text NOT NULL,
    tool_version          text,
    authority_decision_id uuid REFERENCES authority_decisions(id),
    input_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_payload        jsonb,
    status                text NOT NULL DEFAULT 'pending',
    error_payload         jsonb,
    idempotency_key       text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,

    CONSTRAINT uq_tool_invocations_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_tool_invocations_tenant_id ON tool_invocations (tenant_id);
CREATE INDEX idx_tool_invocations_run_id ON tool_invocations (run_id);

ALTER TABLE authority_decisions
    ADD CONSTRAINT fk_authority_decisions_tool_invocation
    FOREIGN KEY (tool_invocation_id) REFERENCES tool_invocations(id);

-- =========================================================================
-- action_receipts: immutable append-only audit record for a meaningful
-- action. Implements the shared-base, discriminated-union contract from
-- core-runtime.md 8.2. Variant-specific fields live in `payload`, not as
-- ad hoc top-level columns. schema_version is versioned independently per
-- receipt_type (enforced at the Zod layer, not the database layer).
-- =========================================================================
CREATE TABLE action_receipts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL REFERENCES tenants(id),
    schema_version          integer NOT NULL DEFAULT 1,
    receipt_type            text NOT NULL,
    actor_id                uuid NOT NULL REFERENCES actors(id),
    acting_system           text NOT NULL,
    work_order_id           uuid REFERENCES work_orders(id),
    run_id                  uuid REFERENCES runs(id),
    authority_decision_id   uuid REFERENCES authority_decisions(id),
    tool_invocation_id      uuid REFERENCES tool_invocations(id),
    parent_receipt_id       uuid REFERENCES action_receipts(id),
    supersedes_receipt_id   uuid REFERENCES action_receipts(id),
    correction_receipt_id   uuid REFERENCES action_receipts(id),
    payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key         text NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_action_receipts_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_action_receipts_tenant_id ON action_receipts (tenant_id);
CREATE INDEX idx_action_receipts_work_order_id ON action_receipts (work_order_id);

-- =========================================================================
-- memory_candidates: proposed durable memory record. No idempotency key --
-- duplicate candidates are inexpensive and resolved at review, not at
-- execution time. promoted_memory_record_id foreign key is added after
-- memory_records exists (see below) to resolve the forward reference.
-- =========================================================================
CREATE TABLE memory_candidates (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id),
    source_message_id         uuid REFERENCES messages(id),
    source_receipt_id         uuid REFERENCES action_receipts(id),
    source_work_order_id      uuid REFERENCES work_orders(id),
    candidate_content         text NOT NULL,
    candidate_type            text,
    confidence                numeric,
    scope                     text,
    review_status             text NOT NULL DEFAULT 'proposed',
    reason_for_creation        text,
    promoted_memory_record_id uuid,
    created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_candidates_tenant_id ON memory_candidates (tenant_id);

-- =========================================================================
-- memory_records: durable memory accepted/promoted via the review path.
-- pgvector-ready: yes. embedding pipeline / vector search: deferred
-- (core-runtime.md 6.4 / 9.5).
-- =========================================================================
CREATE TABLE memory_records (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id),
    source_candidate_id uuid REFERENCES memory_candidates(id),
    content             text NOT NULL,
    record_type         text,
    scope               text,
    embedding           vector,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_records_tenant_id ON memory_records (tenant_id);

ALTER TABLE memory_candidates
    ADD CONSTRAINT fk_memory_candidates_promoted_memory_record
    FOREIGN KEY (promoted_memory_record_id) REFERENCES memory_records(id);

-- =========================================================================
-- artifacts: durable or semi-durable output produced by the runtime, a
-- tool, or an agent.
-- =========================================================================
CREATE TABLE artifacts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id),
    workspace_id     uuid REFERENCES workspaces(id),
    project_id       uuid REFERENCES projects(id),
    work_order_id    uuid REFERENCES work_orders(id),
    run_id           uuid REFERENCES runs(id),
    actor_id         uuid REFERENCES actors(id),
    receipt_id       uuid REFERENCES action_receipts(id),
    artifact_type    text NOT NULL,
    storage_reference text,
    content_pointer  text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_tenant_id ON artifacts (tenant_id);

-- =========================================================================
-- Row-Level Security: mandatory on every tenant-scoped table (ADR 0001,
-- core-runtime.md 12.1). `tenants` is the tenant boundary itself and is
-- excluded. FORCE ROW LEVEL SECURITY is required so the policy also
-- applies to the table-owning role, not only to non-owner roles.
-- =========================================================================
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'users', 'actors', 'workspaces', 'projects', 'threads', 'messages',
        'work_orders', 'runs', 'authority_decisions', 'tool_invocations',
        'action_receipts', 'memory_candidates', 'memory_records', 'artifacts'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''vireon.current_tenant_id'', true), '''')::uuid)',
            tbl
        );
    END LOOP;
END $$;
