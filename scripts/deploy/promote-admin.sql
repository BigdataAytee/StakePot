-- Make an existing account staff.
--
-- There is no way to do this through the product, deliberately: a signup form
-- that can mint an administrator is a signup form that will. So the first staff
-- account is made by hand, against the database, by whoever holds the database.
--
--   psql "$DATABASE_URL" -v email=you@example.com -v role=admin \
--     -f scripts/deploy/promote-admin.sql
--
-- Note the values are unquoted: the file quotes them itself, which is what
-- makes a mangled invocation abort rather than match every row.
--
-- Sign up through the app first — this promotes an account, it does not create
-- one, and it will tell you if it found nobody.
--
-- Roles (§2.10): admin, resolver, support, risk, finance. `admin` is the one
-- that opens the console. Resolution still needs two different people to agree,
-- so a single admin account cannot settle a market alone — that is the point of
-- the rule and promoting yourself twice does not get round it.

\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';

-- `:'email'` and not `:email`.
--
-- The difference is the whole safety of this file. psql leaves an unset
-- variable in place, so a bare `:email` that never got substituted — a shell
-- that ate the quotes, a forgotten `-v` — reaches Postgres as the *column*
-- `email`, and `WHERE email = email` is true for every account with an address.
-- One quoting slip and the entire user table becomes staff.
--
-- The quoting form fails closed instead: unsubstituted, `:'email'` is a syntax
-- error and ON_ERROR_STOP aborts the file. Substituted, it is a correctly
-- escaped string literal, and `users.email` is unique, so it can match at most
-- one row by construction.
BEGIN;

UPDATE users SET role = :'role'::"UserRole" WHERE email = :'email';

SELECT
  CASE
    WHEN count(*) = 0 THEN 'no account with that email — sign up through the app first'
    ELSE 'promoted: ' || string_agg(email || ' → ' || role::text, ', ')
  END AS result
FROM users
WHERE email = :'email';

COMMIT;

-- Who is staff now. No addresses: this output goes to logs.
--
-- System accounts are counted apart. `sys_platform` and `sys_prize_pool` are
-- the ledger's counterparties — the platform's own book and the prize pool —
-- and they carry `role = admin` because every ledger entry needs a party. They
-- have no email, no phone and `!system-account-no-login!` where a password hash
-- would be, so nothing can log in as either. Lumped in with the real staff they
-- read as two administrators nobody created, which is alarming and wrong.
SELECT
  CASE WHEN status = 'system' THEN 'system (ledger counterparty, no login)' ELSE role::text END
    AS account,
  count(*)
FROM users
GROUP BY 1
ORDER BY 1;
