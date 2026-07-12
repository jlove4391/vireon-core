-- Vireon CORE Phase 2: CORE state machine v1 -- WorkOrder lifecycle engine.
-- Adds the work_order_state_transitions history table, links work_orders to
-- the AuthorityDecision that classified them, and constrains work_orders.status,
-- work_order_state_transitions.{from_status,to_status}, and runs.status to
-- their v1 vocabularies. src/state/workOrderState.ts is the single source of
-- truth for these vocabularies in application code -- this migration mirrors
-- it at the database boundary via CHECK constraints rather than native
-- Postgres enums, which are cheaper to evolve past v1 (ADR 0001).

-- =========================================================================
-- work_order_state_transitions: durable, append-only history of every
-- status a WorkOrder has ever held, including the initial NULL -> RECEIVED
-- row written atomically with WorkOrder creation (see createWorkOrder.ts).
-- Deliberately has no idempotency key: transitionWorkOrder locks the
-- WorkOrder row (FOR UPDATE), reads its current status, and validates the
-- requested transition against VALID_WORK_ORDER_TRANSITIONS -- a retried
-- call targeting the already-current status fails that validation rather
-- than needing a dedupe key. This is intentional, not an oversight.
-- =========================================================================
CREATE TABLE work_order_state_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    work_order_id uuid NOT NULL REFERENCES work_orders(id),
    from_status text NULL,
    to_status text NOT NULL,
    actor_id uuid REFERENCES actors(id),
    reason text NOT NULL,
    transition_type text NOT NULL DEFAULT 'state_change',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_work_order_state_transitions_from_status CHECK (
        from_status IS NULL OR from_status IN (
            'RECEIVED', 'INTENT_PARSED', 'AUTHORITY_CLASSIFIED', 'READY_TO_ACT',
            'AWAITING_AUTHORIZATION', 'SETUP_REQUIRED', 'CAPABILITY_MISSING', 'REFUSED',
            'EXECUTING', 'VALIDATING', 'RECEIPT_WRITTEN', 'MEMORY_CANDIDATES_CREATED',
            'COMPLETED', 'FAILED'
        )
    ),
    CONSTRAINT chk_work_order_state_transitions_to_status CHECK (
        to_status IN (
            'RECEIVED', 'INTENT_PARSED', 'AUTHORITY_CLASSIFIED', 'READY_TO_ACT',
            'AWAITING_AUTHORIZATION', 'SETUP_REQUIRED', 'CAPABILITY_MISSING', 'REFUSED',
            'EXECUTING', 'VALIDATING', 'RECEIPT_WRITTEN', 'MEMORY_CANDIDATES_CREATED',
            'COMPLETED', 'FAILED'
        )
    )
);

CREATE INDEX idx_work_order_state_transitions_tenant_work_order
    ON work_order_state_transitions (tenant_id, work_order_id, created_at);

ALTER TABLE work_order_state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_state_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_order_state_transitions
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);

-- =========================================================================
-- work_orders: link to the AuthorityDecision that classified the WorkOrder,
-- and constrain status to the WorkOrderStatus v1 vocabulary.
--
-- Data note: 0001 defaulted work_orders.status to the placeholder 'pending'
-- and left it unconstrained. Local dev/test databases running against a
-- persistent Docker volume may already carry rows written under that
-- placeholder (e.g. from Phase 1 acceptance test runs). Those are
-- normalized to 'RECEIVED' -- the v1 equivalent of "just created, nothing
-- has happened yet" -- before the CHECK constraint is added, so this
-- migration succeeds against both a fresh database and one that already
-- ran Phase 1. The normalizing UPDATE must run with RLS disabled: the
-- migration role has no tenant context set, and work_orders carries FORCE
-- ROW LEVEL SECURITY, so a normal UPDATE would be silently filtered to zero
-- rows rather than actually fixing the pre-existing data.
-- =========================================================================
ALTER TABLE work_orders DISABLE ROW LEVEL SECURITY;
UPDATE work_orders SET status = 'RECEIVED' WHERE status = 'pending';
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_orders ADD COLUMN authority_decision_id uuid NULL REFERENCES authority_decisions(id);

ALTER TABLE work_orders ALTER COLUMN status SET DEFAULT 'RECEIVED';

ALTER TABLE work_orders ADD CONSTRAINT chk_work_orders_status CHECK (
    status IN (
        'RECEIVED', 'INTENT_PARSED', 'AUTHORITY_CLASSIFIED', 'READY_TO_ACT',
        'AWAITING_AUTHORIZATION', 'SETUP_REQUIRED', 'CAPABILITY_MISSING', 'REFUSED',
        'EXECUTING', 'VALIDATING', 'RECEIPT_WRITTEN', 'MEMORY_CANDIDATES_CREATED',
        'COMPLETED', 'FAILED'
    )
);

CREATE INDEX idx_work_orders_tenant_status ON work_orders (tenant_id, status);

-- =========================================================================
-- runs: constrain status to the minimal Phase 2 Run status set. 0001 left
-- runs.status unconstrained (text NOT NULL DEFAULT 'pending'); Phase 2 is
-- the first phase that actually writes Run rows (READY_TO_ACT -> EXECUTING).
-- Same RLS caveat as work_orders above applies to this normalizing UPDATE.
-- =========================================================================
ALTER TABLE runs DISABLE ROW LEVEL SECURITY;
UPDATE runs SET status = 'PENDING' WHERE status = 'pending';
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE runs ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE runs ADD CONSTRAINT chk_runs_status CHECK (
    status IN ('PENDING', 'EXECUTING', 'VALIDATING', 'COMPLETED', 'FAILED')
);
