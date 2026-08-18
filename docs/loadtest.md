# Load testing — the 10× election-night profile

**Status: written, not yet run. Pending a staging run.**

§12 requires "load tests simulating election-night spikes (target: 10× normal
peak) before every major event." The profile is written and committed at
`scripts/load/peak.js`. It has never been executed: k6 is a system install, not
an npm package, and it is absent from this development container and from CI.
Running it against staging is a launch-blocking item, owned by whoever operates
staging — see `docs/launch-checklist.md`.

Nothing in this document should be read as a performance claim. It describes an
experiment that has not happened yet.

## What "10× peak" means here

The assumed Phase 0 normal peak is ~50 trades/minute across the platform with a
few thousand people watching. The profile drives ten times that:

| Scenario   | Shape                 | Rate                                               |
| ---------- | --------------------- | -------------------------------------------------- |
| `traders`  | ramping arrival rate  | 60 → 150 → **500/min**, held 5 minutes, down to 60 |
| `watchers` | constant arrival rate | **2,000/min** for 9 minutes                        |

Election night is not evenly spread load. It is everybody piling into the same
three questions at once, so the profile concentrates the write storm on a
handful of hot markets rather than spreading it across the catalogue.

## What it is trying to prove, in order of importance

1. **Correctness under contention.** Every trade either fills or is _refused_.
   A 4xx is a valid answer — rate limits, RG limits, insufficient funds are all
   honest refusals. A 5xx on the money path fails the run outright.
2. **§11's read/write split.** Read latency stays flat _while_ the write storm
   runs, because reads never touch the write path. A million viewers are
   supposed to cost the trading engine nothing; this is the assertion.
3. **The per-market queue holds its ordering.** After the run, the market's
   `Σstaked === pot` invariant must still hold — checked by the six-hourly audit
   or on demand at `GET /admin/abuse/ledger-audit`. **This check is the most
   important line in this document**: latency numbers are a performance
   question, but a broken invariant after a burst is a correctness bug in the
   queue, and it is the one thing a load test can find that the unit tests
   cannot.

## Thresholds the run must meet

```
http_req_failed{scenario:traders}    rate < 0.01
http_req_duration{scenario:traders}  p95 < 800ms, p99 < 2000ms
http_req_duration{scenario:watchers} p95 < 300ms
checks                               rate > 0.99
```

These are targets, not measurements. They are set where a person waiting on
"Stake am" stops believing the button worked, and they should be revised
against real numbers once there are some — not the other way round.

## Running it

k6 is a system install: https://k6.io/docs/get-started/installation

The script needs a seeded environment — hot markets and a pool of funded Tier 1
accounts — passed in as JSON:

```bash
# tokens.json:  ["eyJhbGciOi…", …]                    (funded Tier 1 bearers)
# markets.json: [{"marketId":"…","outcomeIds":["…"]}] (the hot markets)

API_URL=https://staging.stakeam.ng \
TOKENS_FILE=./tokens.json \
MARKETS_FILE=./markets.json \
k6 run scripts/load/peak.js
```

Then, immediately after the run finishes:

```bash
curl -H "authorization: Bearer $STAFF_TOKEN" \
  https://staging.stakeam.ng/admin/abuse/ledger-audit
```

`clean: true` is the pass condition. A finding means the burst broke an
invariant, and that outranks every latency number in the k6 summary.

## Before the first real run

- **Point it at staging, never production.** It creates real trades in whatever
  database it reaches.
- **Expect rate-limit 429s and count them.** The limiter is deliberately in the
  path: 500 trades/minute spread across a small pool of accounts will trip
  per-user budgets, which is the limiter working. If the refusal rate is high
  enough to hide a real failure, widen the account pool rather than raising the
  limits.
- **Watch the queue depth, not just latency.** §11's design absorbs a burst as
  stream entries rather than held database connections; a run that stays fast
  while the stream backs up unboundedly has found a different problem.
- **Record what the environment was.** Instance sizes, replica count, Redis and
  Postgres configuration. A p95 without a machine attached to it is not a
  measurement.
