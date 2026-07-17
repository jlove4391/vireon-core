-- Vireon CORE Phase 6B: authority hierarchy -- schema and policy.
-- Schema and doctrine only. No runtime behavior changes: nothing live
-- consults anything added here yet. classifyAuthority.ts,
-- transitionWorkOrder.ts, and ingestUserMessage.ts are not modified by
-- this phase. The resolution engine that walks this hierarchy, resolves
-- standing rules, and enforces the floor is Phase 6C.

-- =========================================================================
-- actors: add the vertical reporting hierarchy. `uq_actors_tenant_id_id`
-- is what makes the self-referencing FK below tenant-safe --
-- (tenant_id, reports_to_actor_id) referencing actors(tenant_id, id) means
-- a row can only report to another actor in the *same* tenant. A plain
-- `uuid REFERENCES actors(id)` would not enforce that, since actors.id
-- alone isn't tenant-scoped in the reference target.
--
-- reports_to_actor_id is nullable -- composite FKs with a null component
-- are not enforced by Postgres, so the Sovereign's null value is fine.
--
-- hierarchy_tier applies to hierarchy participants (the human Sovereign
-- and every persona actor) and stays null for unrelated human, system, or
-- tool actor rows. 'swarm' is included for schema completeness (the
-- roadmap treats that layer as deferred, not forgotten) -- no row uses it
-- in this phase.
-- =========================================================================
ALTER TABLE actors ADD CONSTRAINT uq_actors_tenant_id_id UNIQUE (tenant_id, id);

ALTER TABLE actors ADD COLUMN reports_to_actor_id uuid;
ALTER TABLE actors ADD COLUMN hierarchy_tier text CHECK (
    hierarchy_tier IN ('sovereign', 'executive', 'inner_circle', 'outer_circle', 'special_envoy', 'swarm')
);

ALTER TABLE actors ADD CONSTRAINT fk_actors_reports_to
    FOREIGN KEY (tenant_id, reports_to_actor_id) REFERENCES actors (tenant_id, id);

CREATE INDEX idx_actors_reports_to_actor_id ON actors (reports_to_actor_id);

-- =========================================================================
-- authority_standing_rules: standing pre-authorizations and their
-- auto-refuse mirror, distinguished by `polarity` rather than two tables.
--
-- Approval/refusal semantics (see AUTHORITY_AND_DELEGATION.md for the full
-- doctrine): approval-polarity standing rules apply only to eligible
-- `escalate` and `act_and_report` patterns. They cannot override `refuse`,
-- `setup_required`, or `capability_missing`. Refusal-polarity rules are a
-- separate tightening mechanism that may produce `refuse`, but can never
-- loosen an existing refusal or authorize an otherwise-blocked action.
--
-- `confirmed_by_actor_id` must always resolve to the Sovereign's actor id.
-- This is the single most important invariant in this table, and it is
-- documented, not enforced, at this schema layer -- the foreign key below
-- proves the confirmer is a real actor in-tenant, not that they are
-- actually the Sovereign. Enforcing that invariant is left to Phase 6C
-- (or a dedicated follow-up) to decide how to do properly; a
-- function-based check against hierarchy_tier could do it, but that is
-- resolution-adjacent logic and out of scope here.
--
-- No idempotency key: this is a governance record, not a side-effecting
-- retryable write -- same reasoning as memory_candidates.
-- =========================================================================
CREATE TABLE authority_standing_rules (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id),
    polarity              text NOT NULL CHECK (polarity IN ('approve', 'refuse')),
    scope_actor_id        uuid NOT NULL,
    domain                text NOT NULL CHECK (btrim(domain) <> ''),
    pattern_description   text NOT NULL CHECK (btrim(pattern_description) <> ''),
    match_criteria        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(match_criteria) = 'object'),
    proposed_by_actor_id  uuid,
    confirmed_by_actor_id uuid NOT NULL,
    status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    revoked_by_actor_id   uuid,
    revocation_reason     text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    revoked_at            timestamptz,

    CONSTRAINT fk_asr_scope_actor
        FOREIGN KEY (tenant_id, scope_actor_id) REFERENCES actors (tenant_id, id),
    CONSTRAINT fk_asr_proposed_by
        FOREIGN KEY (tenant_id, proposed_by_actor_id) REFERENCES actors (tenant_id, id),
    CONSTRAINT fk_asr_confirmed_by
        FOREIGN KEY (tenant_id, confirmed_by_actor_id) REFERENCES actors (tenant_id, id),
    CONSTRAINT fk_asr_revoked_by
        FOREIGN KEY (tenant_id, revoked_by_actor_id) REFERENCES actors (tenant_id, id),
    CONSTRAINT chk_asr_revocation_consistency CHECK (
        (status = 'active' AND revoked_at IS NULL AND revoked_by_actor_id IS NULL)
        OR
        (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_actor_id IS NOT NULL)
    )
);

CREATE INDEX idx_authority_standing_rules_tenant_id ON authority_standing_rules (tenant_id);
CREATE INDEX idx_authority_standing_rules_scope_actor_id ON authority_standing_rules (scope_actor_id);

ALTER TABLE authority_standing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_standing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON authority_standing_rules
    USING (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('vireon.current_tenant_id', true), '')::uuid);

-- =========================================================================
-- Hierarchy consistency constraints. These encode already-decided
-- structural facts about the model -- not new resolution behavior. Do NOT
-- extend this into cycle detection, valid-reporting-path validation, or
-- anything that requires runtime traversal logic -- that belongs to 6C.
-- =========================================================================
ALTER TABLE actors ADD CONSTRAINT chk_actors_tier_actor_type CHECK (
    hierarchy_tier IS NULL
    OR (hierarchy_tier = 'sovereign' AND actor_type = 'human')
    OR (hierarchy_tier <> 'sovereign' AND actor_type = 'agent')
);

ALTER TABLE actors ADD CONSTRAINT chk_actors_tier_reports_to CHECK (
    hierarchy_tier IS NULL
    OR (hierarchy_tier = 'sovereign' AND reports_to_actor_id IS NULL)
    OR (hierarchy_tier <> 'sovereign' AND reports_to_actor_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_actors_one_sovereign_per_tenant
    ON actors (tenant_id)
    WHERE hierarchy_tier = 'sovereign';
