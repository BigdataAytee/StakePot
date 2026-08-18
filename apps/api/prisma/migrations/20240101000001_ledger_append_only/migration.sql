-- Append-only enforcement for `ledger` and `admin_audit`.
--
-- Two layers, because either one alone has a gap:
--
--   1. REVOKE UPDATE, DELETE from the application role. This is the control the
--      architecture asks for, and it is the one an auditor can read off
--      `information_schema.role_table_grants`.
--   2. A trigger that raises on UPDATE or DELETE. Grants do not constrain a
--      table's *owner*, and in development the app usually connects as the
--      owner — so without this, the rule would quietly not apply where most of
--      the code gets written.
--
-- Corrections to the ledger are new rows. There is no other way to change it.

-- ---------------------------------------------------------------- application role

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stakeam_app') THEN
    CREATE ROLE stakeam_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO stakeam_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stakeam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stakeam_app;

-- Tables added by later migrations inherit the same baseline.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stakeam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stakeam_app;

-- ---------------------------------------------------------------- the revoke

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "ledger" FROM stakeam_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "admin_audit" FROM stakeam_app;

-- ---------------------------------------------------------------- the trigger

CREATE OR REPLACE FUNCTION stakeam_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Post a correcting row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON "ledger"
  FOR EACH ROW EXECUTE FUNCTION stakeam_reject_mutation();

CREATE TRIGGER admin_audit_append_only
  BEFORE UPDATE OR DELETE ON "admin_audit"
  FOR EACH ROW EXECUTE FUNCTION stakeam_reject_mutation();

-- TRUNCATE bypasses row-level triggers, so it gets its own statement-level one.
CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON "ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION stakeam_reject_mutation();

CREATE TRIGGER admin_audit_no_truncate
  BEFORE TRUNCATE ON "admin_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION stakeam_reject_mutation();
