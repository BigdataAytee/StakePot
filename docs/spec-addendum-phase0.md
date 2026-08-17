# Phase 0 — spec reconciliation

**Superseded.** `platform-architecture.md` and `market-rulebook.md` are now in
this directory and are the source of truth. Phase 0 was built from an interim
addendum before they arrived; this file records what that produced, what changed
when the real documents landed, and what is still open.

## What the full docs changed

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

## Open questions for whoever owns the spec

**1. The §2.3 liquidity tuning rule understates price impact by 1/p.**

§2.3 gives the impact of a stake as `m·p(1−p)/L` and works it as "₦2,000 stakes
→ L=50,000 gives ~1-point moves". But `p(1−p)/L` is `dp/dq` — sensitivity per
_share_. Money `m` buys about `m/p` shares, so the money-denominated impact is
`m(1−p)/L`, which is **twice** the quoted figure at even odds.

The engine agrees with the corrected form: the doc's own worked example moves the
price **1.96 points, not 1**. Locked in as a test in
`packages/engine/src/__tests__/pricing-sim.test.ts` so it stays visible.

Nothing about the engine is wrong — but a market tuned by the stated rule will
swing about double what it was sized for. For ~1-point moves at even odds, `L`
wants to be ≈ **50× the typical stake**, not 25×.

**2. Fee base: pot or losing pool?**

§2.3 says "pot − fee ... [3]%", i.e. the fee is a share of the whole pot, and
that is what `resolve(state, w, feeRate, holdings)` implements. Rulebook §10 says
community markets take "[3]% **of the losing pool** at payout". Those are
different numbers whenever the winning side holds more than nothing, and they
change what every winner receives. Worth settling before fees go live.

Rulebook §10 also prices official markets as "[1.5]% **per trade**", where §2.3
describes official fees as ~2% taken at resolution. Per-trade fees are not in the
engine today — `TradeResult.exitFee` is the only per-trade deduction, and it
exists for the §2.3 exit fee.

**3. Fee split is a ledger concern, not an engine one.**

§2.3 splits the 3% into 2% platform / 1% creator-or-syndicate. `resolve()`
returns one `fee` figure; the split into `fee_platform` and `fee_creator` ledger
entries belongs to whatever books the resolution. Both `LedgerType` values exist.

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
  `disputes.state`, `syndicates.state`, `squads.screeningState` and
  `support_tickets.category` are `String` until §3 pins them down.
- **`syndicate_members`** gained a unique constraint on `(syndicateId, userId)`.
- **`ledger` and `admin_audit` are append-only** via both a `REVOKE UPDATE,
DELETE` from the `stakeam_app` role and a trigger. The revoke is the control
  §10 asks for; the trigger is there because grants do not constrain a table's
  owner, and in development the app usually connects as the owner. CI proves the
  rule binds against a live Postgres.
