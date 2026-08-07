-- Vireon CORE — Cognitive Plane PR 8: Entity / Claim / World-State Schema
-- Governing document: "Deep Technical Research Report: Building Elora as a Real-World
-- Raphael" (canon), Section 20 PR 8. Sections 9.2 and 11 describe the broader world-state
-- model; this migration deliberately implements only its foundational persistence layer --
-- five tenant-scoped tables and no projector, no extraction, no contradiction detection.
-- No existing table is renamed or rewritten.

-- =========================================================================
-- entities: one durable identity row per explicitly-created entity. No closed
-- entity_type taxonomy and no uniqueness on canonical_name (tenant-scoped or
-- global) -- two explicitly created entities may currently share a name;
-- resolving whether they're the same real-world identity is a later, explicit
-- concern (PR 9+), never inferred here.
-- =========================================================================
CREATE TABLE entities (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id),

    entity_type    text NOT NULL,
    canonical_name text NOT NULL,

    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_entities_entity_type_nonempty
        CHECK (btrim(entity_type) <> ''),

    CONSTRAINT chk_entities_canonical_name_nonempty
        CHECK (btrim(canonical_name) <> '')
);

CREATE INDEX idx_entities_tenant_id
    ON entities (tenant_id);

CREATE INDEX idx_entities_tenant_type
    ON entities (tenant_id, entity_type);

CREATE INDEX idx_entities_tenant_canonical_name
    ON entities (tenant_id, canonical_name);

-- =========================================================================
-- entity_aliases: explicitly asserted alternate names only. (tenant_id, alias)
-- is deliberately NOT unique -- an alias string can be genuinely ambiguous in
-- the real world (two different entities legitimately sharing a nickname);
-- this table stores what was explicitly asserted, it does not resolve
-- ambiguity. (tenant_id, entity_id, alias) IS unique -- the same entity
-- cannot carry the identical alias string twice.
-- =========================================================================
CREATE TABLE entity_aliases (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id),
    entity_id  uuid NOT NULL REFERENCES entities(id),
    alias      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_entity_aliases_alias_nonempty
        CHECK (btrim(alias) <> ''),

    CONSTRAINT uq_entity_aliases_tenant_entity_alias
        UNIQUE (tenant_id, entity_id, alias)
);

CREATE INDEX idx_entity_aliases_tenant_id
    ON entity_aliases (tenant_id);

CREATE INDEX idx_entity_aliases_entity_id
    ON entity_aliases (entity_id);

CREATE INDEX idx_entity_aliases_tenant_alias
    ON entity_aliases (tenant_id, alias);

-- =========================================================================
-- claims: a typed observation/assertion about the world, always exactly one
-- of an entity or a JSON literal as its object. Bitemporal by design --
-- valid_from/valid_to is valid time (when the asserted fact applies in the
-- modeled world); recorded_at is transaction time (when CORE learned/recorded
-- this claim). There is deliberately no `created_at` column: a second
-- insertion timestamp would only duplicate recorded_at.
--
-- Corrections mirror the directive-revision pattern, not receipt supersession:
-- recordClaim() inserts a new row with supersedes_claim_id pointing at the
-- prior claim and never mutates that prior row. Whether a projector later
-- treats the prior claim as effectively superseded is a PR 9 concern --
-- the `superseded` status value exists here as schema vocabulary only.
-- =========================================================================
CREATE TABLE claims (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id),

    subject_entity_id  uuid REFERENCES entities(id),

    predicate          text NOT NULL,

    object_entity_id   uuid REFERENCES entities(id),
    object_value       jsonb,

    claim_kind         text NOT NULL CHECK (
        claim_kind IN (
            'observed',
            'user_asserted',
            'retrieved',
            'inferred',
            'predicted',
            'planned',
            'hypothetical'
        )
    ),

    confidence         real CHECK (
        confidence IS NULL OR
        (confidence >= 0 AND confidence <= 1)
    ),

    sensitivity        text,
    refresh_after      timestamptz,

    valid_from         timestamptz NOT NULL,
    valid_to           timestamptz,

    recorded_at        timestamptz NOT NULL DEFAULT now(),

    status             text NOT NULL DEFAULT 'active' CHECK (
        status IN (
            'active',
            'stale',
            'disputed',
            'superseded',
            'retracted'
        )
    ),

    supersedes_claim_id uuid REFERENCES claims(id),

    CONSTRAINT chk_claims_predicate_nonempty
        CHECK (btrim(predicate) <> ''),

    CONSTRAINT chk_claims_exactly_one_object CHECK (
        (
            (CASE WHEN object_entity_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN object_value IS NOT NULL THEN 1 ELSE 0 END)
        ) = 1
    ),

    CONSTRAINT chk_claims_valid_window CHECK (
        valid_to IS NULL OR valid_to > valid_from
    ),

    CONSTRAINT chk_claims_not_self_superseding CHECK (
        supersedes_claim_id IS NULL OR supersedes_claim_id <> id
    ),

    CONSTRAINT chk_claims_sensitivity_nonempty CHECK (
        sensitivity IS NULL OR btrim(sensitivity) <> ''
    )
);

