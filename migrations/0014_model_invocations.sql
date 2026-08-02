-- Vireon CORE — Cognitive Plane PR 2: Model Invocation Evidence
-- Governing document: "Deep Technical Research Report: Building Elora as a Real-World
-- Raphael" (canon), Section 20 PR 2. Refined via architectural review, 2026-08-01.

-- Each row is durable evidence of one physical attempt at a structured model operation.
-- A logical request (invocation_key) may have multiple physical attempts
-- (attempt_number) -- a timeout or failure followed by a retry is a genuinely new
-- real-world event (new latency, new tokens, possibly a different outcome), not the
-- same event replayed. UNIQUE(tenant_id, idempotency_key) with insert-or-fetch --
-- the pattern every other idempotent table in this codebase uses -- would either
-- silently discard the second real attempt's evidence or force overwriting the
-- first, both violating this codebase's own append-only evidence doctrine. This
-- table's shape is deliberately different from work_orders/cognitive_runs for this
-- reason, not an oversight or inconsistency with them.

CREATE TABLE model_invocations (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    uuid NOT NULL REFERENCES tenants(id),

    -- Nullable: PR 2 wires nothing into a live cognitive run yet (see the PR 2
    -- decisions-first kickoff). An invocation created by PR 2's own isolated tests
    -- has no real cognitive run to attach to. Plain FK, matching every other
    -- cross-table reference in this codebase (work_orders.thread_id,
    -- operator_directive_*.directive_id) -- composite tenant-safe FKs remain
    -- reserved for genuine same-table self-references only.
    cognitive_run_id             uuid REFERENCES cognitive_runs(id),

    -- Closed enum, not open-vocabulary like cognitive_runs.objective_kind. Unlike a
    -- cognitive run's objective, this set is fully known right now: exactly the six
    -- operations this PR implements. Widen if a real seventh operation is added
    -- later, not preemptively.
    operation_kind               text NOT NULL
        CONSTRAINT chk_model_invocations_operation_kind
        CHECK (operation_kind IN
            ('response_synthesis','intent_interpretation','planning','critique',
             'extraction','reranking')),

    -- The exact contract (prompt shape + Zod schema) that produced a given
    -- invocation will change over time. Recording which version fired is what makes
    -- "which exact planning contract produced this result" answerable during an
    -- audit or a regression, rather than only inferable from when the row was
    -- created.
    operation_version             integer NOT NULL DEFAULT 1
        CONSTRAINT chk_model_invocations_operation_version CHECK (operation_version > 0),
    input_schema_version          integer NOT NULL DEFAULT 1
        CONSTRAINT chk_model_invocations_input_schema_version CHECK (input_schema_version > 0),
    output_schema_version         integer NOT NULL DEFAULT 1
        CONSTRAINT chk_model_invocations_output_schema_version CHECK (output_schema_version > 0),

    provider                      text NOT NULL,
    model                         text NOT NULL,

    -- STARTED is inserted before the external provider call, updated afterward --
    -- see the completion-consistency CHECK below. Without this, a process crash or
    -- lost DB connectivity between "call sent" and "response persisted" leaves zero
    -- durable evidence the invocation was ever attempted. A stale STARTED row past
    -- its expected duration becomes observable evidence of an interrupted
    -- operation, not silence.
    status                        text NOT NULL
        CONSTRAINT chk_model_invocations_status
        CHECK (status IN ('STARTED','SUCCEEDED','FAILED','TIMED_OUT')),

    -- Identifies the logical request; paired with attempt_number below to give each
    -- physical attempt its own durable row. See the table-level comment.
    invocation_key                text NOT NULL,
    attempt_number                integer NOT NULL DEFAULT 1
        CONSTRAINT chk_model_invocations_attempt_positive CHECK (attempt_number > 0),

    -- Token quantities only, not a calculated dollar cost -- a stored cost estimate
    -- without also storing the pricing schedule, its effective date, and
    -- provider-specific cache/batch pricing would look precise while being
    -- historically unreproducible. Monetary cost is deferred to a future
    -- model_pricing_versions / model_invocation_cost_snapshots design, computed
    -- from the pricing version effective at invocation time, never recalculated
    -- against current prices.
    input_tokens                  integer
        CONSTRAINT chk_model_invocations_input_tokens CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens                 integer
        CONSTRAINT chk_model_invocations_output_tokens CHECK (output_tokens IS NULL OR output_tokens >= 0),
    -- Verified directly against Anthropic's current API docs: usage.cache_creation_input_tokens
    -- and usage.cache_read_input_tokens are the real field names as of this writing.
    cache_creation_input_tokens   integer
        CONSTRAINT chk_model_invocations_cache_creation_tokens
        CHECK (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0),
    cache_read_input_tokens       integer
        CONSTRAINT chk_model_invocations_cache_read_tokens
        CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0),
    -- Catch-all for provider-specific usage data that doesn't map to the common
    -- columns above -- e.g. Anthropic's cache_creation.ephemeral_5m_input_tokens /
    -- ephemeral_1h_input_tokens TTL breakdown, confirmed real and undocumented
    -- anywhere else in this schema.
    provider_usage                jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Hashes/fingerprints, never raw prompt or response content -- consistent with
    -- PR 0's trace-privacy default of never capturing content by default.
    request_fingerprint           text,
    response_fingerprint          text,

    duration_ms                   integer
        CONSTRAINT chk_model_invocations_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
    error_class                   text,

    started_at                    timestamptz NOT NULL DEFAULT now(),
    completed_at                  timestamptz,

    created_at                    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_model_invocations_tenant_key_attempt
        UNIQUE (tenant_id, invocation_key, attempt_number),

    -- STARTED rows have no completion data yet; every other status must have both.
    CONSTRAINT chk_model_invocations_completion_consistency
        CHECK (
            (status = 'STARTED' AND completed_at IS NULL AND duration_ms IS NULL)
            OR
            (status <> 'STARTED' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL)
        )
);

CREATE INDEX idx_model_invocations_tenant_run
    ON model_invocations (tenant_id, cognitive_run_id);

CREATE INDEX idx_model_invocations_tenant_operation
    ON model_invocations (tenant_id, operation_kind, created_at DESC);

-- Partial index: efficiently finds invocations that started but never reached a
-- terminal status -- the operational query the STARTED state exists to make
-- answerable (possible crash/interruption evidence).
CREATE INDEX idx_model_invocations_incomplete
    ON model_invocations (tenant_id, started_at)
    WHERE status = 'STARTED';

-- RLS: ENABLE + FORCE, tenant_isolation policy, identical pattern to every migration
-- since 0002. Tested against the non-superuser vireon role, never as superuser --
-- the exact bug Phase 1 caught and fixed once already.

ALTER TABLE model_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_invocations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON model_invocations
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);
