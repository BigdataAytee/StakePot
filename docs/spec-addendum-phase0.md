# Phase 0 — spec reconciliation

**Superseded.** `platform-architecture.md` and `market-rulebook.md` are the
source of truth and are in this directory. Phase 0 was built from an interim
addendum before they arrived; this file records what changed when the real
documents landed, what the v2 revision moved, and what is still open.

## What the first full docs changed

Four items. Everything else in the addendum matched §2.3, §3 and §7.4 exactly —
including every engine formula, which needed no change.

| #   | Found in | Change                                                                                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §2.2     | The points currency is **`SPC`** (SPcoin), not `PTS`. Enum renamed in migration `20240101000002`.                                                                                                             |
| 2   | §3       | **`leaderboard_snapshots`** was missing from the addendum's table list. Added.                                                                                                                                |
| 3   | §7.4     | **SPcoin** is a specified object, not a label: gold radial gradient `#F6C453 → #E3A81C → #B8860B` on a `#0A5A2D` face, 18px inline / 48px+ full. Added to tokens; `spcoin.svg` shipped to `apps/web/public/`. |
| 4   | §7.4     | Two motion values the addendum omitted: chart line draws in over **600ms** once on ticket-view open, buttons depress to **0.97**. Added.                                                                      |

The `ledger` table also keeps its `fundClass` column, which §3 does not list. The
addendum specified it and §2.10's fund tagging depends on it, so it stays — the
addendum is a superset here, not a contradiction.

## What the v2 specs changed

The second kit answered both fee questions outright and moved the numbers.

| Area            | Before                                                   | Now (v2)                                                                         |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fee basis       | pot (§2.3) vs losing pool (Rulebook §10) — contradictory | **The losing pool**, in both docs                                                |
| Official fee    | 1.5% per trade _or_ ~2% at resolution                    | **3% of the losing pool at resolution. No per-trade fees on buying.**            |
| Community fee   | 3% (2 platform / 1 creator)                              | **7% (4 creator / 3 platform)**                                                  |
| Early-exit fee  | optional 0–0.5%, default **off**                         | **1% of sale proceeds, ON by default**, config 0–2%, credited to `platform_fees` |
| Creator L3 perk | fee bump 1% → 1.25%                                      | fee bump 4% → 4.5%                                                               |

Three consequences for the code, all landed:

1. **`resolve()` charges the losing pool.** `MarketState` now tracks `staked[]`
   — money in per outcome, net of exits — because the cost curve does not
   segregate money by outcome. `losingPool = pot − staked[w]`. A new invariant,
   `Σstaked === pot`, is asserted on every operation and covered by the property
   suite; without it the losing pool would not be a well-defined quantity.
2. **The early-exit fee is on by default at 1%**, ceiling raised to 2%. The
   Phase 0 decision to withhold it from the seller rather than take it from the
   pot is exactly what v2 specifies ("credited to `platform_fees`").
3. **`splitResolutionFee()`** divides a fee into creator and platform legs, with
   the platform leg computed as the remainder so the two always sum to the fee
   exactly. Dividing twice is how money goes missing a kobo at a time.

### `pricing_sim.py` is now behind the spec

The reference simulation computes `fee = pot * fee_rate`, which was correct when
it was written and is not any more. Its headline claim — platform cost of
exactly zero — is about _conservation_ and still holds, because `distributable =
pot − fee` whatever the fee is charged on. Only the split between fee and
payouts moved.

Left unedited, per `scripts/README.md`: the sims are the reference, not
something to bring into line with the TypeScript. The divergence is pinned in
`packages/engine/src/__tests__/pricing-sim.test.ts` so it stays visible.

## Storage quantum (step 2)

`pot === C(q) − C(q0)` is exact in the engine's arithmetic. It is not exact once
the market lives in a database, and that is not a bug in either place: share
counts come out of `ln` and `exp`, so no finite column scale holds them exactly,
and the pot is money that has to quantise to a payable amount. Something has to
absorb the difference.

`MarketState.quantum` names it. Zero for a market held in memory, where the
identities are exact; `1e-18` for one loaded from `Decimal(38,18)` columns. The
invariant then bounds a round trip through storage instead of tripping on it,
while staying sixteen orders of magnitude below one kobo.

Two things are kept exact rather than tolerated, because they can be:
`potTotal` moves by the same database-side increment as `stakedTotal`, and
`positions.shares` by the same increment as `outcomes.sharesOutstanding` — two
exact Postgres additions of one value always agree, where the same sum computed
in JavaScript and written back would not.

## Path B, syndicates and bonds (step 7)

**The symmetric seed is one closed-form step, not a loop of buys.** Adding the
same δ to every outcome factors straight out of the log-sum —
`C(q + δ·1) = δ + C(q)` — so granting δ shares of every outcome costs exactly δ
and moves **no price at all**. Buying `perOutcome` into each side in turn would
cost the same money but leave the book tilted, and would hand the last outcome
bought a better price than the first: the result would depend on the order the
outcomes happened to be listed in. `seed()` is therefore its own engine
operation, with the closed form and its own property coverage.

