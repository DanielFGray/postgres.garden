BEGIN;
GRANT CONNECT ON DATABASE :DATABASE_NAME TO :DATABASE_OWNER;

-- `graphile-migrate reset` revokes CONNECT from PUBLIC. Login roles reach the database through
-- membership in the visitor role (the authenticator pattern), and a NOINHERIT member does not
-- inherit the visitor role's CONNECT, so grant it to each member directly.
DO $$
DECLARE
  login_role name;
BEGIN
  FOR login_role IN
    SELECT pg_get_userbyid(member) FROM pg_auth_members WHERE roleid = ':DATABASE_VISITOR'::regrole
  LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), login_role);
  END LOOP;
END $$;

GRANT ALL ON DATABASE :DATABASE_NAME TO :DATABASE_OWNER;
ALTER SCHEMA public OWNER TO :DATABASE_OWNER;

-- Some extensions require superuser privileges, so we create them before migration time.
CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;
COMMIT;
