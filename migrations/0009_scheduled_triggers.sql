-- Vireon CORE Phase 6I: scheduled trigger schema and creation.
--
-- A scheduled trigger is a persisted record (owning persona, schedule,
-- synthetic message content) that 6J will feed through the existing
-- ingestUserMessage() pipeline when due. This migration only adds the
-- durable record and the columns creation needs -- it does not add any
-- poller/executor state. next_fire_at plus its partial index below is the
-- "give me what's due" query surface 6J is expected to use; the actual
-- due-polling logic is out of scope here.
--
-- Creation path (Phase B decision): a direct structured service call
-- (src/elora/triggers/createScheduledTrigger.ts), not a WorkOrder/
-- ingestUserMessage() round trip -- same shape 6G used for memory
-- review/promotion. classifyAuthority()/resolveAuthorityWithHierarchy()
-- are called as bare functions against the trigger's own structured
-- description; no WorkOrder is ever created for the *creation* action
-- itself (only for what the trigger fires later, in 6J). Because of that,
-- there is no work-order-shaped column on this table for the creation
-- action -- authority_decision_id is the row that records how creation was
-- authorized, with its own work_order_id left NULL.
--
-- Condition-based monitoring is deliberately not a separate primitive
-- (ROADMAP.md 6I): there is no condition_expression column. The
-- conditional check lives inside synthetic_message_content as natural
-- language, interpreted downstream whenever the trigger actually fires.
CREATE TABLE scheduled_triggers (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id),
    workspace_id              uuid REFERENCES workspaces(id),
    project_id                uuid REFERENCES projects(id),

    -- The persona this trigger fires as (6J: the actorId ingestUserMessage()
    -- receives). Not necessarily the same actor that requested creation.
    owning_actor_id           uuid NOT NULL REFERENCES actors(id),

    -- Who requested creation (authority_decisions.deciding_actor_id mirrors
    -- this). This is the actor whose hierarchy position the authority walk
    -- actually starts from -- see createScheduledTrigger.ts's own
    -- documentation for why owning_actor_id must not drive resolution
    -- (naming an owner must never let a creator borrow that owner's
    -- standing authorizations).
    created_by_actor_id       uuid NOT NULL REFERENCES actors(id),

    -- The decision that authorized this row's existence. A scheduled_triggers
    -- row is only ever inserted after an authorized (act / act_and_report)
    -- outcome, so this is NOT NULL by construction, not merely by convention.
    authority_decision_id     uuid NOT NULL REFERENCES authority_decisions(id),

    status                    text NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'paused', 'revoked')
    ),

    schedule_kind             text NOT NULL CHECK (
        schedule_kind IN ('cron', 'interval', 'one_off')
    ),
    schedule_expression       text NOT NULL,
    timezone                  text,

    -- Fed verbatim into ingestUserMessage()'s `content` at fire time (6J).
    synthetic_message_content text NOT NULL,

    -- Free text, no fixed list -- same "no fixed taxonomy until a real
    -- consumer needs one" pattern as memory_candidates.scope (see 6G/6H).
    trigger_category          text,

    -- 6J's "due" query target.
    next_fire_at              timestamptz,
    last_fired_at             timestamptz,
    last_fired_work_order_id  uuid REFERENCES work_orders(id),

    idempotency_key           text NOT NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_scheduled_triggers_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_scheduled_triggers_tenant_id ON scheduled_triggers (tenant_id);
CREATE INDEX idx_scheduled_triggers_owning_actor_id ON scheduled_triggers (owning_actor_id);

-- Partial index on the "due" query shape 6J will need: active triggers
-- ordered by when they're next due. Not a poller -- just the index a
-- poller would want.
CREATE INDEX idx_scheduled_triggers_next_fire_at ON scheduled_triggers (next_fire_at)
    WHERE status = 'active';

ALTER TABLE scheduled_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scheduled_triggers
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);
