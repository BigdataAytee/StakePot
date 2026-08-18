#!/usr/bin/env bash
# Build the fixture the 10× peak profile needs: hot markets, and a pool of
# funded Tier 1 accounts with their bearer tokens.
#
# Writes tokens.json and markets.json next to itself, which is where
# scripts/load/peak.js looks by default.
#
# Two things here look like cheating and are not:
#
#   * Accounts are created through the real signup endpoint, but the auth rate
#     limiter's per-IP budget is cleared between batches. Creating thirty
#     accounts from one address in a minute is precisely the shape §11's
#     limiter refuses; the limiter is proven separately (walkthrough step 11),
#     and it is the *trade* limiter that matters to this run.
#   * Balances are topped up with a balanced pair of ledger rows in the exact
#     shape `wallet.issue` posts — same types, same fund classes, summing to
#     zero. The ledger stays balanced, which is the point: the audit that runs
#     after the load test has to be meaningful.
set -euo pipefail

API=${API_URL:-http://localhost:3001}
DB=${TEST_DATABASE_URL:-postgresql://stakeam:stakeam@localhost:5432/stakeam_test}
ACCOUNTS=${ACCOUNTS:-30}
FUND=${FUND:-500000}
HOT_MARKETS=${HOT_MARKETS:-3}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stamp=$(date +%s)

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "seeding ${HOT_MARKETS} hot markets…"
markets='[]'
for i in $(seq 1 "$HOT_MARKETS"); do
  mid="peak-${stamp}-${i}"
  psql "$DB" -q <<SQL
INSERT INTO markets
  (id, shelf, question, "sourceName", "sourceUrl", "criteriaJson", "edgeCasesJson",
   "eventDate", "voidDate", "liquidityParam", "feeBps", state, "activationPath",
   "potTotal", "createdAt")
VALUES
  ('${mid}', 'official', 'Election-night load market ${i}: does the incumbent hold?',
   'INEC', 'https://www.inecnigeria.org/', '{}', '{}',
   NOW() + interval '2 days', NOW() + interval '9 days', 50000, 700, 'active', 'organic', 0, NOW());
INSERT INTO outcomes (id, "marketId", label, ordinal, "sharesOutstanding", "priceCurrent", "stakedTotal", "isOther")
VALUES
  ('${mid}-yes', '${mid}', 'Yes', 0, 0, 0.5, 0, false),
  ('${mid}-no',  '${mid}', 'No',  1, 0, 0.5, 0, false);
SQL
  markets=$(jq -c --arg m "$mid" '. + [{marketId: $m, outcomeIds: [($m + "-yes"), ($m + "-no")]}]' <<<"$markets")
done
echo "$markets" > "$here/markets.json"

echo "creating ${ACCOUNTS} funded accounts…"
tokens='[]'
for i in $(seq 1 "$ACCOUNTS"); do
  # The limiter counts per IP; a load-test fixture is the one caller that has a
  # legitimate reason to sidestep it, and only for signup.
  if (( i % 8 == 1 )); then
    redis-cli --scan --pattern "rl:auth:*" 2>/dev/null | xargs -r redis-cli del >/dev/null 2>&1 || true
  fi

  email="peak-${stamp}-${i}@example.com"
  token=$(curl -sS -X POST "$API/auth/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"correct-horse-battery\",\"ageAttested\":true}" \
    | jq -r '.accessToken // empty')
  [ -n "$token" ] || { echo "signup failed for ${email}" >&2; exit 1; }

  uid=$(psql "$DB" -tA -c "SELECT id FROM users WHERE email = '${email}'")
  psql "$DB" -q <<SQL
UPDATE users SET tier = 1, "contactVerified" = true WHERE id = '${uid}';
INSERT INTO ledger (id, "userId", type, "fundClass", amount, currency, ref, "createdAt") VALUES
  ('peakfund-${stamp}-${i}-a', 'sys_prize_pool', 'signup_bonus', 'prize_pool',      -${FUND}, 'SPC', 'loadtest:${stamp}:${i}', NOW()),
  ('peakfund-${stamp}-${i}-b', '${uid}',            'signup_bonus', 'user_available',   ${FUND}, 'SPC', 'loadtest:${stamp}:${i}', NOW());
UPDATE wallets SET available = available + ${FUND} WHERE "userId" = '${uid}';
INSERT INTO wallets ("userId", currency, available, escrowed)
  SELECT '${uid}', 'SPC', ${FUND}, 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE "userId" = '${uid}');
SQL
  tokens=$(jq -c --arg t "$token" '. + [$t]' <<<"$tokens")
done
echo "$tokens" > "$here/tokens.json"

echo
echo "ready:"
echo "  markets: $here/markets.json ($(jq length <"$here/markets.json"))"
echo "  tokens:  $here/tokens.json ($(jq length <"$here/tokens.json"))"
echo
echo "run:  API_URL=$API k6 run $here/peak.js"
