-- Vireon CORE — Cognitive Plane PR 3: Provider Correlation and Content-Policy Evidence
-- Governing document: "Deep Technical Research Report: Building Elora as a Real-World
-- Raphael" (canon), Section 20 PR 3. migrations/0014_model_invocations.sql (PR 2) already
-- merged to main -- this is an additive ALTER, not a rewrite of that file's history.

-- Provider correlation: which specific model/request/response this invocation actually
-- used, distinct from the requested configuration. Model aliases can move over time;
-- resolved_model captures what the provider actually reports back, not just what was
-- requested. provider_request_id/provider_response_id support correlation with
-- provider-side logs and support tickets when investigating a specific invocation.
ALTER TABLE model_invocations
    ADD COLUMN provider_request_id  text,
    ADD COLUMN provider_response_id text,
    ADD COLUMN resolved_model       text;

-- Content-policy evidence. A provider-neutral classification/redaction boundary now runs
-- before any request reaches an external provider (see src/elora/llm/contentPolicy/).
-- These columns record that the boundary ran and what it decided -- never the sensitive
-- content itself, consistent with PR 0's trace-privacy default and PR 2's
-- fingerprint-not-raw-content pattern.
ALTER TABLE model_invocations
    ADD COLUMN input_policy_version  integer NOT NULL DEFAULT 1
        CONSTRAINT chk_model_invocations_input_policy_version CHECK (input_policy_version > 0),
    ADD COLUMN input_classification  text NOT NULL DEFAULT 'INTERNAL'
        CONSTRAINT chk_model_invocations_input_classification
        CHECK (input_classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED','SECRET')),
    ADD COLUMN redaction_applied     boolean NOT NULL DEFAULT false,
    ADD COLUMN redaction_count       integer NOT NULL DEFAULT 0
        CONSTRAINT chk_model_invocations_redaction_count CHECK (redaction_count >= 0);

-- 'INTERNAL' as the default classification for pre-existing rows (from PR 2's own tests,
-- which predate this policy boundary entirely) is a defensible retroactive assumption:
-- not as loose as PUBLIC, not presumptively over-cautious like CONFIDENTIAL or above for
-- data that already flowed through the system before real classification existed.

-- No RLS changes needed -- model_invocations already has ENABLE + FORCE + tenant_isolation
-- from migration 0014; adding columns to an existing RLS-protected table doesn't require
-- re-declaring the policy.
