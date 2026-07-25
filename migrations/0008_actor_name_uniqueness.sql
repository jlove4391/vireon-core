-- Vireon CORE Prep Pass: Persona Identity Consolidation -- actor_name
-- uniqueness. resolvePersonaActorId() (src/elora/ingestUserMessage.ts)
-- resolves an actors row by (tenant_id, actor_name) alone, having dropped
-- the prior `hierarchy_tier = 'executive'` filter that was specific to
-- Elora. That query's correctness depends on (tenant_id, actor_name)
-- actually being unique -- previously true only by convention
-- (seedPersonaRoster.ts's own convergent insert logic), never enforced by
-- the database. This constraint closes that gap.
--
-- Confirmed no existing tenant has a duplicate actor_name before this
-- migration (checked directly against live data via the bootstrap role,
-- which bypasses RLS -- no tenant context is set at migration time, same
-- reasoning as 0002's and 0007's own data-normalizing steps).

ALTER TABLE actors ADD CONSTRAINT uq_actors_tenant_actor_name UNIQUE (tenant_id, actor_name);