With prices flat at `1/n`, δ shares of each outcome divides into exactly `δ/n`
of money per outcome, so the rulebook's unit — "at least [20,000] into **each**
pool" — maps onto `perOutcome`, and `δ = perOutcome × n`.

**The seed requires an untraded market**, enforced in the engine. "Equal money
in every pool" and "equal shares of every outcome" are the same statement only
while prices are flat; on a traded book they diverge and Part 3 §2 does not say
which it means. It never has to — a seed is posted before the market opens.

**The syndicate fee split is stored in two places, deliberately.** The
organiser's cut lives on `syndicates.organiserBps`, locked when the round opens
(§3: "displayed on the market page before any sponsor joins and is locked once
the Seeding Round opens"). Each sponsor's pro-rata share lands on
`syndicate_members.feeSharePct` when the round _fills_, because pro-rata is not
knowable until the round is closed. At resolution the organiser's cut comes off
first and the remainder is divided on those shares, with the last leg computed
as the remainder so the legs sum to the creator fee exactly.

**A conduct bond sits in the creator's escrow, and resolution has to release it
as its own leg.** This was latent: `escrow` for a market includes the bond, but
the pot does not, so a resolution that released everyone's escrow and paid out
the pot would be short by exactly the bond and the ledger would refuse the whole
transaction. Part 3 §5 asks for the bond back after a clean resolution, which is
the same leg — so the rule and the arithmetic want the identical thing.
Resolution now reads escrow balances from the ledger rather than from positions,
which also covers a creator who holds no position at all.

**A seed is liquidity, not interest.** Seed legs are recorded as trades with
`side = 'seed'` and excluded everywhere a _stake_ is counted: the Path A funding
floors, Path B's participation floor, the ticket's trader count and its 24h
volume. Otherwise a creator could seed their own market into looking busy.

## Still open

**The §2.3 liquidity tuning rule understates price impact by 1/p.** Unchanged in
v2. §2.3 gives the impact of a stake as `m·p(1−p)/L` and works it as "₦2,000
stakes → L=50,000 gives ~1-point moves". But `p(1−p)/L` is `dp/dq` —
sensitivity per _share_. Money `m` buys about `m/p` shares, so the
money-denominated impact is `m(1−p)/L`, **twice** the quoted figure at even
odds. The engine agrees with the corrected form: the doc's own worked example
moves the price **1.96 points, not 1**. For ~1-point moves at even odds, `L`
wants to be ≈ **50× the typical stake**, not 25×. Locked in as a test.

**The stored ledger balances to within one storage quantum per row, not to
zero.** Every transaction is asserted balanced at 40 significant digits _before_
it is written, and the columns then hold 18 decimal places — so a payout that
does not land on that scale is rounded on the way in, and the sum of what is
stored can sit ~1e-18 SPC off zero. Sixteen orders of magnitude below one kobo,
and the same for trades as for resolutions, so this is a property of the whole
money path rather than of step 7. Before real money, decide whether amounts
should be quantised to the storage scale _before_ `assertBalanced` runs — which
would force every caller to allocate its own remainder, and make "the ledger
sums to exactly zero as stored" true rather than nearly true.

**Can `staked[i]` go negative?** Not observed across the property runs, and it
would take holders of one outcome collectively extracting more than was ever
staked on it. It is not _proven_ impossible, so `losingPool` is computed rather
than assumed non-negative, and the suite asserts `fee ≤ pot` directly.

## Implementation decisions taken where the spec left a gap

- **The exit fee is withheld from the seller, not taken from the pot.** The pot
  gives up the full refund `r`; the fee is booked to platform fees. Taking it
  from the pot would break `pot === C(q) − C(q0)`, the identity §2.3 calls
  "a mathematical identity, not a cap check".
- **Invariant slack is scaled to the market**, not the pot. The identity
  subtracts two numbers the size of `L` and `q`, and a fully exited market has a
  near-zero pot after millions have traded through it. At 40 significant digits
  this lands near 1e-24 on a ₦2.5m book — twenty-two orders of magnitude below
  one kobo, so a real discrepancy still trips it.
- **`resolve()` refuses incomplete holdings.** Conservation only holds if the
  supplied holdings account for every outstanding winning share, so a seeded
  market must attribute its `q0` shares to somebody.
- **`price_history`** takes a `BigInt` identity key rather than a cuid: it is
  high-volume time series and nothing links to it by id.
- **Enums** exist only where the spec enumerated values. `users.status`,
  `disputes.state`, `squads.screeningState` and `support_tickets.category` are
  `String` until §3 pins them down. `syndicates.state` became an enum in step 7,
  when the seeding round's lifecycle (`open → filled | refunded`) was actually
  implemented — the column is converted in place rather than dropped and
  recreated, because it decides whether contributions get refunded.
- **`syndicate_members`** gained a unique constraint on `(syndicateId, userId)`.
- **`ledger` and `admin_audit` are append-only** via both a `REVOKE UPDATE,
DELETE` from the `stakeam_app` role and a trigger. The revoke is the control
  §10 asks for; the trigger is there because grants do not constrain a table's
  owner, and in development the app usually connects as the owner. CI proves the
  rule binds against a live Postgres.
