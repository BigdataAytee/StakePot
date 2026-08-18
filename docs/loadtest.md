# Load testing — the 10× election-night profile

**Status: run and passing on a development container. Still pending a staging
run** — see "What this run does not tell you" below.

§12 requires "load tests simulating election-night spikes (target: 10× normal
peak) before every major event." The profile lives at `scripts/load/peak.js`,
its fixture at `scripts/load/seed-peak.sh`.

## Results — 18 Aug 2026, development container

Full 9-minute profile, 30 funded Tier 1 accounts, 3 hot markets.

| Measure                        | Threshold | Result                   |
| ------------------------------ | --------- | ------------------------ |
| Trades accepted                | > 90%     | **100%** (3,534 / 3,534) |
| Money path 5xx                 | 0         | **0**                    |
| Trade latency p95              | < 800ms   | **64ms**                 |
| Read latency p95               | < 300ms   | **9.6ms**                |
| Checks                         | > 99%     | **100%** (25,068)        |
| Ledger audit after the run     | clean     | **clean**                |
| `pot − Σstaked` per hot market | 0         | **exactly 0**            |

The last two lines matter more than the latencies. Three markets took 3,534
concurrent trades through the §11 queue and the pot identity came out at
**exactly zero difference** on all three — the ordering guarantee holding under
ten times peak, measured rather than argued.

## What the run found

Running it was worth it twice over. Both of these were invisible to every unit
test and to the walkthrough:

**1. Markets bricked permanently after a few hundred trades.** Shares were
stored at the money scale (18 dp). Every write truncated the share vector,
moving `C(q)` by up to one quantum in a consistent direction — once per trade.
The pot identity's tolerance bounds a _single_ round trip through storage, so
after roughly 250 trades the accumulated drift exceeded it and the market began
refusing every trade with `pot identity violated`. Permanently: the state that
fails the check is the state on disk, so nothing after it could succeed either.
The first run showed 85% of trades refused. Fixed by storing shares at 30 dp
(migration `20240101000015_share_scale`), which pushes the same accumulation out
to the order of 10^12 trades; pinned by
`packages/engine/src/__tests__/storage-drift.test.ts`.

**2. A per-IP trade limit of 120/minute throttled the platform to a quarter of
target peak.** Every trade in the run came from one address, and the per-IP
budget capped it long before the per-user budgets were touched. That is not a
test artefact: most Nigerian mobile traffic arrives through carrier-grade NAT,
so an entire MTN or Airtel pool presents as a handful of addresses. An IP budget
on an authenticated money path does not throttle an attacker, it throttles
Lagos. The IP budgets are gone from `trade` and `comment` — both authenticated,
both NAT-prone — and remain on `auth`, where there is no account to key on yet
and where credential stuffing actually lives.

## What this run does not tell you

- **It is a development container, not staging.** One process, one Postgres, one
  Redis, no replicas, no load balancer, no network between tiers. The latency
  numbers are a lower bound and should not be quoted as capacity.
- **30 accounts, 3 markets.** Real election-night concurrency is thousands of
  accounts; per-user rate limits and per-market queue contention both behave
  differently at that shape.
- **No sustained-hours run.** Nine minutes finds arithmetic drift; it does not
  find leaks, connection exhaustion or disk growth.

It must still run against staging before any real event.

## The profile

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

`scripts/load/seed-peak.sh` builds the fixture — hot markets and a pool of
funded Tier 1 accounts — and writes `tokens.json` and `markets.json` where the
profile looks for them:

```bash
./scripts/dev/ensure-services.sh
ACCOUNTS=30 ./scripts/load/seed-peak.sh
API_URL=http://localhost:3001 k6 run scripts/load/peak.js
```

Against staging, point both at it:

```bash
API_URL=https://staging.stakeam.ng ./scripts/load/seed-peak.sh
API_URL=https://staging.stakeam.ng k6 run scripts/load/peak.js
```

**Re-seed before every run.** The API's integration suite resets the same test
database, so a fixture from an earlier session may no longer exist — and a run
against markets that have been deleted 404s every request while still reporting
no 5xx. The profile's `trade was accepted` check exists to catch exactly that.

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
