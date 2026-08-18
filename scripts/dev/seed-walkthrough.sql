-- Fixtures for the §7 walkthrough: enough of a catalogue that both shelves have
-- something on them and the ticket has a real question to render.
--
-- Deliberately SQL rather than the API: official markets open through an
-- admin's click on an AI draft and community ones need the wizard, neither of
-- which is what the walkthrough is exercising at this point. The trading,
-- resolution and payout paths that follow are all driven through the product.

-- Idempotent by insert, not by delete. Once a market has been traded on, its
-- ledger rows reference it, and deleting it asks Postgres to null those out —
-- which the append-only rule refuses, correctly. So the fixtures are added if
-- absent and left alone if present.

INSERT INTO markets
  (id, shelf, question, "sourceName", "sourceUrl", "criteriaJson", "edgeCasesJson",
   "eventDate", "voidDate", "liquidityParam", "feeBps", state, "activationPath",
   "potTotal", "createdAt")
VALUES
  ('wt-naira', 'official',
   'Will the naira close below ₦1,500/$ on the official window this month?',
   'CBN', 'https://www.cbn.gov.ng/rates/',
   '{"settles":"CBN official window closing rate on the last business day of the month"}',
   '{"noPublication":"voids if the CBN does not publish a closing rate"}',
   NOW() + interval '11 days', NOW() + interval '18 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('wt-eagles', 'official',
   'Will the Super Eagles beat Ghana in the next qualifier?',
   'CAF', 'https://www.cafonline.com/',
   '{"settles":"Full-time result as published by CAF"}',
   '{"abandoned":"voids if the match is abandoned before full time"}',
   NOW() + interval '5 days', NOW() + interval '12 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('wt-bbn', 'community',
   'Will this week''s BBNaija eviction be from the Sunday show?',
   'Africa Magic', 'https://africamagic.dstv.com/',
   '{"settles":"The eviction announced on the Sunday live show"}',
   '{"noEviction":"voids if there is no eviction this week"}',
   NOW() + interval '4 days', NOW() + interval '11 days', 30000, 700, 'active', 'organic', 0, NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO outcomes (id, "marketId", label, ordinal, "sharesOutstanding", "priceCurrent", "stakedTotal", "isOther")
VALUES
  ('wt-naira-yes', 'wt-naira',  'Yes', 0, 0, 0.5, 0, false),
  ('wt-naira-no',  'wt-naira',  'No',  1, 0, 0.5, 0, false),
  ('wt-eagles-yes','wt-eagles', 'Yes', 0, 0, 0.5, 0, false),
  ('wt-eagles-no', 'wt-eagles', 'No',  1, 0, 0.5, 0, false),
  ('wt-bbn-yes',   'wt-bbn',    'Yes', 0, 0, 0.5, 0, false),
  ('wt-bbn-no',    'wt-bbn',    'No',  1, 0, 0.5, 0, false)
ON CONFLICT (id) DO NOTHING;
