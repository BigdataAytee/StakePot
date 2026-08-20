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
   '{"Yes":"The CBN official window closing rate on the last business day of the month is below \u20a61,500/$.","No":"That rate is \u20a61,500/$ or above."}',
   '{"noPublication":"voids if the CBN does not publish a closing rate"}',
   NOW() + interval '11 days', NOW() + interval '18 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('wt-eagles', 'official',
   'Will the Super Eagles beat Ghana in the next qualifier?',
   'CAF', 'https://www.cafonline.com/',
   '{"Yes":"CAF publishes a full-time result with Nigeria ahead.","No":"Any other full-time result, including a draw."}',
   '{"abandoned":"voids if the match is abandoned before full time"}',
   NOW() + interval '5 days', NOW() + interval '12 days', 50000, 700, 'active', 'organic', 0, NOW()),

  ('wt-bbn', 'community',
   'Will this week''s BBNaija eviction be from the Sunday show?',
   'Africa Magic', 'https://africamagic.dstv.com/',
   '{"Yes":"The eviction is announced on the Sunday live show.","No":"The eviction is announced on any other night."}',
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

-- A price the naira market can actually draw.
--
-- The three fixtures above open at 50/50 with no history, which is honest for a
-- market nobody has traded — and useless for photographing the chart, the key
-- stats and the biggest-move line, all of which need a past. So one of the
-- three gets ten days of it. The other two stay untouched, because a screen
-- that only ever renders a busy market is a screen nobody has checked against
-- an empty one.
--
-- Guarded on the market rather than by id: `price_history` has a generated key,
-- so re-running would otherwise stack a second decade on top of the first.
INSERT INTO price_history ("marketId", "outcomeId", price, pot, ts)
SELECT
  'wt-naira',
  CASE WHEN side = 0 THEN 'wt-naira-yes' ELSE 'wt-naira-no' END,
  CASE WHEN side = 0 THEN yes ELSE 1 - yes END,
  round((12000 + i * 900)::numeric, 2),
  NOW() - interval '10 days' + (i * interval '6 hours')
FROM generate_series(0, 39) AS i,
     generate_series(0, 1) AS side,
     LATERAL (
       -- A walk with a story in it: drifts up, gaps hard on day six — that gap
       -- is what the "biggest move" line and the pinned news item describe —
       -- then settles into a range.
       SELECT round((
         0.42
         + 0.06 * sin(i / 4.0)
         + CASE WHEN i >= 24 THEN 0.17 ELSE 0 END
         + i * 0.0015
       )::numeric, 6) AS yes
     ) walk
WHERE NOT EXISTS (SELECT 1 FROM price_history WHERE "marketId" = 'wt-naira');

-- Backdate the market to match the history above. A market created a moment
-- ago with ten days of price behind it is not a state production can reach,
-- and leaving it that way would have the panel disagree with the chart.
UPDATE markets SET "createdAt" = NOW() - interval '10 days' WHERE id = 'wt-naira';

-- Read off the history rather than typed in beside it. Hard-coding both left
-- the ticket's headline at 66% while the chart it sits on ended at 62.9%, which
-- is precisely the kind of two-sources-of-truth mismatch these screens exist to
-- avoid — and it would have been photographed and shipped as a design.
UPDATE outcomes o
SET "priceCurrent" = latest.price
FROM (
  SELECT DISTINCT ON ("outcomeId") "outcomeId", price
  FROM price_history WHERE "marketId" = 'wt-naira'
  ORDER BY "outcomeId", ts DESC
) latest
WHERE o.id = latest."outcomeId" AND o."priceCurrent" = 0.5;

-- Pinned news, the kind the Market Studio writes.
--
-- These are the only annotations that carry a source and a name: the rest —
-- open, freeze, resolution — are events this platform generated itself and has
-- nobody to cite. The timestamp is the moment the thing happened, not the
-- moment somebody pinned it, because it also places the mark on the chart.
INSERT INTO market_annotations (id, "marketId", type, label, url, "pinnedBy", ts)
VALUES
  ('wt-naira-news-1', 'wt-naira', 'news',
   'CBN resumes dollar sales to BDCs, first time since March',
   'https://www.cbn.gov.ng/Out/2024/CCD/', 'Desk',
   NOW() - interval '4 days'),
  ('wt-naira-news-2', 'wt-naira', 'news',
   'Reserves close the week at $38.2bn, a nine-month high',
   'https://www.cbn.gov.ng/rates/', 'Desk',
   NOW() - interval '30 hours')
ON CONFLICT (id) DO NOTHING;
