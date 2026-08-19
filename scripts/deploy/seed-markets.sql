-- Open the launch catalogue on a fresh deployment.
--
-- A deployed StakeAm with an empty database is a dead end: both shelves say
-- "Nothing open here yet", there is no ticket to open, and nothing a new
-- account can do with its starter balance. Migrations deliberately do not seed
-- markets — a migration that invents tradeable questions on every deploy is a
-- migration that can invent them into production — so opening the first ones is
-- a decision somebody makes, once, with this file.
--
--   psql "$DATABASE_URL" -f scripts/deploy/seed-markets.sql
--
-- On Render: the database's page → Connect → PSQL Command, then paste the
-- contents. Safe to run twice; it inserts what is missing and leaves the rest.
--
-- Dates are relative to NOW(), so these are never stale on the day they are
-- opened. They are also *examples with real sources* rather than placeholders:
-- every one names the body that settles it, because §2.5 refuses to open a
-- market that cannot say who decides.
--
-- Read them before you run this. These become the first thing anybody sees.

-- Stop at the first error rather than ploughing on. Without this, psql reports
-- each failure and carries on to the next statement, so a run that inserted
-- nothing looks a lot like a run that worked — which is how a seed came to be
-- "run" against a database that stayed empty.
\set ON_ERROR_STOP on

-- The questions contain ₦ and typographic quotes. A client whose encoding is
-- not UTF-8 — a Windows console at its default code page, most commonly —
-- refuses those bytes and every INSERT below fails with them. Declaring it here
-- means the file carries its own requirement rather than depending on whoever
-- runs it.
SET client_encoding = 'UTF8';

-- All six or none. A half-seeded catalogue is worse than an empty one: the
-- shelves look stocked and the missing markets are invisible.
BEGIN;

INSERT INTO markets
  (id, shelf, question, "sourceName", "sourceUrl", "criteriaJson", "edgeCasesJson",
   "eventDate", "voidDate", "liquidityParam", "feeBps", state, "activationPath",
   "potTotal", "createdAt")
VALUES
  ('launch-naira-window', 'official',
   'Will the naira close below ₦1,500/$ on the official window this month?',
   'CBN', 'https://www.cbn.gov.ng/rates/',
   '{"settles":"The CBN official window closing rate on the last business day of this month"}',
   '{"noPublication":"Voids if the CBN publishes no closing rate for that day"}',
   NOW() + interval '21 days', NOW() + interval '28 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('launch-eagles-qualifier', 'official',
   'Will the Super Eagles win their next qualifier?',
   'CAF', 'https://www.cafonline.com/',
   '{"settles":"Full-time result of Nigeria''s next competitive qualifier as published by CAF"}',
   '{"abandoned":"Voids if the match is abandoned before full time","postponed":"Rolls to the rescheduled date if postponed"}',
   NOW() + interval '14 days', NOW() + interval '21 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('launch-petrol-price', 'official',
   'Will petrol sell below ₦900 a litre in Lagos at the end of this month?',
   'NNPC', 'https://nnpcgroup.com/',
   '{"settles":"The NNPC retail pump price published for Lagos on the last day of this month"}',
   '{"noPublication":"Voids if no Lagos pump price is published for that day"}',
   NOW() + interval '25 days', NOW() + interval '32 days', 40000, 700, 'active', 'organic', 0, NOW()),

  ('launch-inflation', 'official',
   'Will headline inflation come in below 30% in the next NBS release?',
   'NBS', 'https://nigerianstat.gov.ng/',
   '{"settles":"The year-on-year headline inflation rate in the next NBS Consumer Price Index report"}',
   '{"delayed":"Waits for the release if the NBS publishes late; voids if it is not published within 30 days of the due date"}',
   NOW() + interval '18 days', NOW() + interval '30 days', 40000, 700, 'active', 'organic', 0, NOW()),

  ('launch-afrobeats-chart', 'community',
   'Will a Nigerian artist top the Apple Music Nigeria chart at the end of this week?',
   'Apple Music', 'https://music.apple.com/ng/browse',
   '{"settles":"The number one song on the Apple Music Nigeria Top 100 at 23:59 WAT on Sunday"}',
   '{"unavailable":"Voids if the chart is not published for that day"}',
   NOW() + interval '6 days', NOW() + interval '13 days', 30000, 700, 'active', 'organic', 0, NOW()),

  ('launch-epl-nigerian', 'community',
   'Will a Nigerian player score in the Premier League this weekend?',
   'Premier League', 'https://www.premierleague.com/',
   '{"settles":"Any goal credited to a Nigeria-eligible player in a Premier League fixture this weekend, per the official Premier League match centre"}',
   '{"ownGoal":"An own goal does not count","noFixtures":"Voids if no fixtures are played"}',
   NOW() + interval '5 days', NOW() + interval '12 days', 30000, 700, 'active', 'organic', 0, NOW())
ON CONFLICT (id) DO NOTHING;

-- Both sides at even money. The engine moves them from the first trade onward;
-- these are the opening prices, not an opinion.
INSERT INTO outcomes (id, "marketId", label, ordinal, "sharesOutstanding", "priceCurrent", "stakedTotal", "isOther")
VALUES
  ('launch-naira-window-yes',     'launch-naira-window',     'Yes', 0, 0, 0.5, 0, false),
  ('launch-naira-window-no',      'launch-naira-window',     'No',  1, 0, 0.5, 0, false),
  ('launch-eagles-qualifier-yes', 'launch-eagles-qualifier', 'Yes', 0, 0, 0.5, 0, false),
  ('launch-eagles-qualifier-no',  'launch-eagles-qualifier', 'No',  1, 0, 0.5, 0, false),
  ('launch-petrol-price-yes',     'launch-petrol-price',     'Yes', 0, 0, 0.5, 0, false),
  ('launch-petrol-price-no',      'launch-petrol-price',     'No',  1, 0, 0.5, 0, false),
  ('launch-inflation-yes',        'launch-inflation',        'Yes', 0, 0, 0.5, 0, false),
  ('launch-inflation-no',         'launch-inflation',        'No',  1, 0, 0.5, 0, false),
  ('launch-afrobeats-chart-yes',  'launch-afrobeats-chart',  'Yes', 0, 0, 0.5, 0, false),
  ('launch-afrobeats-chart-no',   'launch-afrobeats-chart',  'No',  1, 0, 0.5, 0, false),
  ('launch-epl-nigerian-yes',     'launch-epl-nigerian',     'Yes', 0, 0, 0.5, 0, false),
  ('launch-epl-nigerian-no',      'launch-epl-nigerian',     'No',  1, 0, 0.5, 0, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- What is now on the shelves. If this prints nothing, nothing was inserted.
SELECT shelf, count(*) AS markets FROM markets WHERE state = 'active' GROUP BY shelf;
SELECT count(*) AS total_markets FROM markets;
