// k6 election-night profile — `pnpm test:load:peak`.
//
// §12: "load tests simulating election-night spikes (target: 10× normal peak)
// before every major event." The assumed normal peak for a Phase 0 launch is
// ~50 trades/minute across the platform with a few thousand watchers; this
// script drives ten times that — 500 trades/minute concentrated on a handful of
// hot markets, alongside a reader storm — because election night is not evenly
// spread load, it is everybody piling into the same three questions at once.
//
// What it proves, in order of importance:
//   1. Correctness under contention: every trade 200/201s or is *refused* —
//      a 5xx on the money path fails the run outright.
//   2. §11's backpressure: p95 trade latency stays sane while the read storm
//      runs, because reads never touch the write path.
//   3. The per-market queue orders the hot market: after the run, the market's
//      Σstaked === pot check (the nightly audit, or the /admin/abuse/ledger-audit
//      endpoint) must come back clean — run it after this script finishes.
//
// Setup: needs a running stack and a seed script that creates the hot markets
// and a pool of funded accounts, then writes their tokens to stdin/env:
//   API_URL=http://localhost:3001 \
//   TOKENS_FILE=./tokens.json MARKETS_FILE=./markets.json \
//   k6 run scripts/load/peak.js
//
// k6 is a system install (not npm): https://k6.io/docs/get-started/installation

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.API_URL || 'http://localhost:3001';

// Funded Tier 1 accounts' bearer tokens, one per line or a JSON array.
const tokens = new SharedArray('tokens', () =>
  JSON.parse(open(__ENV.TOKENS_FILE || './tokens.json')),
);
// { marketId, outcomeIds: [..] } for each hot market.
const markets = new SharedArray('markets', () =>
  JSON.parse(open(__ENV.MARKETS_FILE || './markets.json')),
);

// A refusal is not a failure.
//
// k6 counts every non-2xx/3xx toward `http_req_failed`, which would make the
// rate-limit 429s and the RG refusals this run deliberately provokes look like
// the platform breaking. The threshold below is meant to catch 5xx — the
// platform failing — so the expected-status range is widened to say exactly
// that. Without this the run either fails on working controls or the threshold
// has to be loosened until it stops meaning anything.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const options = {
  scenarios: {
    // 10× peak on the write path: ~500 trades/minute, ramping like a kickoff.
    traders: {
      executor: 'ramping-arrival-rate',
      exec: 'trade',
      startRate: 60,
      timeUnit: '1m',
      preAllocatedVUs: 60,
      maxVUs: 200,
      stages: [
        { target: 150, duration: '1m' }, // polls close, people arrive
        { target: 500, duration: '2m' }, // the result rumour hits the group chats
        { target: 500, duration: '5m' }, // sustained peak
        { target: 60, duration: '1m' }, // it settles down
      ],
    },
    // The reader storm: prices, thread, leaderboard. §11 says a million viewers
    // cost the trading engine nothing; this is the assertion at 10× read peak.
    watchers: {
      executor: 'constant-arrival-rate',
      exec: 'watch',
      rate: 2_000,
      timeUnit: '1m',
      duration: '9m',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    // 5xx only — see the response callback above.
    'http_req_failed{scenario:traders}': ['rate<0.01'],
    'http_req_duration{scenario:traders}': ['p(95)<800', 'p(99)<2000'],
    // Reads stay fast *while* the write storm runs — the whole point of §11.
    'http_req_duration{scenario:watchers}': ['p(95)<300'],
    checks: ['rate>0.99'],
    // Most trades must fill or queue, not merely fail politely. Below 1.0
    // because rate-limit and RG refusals are legitimate answers under load.
    'checks{check:trade was accepted}': ['rate>0.90'],
  },
};

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

export function trade() {
  const token = pick(tokens);
  const market = pick(markets);
  const outcomeId = pick(market.outcomeIds);

  const res = http.post(
    `${BASE_URL}/trades`,
    JSON.stringify({
      marketId: market.marketId,
      outcomeId,
      side: 'buy',
      // Small, human-sized stakes: the storm is many people, not one whale.
      amount: String(100 + Math.floor(Math.random() * 900)),
      requestId: `k6-${__VU}-${__ITER}-${Date.now()}`,
    }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { scenario: 'traders' },
    },
  );

  check(res, {
    // 200 filled, 202 queued (§11's "order placed"), 4xx an honest refusal
    // (limits, RG, funds). A 5xx on the money path is the failure.
    'money path never 5xxs': (r) => r.status < 500,
    // And the run has to actually trade. A fixture pointing at markets that no
    // longer exist 404s every request, which satisfies "never 5xxs" while
    // proving nothing — a whole run once looked green that way. The threshold
    // below turns that into a failure.
    'trade was accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });
}

export function watch() {
  const market = pick(markets);
  const which = Math.random();

  const res =
    which < 0.6
      ? http.get(`${BASE_URL}/markets/${market.marketId}`, { tags: { scenario: 'watchers' } })
      : which < 0.85
        ? http.get(`${BASE_URL}/markets/${market.marketId}/thread`, {
            tags: { scenario: 'watchers' },
          })
        : http.get(`${BASE_URL}/leaderboard`, { tags: { scenario: 'watchers' } });

  check(res, { 'read path answers': (r) => r.status === 200 });
  sleep(0.1);
}
