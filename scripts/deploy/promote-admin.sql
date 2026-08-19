-- Make an existing account staff.
--
-- There is no way to do this through the product, deliberately: a signup form
-- that can mint an administrator is a signup form that will. So the first staff
-- account is made by hand, against the database, by whoever holds the database.
--
--   psql "$DATABASE_URL" -v email="'you@example.com'" -v role="'admin'" \
--     -f scripts/deploy/promote-admin.sql
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

UPDATE users SET role = :role::"UserRole" WHERE email = :email;

SELECT
  CASE
    WHEN count(*) = 0 THEN 'no account with that email — sign up through the app first'
    ELSE 'promoted: ' || string_agg(email || ' → ' || role::text, ', ')
  END AS result
FROM users
WHERE email = :email;