-- Bounded B-tree indexes only -- no GiST temporal indexes, no JSONB GIN
-- indexes, no predicate indexes, no materialized current-state indexes.
-- There is no measured query workload yet; PR 9 can add indexes justified
-- by its own real projection queries.
CREATE INDEX idx_claims_tenant_id
    ON claims (tenant_id);

CREATE INDEX idx_claims_subject_entity_id
    ON claims (subject_entity_id);

CREATE INDEX idx_claims_object_entity_id
    ON claims (object_entity_id);

CREATE INDEX idx_claims_tenant_status
    ON claims (tenant_id, status);

CREATE INDEX idx_claims_tenant_valid_from
    ON claims (tenant_id, valid_from);

CREATE INDEX idx_claims_supersedes_claim_id
    ON claims (supersedes_claim_id);

-- =========================================================================
-- claim_evidence: typed foreign keys per source kind, deliberately not a
-- single nullable source_id -- mirrors operator_directive_provenance's own
-- "typed references, not a generic polymorphic pointer" choice. Two separate
-- CHECK constraints, proving two different invariants: exactly one FK is
-- populated, AND source_kind actually names the one that's populated (without
-- the second check, source_kind='message' with only work_order_id set would
-- pass the exactly-one check while being structurally dishonest evidence).
-- =========================================================================
CREATE TABLE claim_evidence (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id),
    claim_id              uuid NOT NULL REFERENCES claims(id),

    source_kind           text NOT NULL CHECK (
        source_kind IN (
            'message',
            'work_order',
            'authority_decision',
            'action_receipt',
            'directive',
            'briefing_issue',
            'trigger',
            'memory_record'
        )
    ),

    message_id            uuid REFERENCES messages(id),
    work_order_id         uuid REFERENCES work_orders(id),
    authority_decision_id uuid REFERENCES authority_decisions(id),
    action_receipt_id     uuid REFERENCES action_receipts(id),
    directive_id          uuid REFERENCES operator_directives(id),
    briefing_issue_id     uuid REFERENCES briefing_issues(id),
    trigger_id            uuid REFERENCES scheduled_triggers(id),
    memory_record_id      uuid REFERENCES memory_records(id),

    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_claim_evidence_exactly_one_source CHECK (
        (
            (CASE WHEN message_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN work_order_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN authority_decision_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN action_receipt_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN directive_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN briefing_issue_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN trigger_id IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN memory_record_id IS NOT NULL THEN 1 ELSE 0 END)
        ) = 1
    ),

    CONSTRAINT chk_claim_evidence_source_kind_matches_reference CHECK (
           (source_kind = 'message'
            AND message_id IS NOT NULL)

        OR (source_kind = 'work_order'
            AND work_order_id IS NOT NULL)

        OR (source_kind = 'authority_decision'
            AND authority_decision_id IS NOT NULL)

        OR (source_kind = 'action_receipt'
            AND action_receipt_id IS NOT NULL)

        OR (source_kind = 'directive'
            AND directive_id IS NOT NULL)

        OR (source_kind = 'briefing_issue'
            AND briefing_issue_id IS NOT NULL)

        OR (source_kind = 'trigger'
            AND trigger_id IS NOT NULL)

        OR (source_kind = 'memory_record'
            AND memory_record_id IS NOT NULL)
    )
);

CREATE INDEX idx_claim_evidence_tenant_id
    ON claim_evidence (tenant_id);

CREATE INDEX idx_claim_evidence_claim_id
    ON claim_evidence (claim_id);

-- =========================================================================
-- claim_conflicts: schema-supported explicit linking mechanism only. PR 8
-- contains no contradiction detector, no trigger that compares claims, and no
-- resolution service -- rows here can only be created by direct SQL or a
-- future explicit caller, never automatically.
-- =========================================================================
CREATE TABLE claim_conflicts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id),

    claim_a_id        uuid NOT NULL REFERENCES claims(id),
    claim_b_id        uuid NOT NULL REFERENCES claims(id),

    detected_at       timestamptz NOT NULL DEFAULT now(),

    resolution_status text NOT NULL DEFAULT 'unresolved' CHECK (
        resolution_status IN (
            'unresolved',
            'resolved',
            'dismissed'
        )
    ),

    CONSTRAINT chk_claim_conflicts_distinct_claims CHECK (
        claim_a_id <> claim_b_id
    )
);

CREATE INDEX idx_claim_conflicts_tenant_id
    ON claim_conflicts (tenant_id);

CREATE INDEX idx_claim_conflicts_claim_a_id
    ON claim_conflicts (claim_a_id);

CREATE INDEX idx_claim_conflicts_claim_b_id
    ON claim_conflicts (claim_b_id);

CREATE INDEX idx_claim_conflicts_tenant_resolution
    ON claim_conflicts (tenant_id, resolution_status);

-- =========================================================================
-- Row-Level Security -- mandatory on every tenant-scoped table, same
-- ENABLE + FORCE + USING/WITH CHECK form as every migration since 0002.
-- Tested against the non-superuser vireon role, never as superuser.
-- =========================================================================
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'entities', 'entity_aliases', 'claims', 'claim_evidence', 'claim_conflicts'
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
