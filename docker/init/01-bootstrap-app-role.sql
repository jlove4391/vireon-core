-- Runs once, as the Postgres bootstrap superuser, when the named volume is
-- first initialized (docker-entrypoint-initdb.d semantics).
--
-- Why this exists: the Docker Postgres image always makes POSTGRES_USER a
-- cluster superuser via initdb, and PostgreSQL superusers unconditionally
-- bypass row-level security -- ALTER TABLE ... FORCE ROW LEVEL SECURITY has
-- no effect on an actual superuser (only on non-superuser table owners).
-- If the application's DATABASE_URL connected as that same bootstrap
-- superuser, every RLS policy in migrations/0001_core_foundation.sql would
-- silently never apply. This script creates a separate, non-superuser
-- `vireon` role -- the one DATABASE_URL actually authenticates as -- so
-- tenant isolation is enforced for every real runtime connection, not just
-- ones a coding agent happens to test with.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vireon') THEN
        CREATE ROLE vireon LOGIN PASSWORD 'vireon';
    END IF;
END
$$;

ALTER DATABASE vireon_core OWNER TO vireon;
GRANT ALL PRIVILEGES ON DATABASE vireon_core TO vireon;
GRANT ALL ON SCHEMA public TO vireon;
