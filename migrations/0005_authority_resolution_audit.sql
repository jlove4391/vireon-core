-- Vireon CORE Phase 6C: authority resolution engine -- audit trail addition.
-- Small, additive migration discovered while building
-- resolveAuthorityWithHierarchy.ts (src/elora/resolveAuthorityWithHierarchy.ts):
-- when an escalate outcome is silently resolved to act_and_report via a
-- superior's standing authorization, this records exactly which
-- authority_standing_rules row did it, for real audit traceability beyond
-- the free-text `reason` string. Left null for baseline classifier results
-- and genuine, unresolved live escalations.
--
-- No "hierarchy path walked" column is added here -- the reason text plus
-- this column is sufficient audit trail for now; a dedicated path column
-- would be schema ahead of proven need.

ALTER TABLE authority_decisions
    ADD COLUMN resolved_via_standing_rule_id uuid REFERENCES authority_standing_rules(id);
