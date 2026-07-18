-- Vireon CORE Phase 6D: delegation -- vertical and peer, reconciled as one
-- mechanism. Schema and mechanism only, no live caller yet: nothing in the
-- current codebase can decide to delegate anything (that requires either a
-- real second persona's classifier or LLM reasoning, neither of which
-- exists yet -- Phase 6F). Proven with directly-constructed test data;
-- live end-to-end proof deferred to Nexora/Kaz/Jynx's own builds.

-- =========================================================================
-- work_orders: parent/child delegation link. Composite tenant-safe FK, same
-- pattern established in 6B (migrations/0004_authority_hierarchy.sql) for
-- actors.reports_to_actor_id -- a plain `uuid REFERENCES work_orders(id)`
-- would not prove the parent belongs to the same tenant.
--
-- Naming deliberately not "vertical"/"horizontal" in schema:
-- 'supervised' = the vertical case (delegator has real hierarchical
--   standing over the receiver, per 6B's reporting chain -- e.g. ELORA to
--   Nexora).
-- 'peer' = the horizontal case (structural peers, no authority
--   relationship -- e.g. Jynx to Cassian). The receiver resolves under
--   their own independent authority scope.
-- Full doctrine mapping lives in AUTHORITY_AND_DELEGATION.md.
-- delegation_mode is null on every normal, non-delegated WorkOrder --
-- only ever set on a child WorkOrder created via this mechanism.
-- =========================================================================
ALTER TABLE work_orders ADD CONSTRAINT uq_work_orders_tenant_id_id UNIQUE (tenant_id, id);

ALTER TABLE work_orders ADD COLUMN parent_work_order_id uuid;
ALTER TABLE work_orders ADD COLUMN delegation_mode text CHECK (
    delegation_mode IN ('supervised', 'peer')
);

ALTER TABLE work_orders ADD CONSTRAINT fk_work_orders_parent
    FOREIGN KEY (tenant_id, parent_work_order_id) REFERENCES work_orders (tenant_id, id);

CREATE INDEX idx_work_orders_parent_work_order_id ON work_orders (parent_work_order_id);

-- =========================================================================
-- work_orders: authority-bounding schema hook -- unenforced placeholder.
-- Free text only. Not validated, not matched against anything. Gives a
-- real column for a future phase to populate once a persona's actual
-- positive authority scope exists to check against (Tier 2/3, unbuilt).
-- Do not build matching or validation logic against this field in 6D.
-- =========================================================================
ALTER TABLE work_orders ADD COLUMN delegated_authority_scope_note text;
