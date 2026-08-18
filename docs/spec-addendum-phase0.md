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

## Resolution, disputes and four-eyes (step 8)

**A market cannot settle on one person's say-so.** Two rules carry §6's "no god
button" design signature: the Final Resolution is staff-only, and the finaliser
can never be the person who proposed the result. On a community market the
proposer is usually the creator, so the second rule _is_ Part 3 §5's "the
platform confirms every community resolution before payout", enforced rather
than promised. The payout path itself is unchanged — the flow is the procedure
around it.

**One market, one resolution record.** The payout path used to write its own
`resolutions` row, which meant a market that went through a proposal and a
dispute window ended up with two — the second claiming the resolver had also
proposed it. It now finalises the open proposal instead, and only creates a row
when there was none (an official market settled directly). The resolution log is
the licensing exhibit; it has to read as what actually happened.

**Trading freezes on the clock, not on a flag.** The trade path refuses a buy or
sell at or after the market's event date regardless of the state column. A sweep
job flips `active → pending_resolution` so the shelf stops saying LIVE during the
match, but a late sweep is then a display bug rather than a money one — someone
watching the first half must not be able to stake on it.

**Four eyes are two people, not two clicks.** Every action in
`APPROVAL_ACTIONS` — post-activation void, bond forfeit, manual ledger
adjustment, config change, and the licensed-phase withdrawal release — is a
proposal first. The proposer can never approve their own, and a money-affecting
action needs a Finance or Admin approver (§6.4b). Approval and execution are one
transaction: an approved row whose action never ran would be an audit trail
saying money moved and money that did not, so a failing executor leaves the
proposal pending and tells the proposer why.

**Config changes land as a pending version with a visible delay.** §6.4b's "never
retroactively" is why the approved value does not replace the active row: it is
inserted as `pending` with an effective date, and promoted by the clock. The
promotion runs from `PlatformConfigService.refresh()`, so any process that reads
config also advances the schedule and a change cannot be stranded by a scheduler
that happens not to be running. `config_versions` is append-only like the ledger,
so the effective date is recorded when the change is approved rather than
back-filled when it activates.

**Staff roles.** §3's `UserRole` enum listed four values; §6.11's matrix names
five staff roles. `support`, `trust_safety` and `finance` were added — a
permission matrix that cannot express "support reads tickets but not the ledger"
is not a permission matrix. Roles are checked by a guard on the handler, so an
endpoint that forgets to declare who may call it is an endpoint nobody may call.

## The company layer (step 9)

**A limit can always be tightened, and only loosened when you are not on a
break.** §2.12 does not spell the asymmetry out, but a limit you can raise in
the moment you most want to raise it is not a limit. Tightening lands
immediately; loosening is refused while a cool-off runs. A cool-off itself can
be extended and never shortened — somebody reaching for that control a second
time is not asking for less of it.

**Self-exclusion has no undo, deliberately.** There is no method to reverse it:
reinstatement is a support request a human handles. It blocks staking and
nothing else — the balance stays withdrawable, because the difference between
protecting somebody and holding their money hostage is exactly that.

**The RG gate lives in the trade path, before escrow.** It is checked inside the
transaction that moves the money rather than at the edge, so a self-exclusion
holds on any endpoint added later. That ordering also means a stake that is both
over a limit and unaffordable reports the limit: the gate comes before the
write, which is the right way round.

**Losses are read from the ledger, not from a counter.** A daily loss is money
that left `user_available` and did not come back — stakes, less payouts,
refunds and early exits — so nothing can defeat the limit by forgetting to
increment something.

**Every notification writes a row, including the ones that failed.** The channel
result lands on the row with the reason. A silently-failed message and one never
attempted look identical otherwise, and "we told them" is a claim the support
desk has to be able to check. Delivery is best-effort by design: a market must
settle whether or not an SMS gateway is up.

**The SLA clock pauses when the ball is in the user's court.** A staff reply moves
the ticket to `waiting_on_user`; the user's reply restarts it from the
category's SLA. A desk that counts its own waiting time as lateness stops
believing its own amber. Internal notes are not answers and do not stop the
clock.

**Step-up 2FA runs after the questions about _who_.** §6.4b puts a fresh TOTP
challenge on the approve button; that check now sits after the self-approval and
role checks, because there is no point asking somebody to reach for their phone
to authorise an action they were never allowed to take. It fails closed for an
unenrolled staff account — §2.11 makes 2FA mandatory for staff, so "not enrolled
yet" is a reason to stop.

**The status page never rewrites itself.** An incident is a title and a timeline;
a correction is another update, not an edit. The daily reconciliation result is
published on it, because hiding the platform's own money check would be the
opposite of "transparency as a feature".

Packages installed for this step, all from §5.1's step-9 line: `web-push`,
`otplib`, `qrcode`, `nodemailer`. The Termii client from step 1 gained a
`send()` alongside `sendOtp()` rather than a second SMS client.

## The question engine (step 10)

**The model proposes; the code decides.** Everything §2.9 calls a rule — the
Rulebook blocklist, the structural checklist, the balance band, duplicate
detection, catalogue discipline, rank — is implemented in `market-template.ts`
and `draft-ranking.ts` and runs without a network call. The model sits behind a
`QuestionModel` interface with three methods (assess, propose, restructure), so
the platform's judgement is testable without an API key and cannot change when
the model or vendor does. A rule that lives only in a system prompt is a
preference.

**Refusals are stored, not dropped.** A proposal that fails a gate is filed as a
`rejected` draft with its reasons, and the queue can show them. A queue that
shows only what the engine liked tells an operator nothing about how it is
behaving, and §2.9's feedback loop is meant to be watched.

**Balance is scored, not just gated.** §2.9 rule 3 is a band (reject outside
35–65%, or a multi-outcome leader above 60%); the rank is engagement ×
balance quality, multiplied rather than averaged, because a one-sided market on
a huge topic still earns nothing. The backtest in §2.9 is what justifies the
weighting: balance is worth +24% fee per market.

**Duplicate detection is deliberately dumb.** Term overlap against live
questions, with the threshold in config. §2.9 asks the model for this too, but a
duplicate splits one argument across two markets — a liquidity problem worth
catching deterministically rather than by asking a model twice.

**The shelf plan is a budget.** Rule 8's six slots mean the engine drafts only
for the places the shelf has free; with six live markets a generation cycle asks
for nothing at all.

**Official markets open on a platform seed, and in points mode the seed is
issued.** §2.4 says "the platform seeds them and they open active", so the house
posts the same symmetric grant a creator does — equal money on every outcome,
no price moved, no side taken. In points mode that money is minted the way
starter balances are, and it shows on the proof-of-reserves line like any other
issuance. **When NGN activates (§9) this must be funded from platform money
instead**: a house seed backed by nothing is exactly what §2.10's fund tagging
exists to prevent. Flagged rather than assumed.

**The feedback loop measures money, not prices.** §2.9 asks for
`initial_pool_split` and `final_pool_split`; those are recorded from what the
crowd actually staked, because a market can look balanced on the chart while
90% of its money sat on one side — and it is the money that decides whether the
question earned anything. Near-balanced, high-volume, undisputed markets come
back as few-shot exemplars; anything that settled beyond 75/25 comes back as a
threshold to retune.

**The co-pilot files nothing.** §2.14a's restructure step runs while somebody is
still typing, so it returns a template and an estimate and writes no row — a
draft per keystroke would be noise in the review queue.

## The creator platform (step 11)

§2.14's loop is _creator posts good ticket → shares it → brings their audience →
market activates → clean resolution → status + earnings → posts again, better._
Almost every decision below follows from taking that loop literally: status has
to be worth something, so it has to cost something to get and be losable; and a
prompt has to be actionable, so it has to arrive rarely enough to be read.

**A level is computed, never granted.** `creator_profiles.level` is recomputed
from the counters after every settlement and is the only input to what a creator
may do. There is no code path that sets a level directly, which means a
privilege can only ever be as good as the record behind it.

**Levels can fall, and that is a config flip.** §2.14c lists what each level
unlocks but not what happens when the record stops supporting it. A Pro creator
who keeps featured placement and a fee bump through a collapsing clean rate is a
real risk, so the default is that the level follows the record —
`creator_demotion_enabled`, seeded `true`. Turning it off makes status a trophy
instead, which is a defensible product call; it is one row in `platform_config`,
not a code change.

**A void before activation is not held against anybody.** The clean rate counts
clean, disputed, and _post-activation_ voids. A Path A market that never filled
is a marketing failure, not misconduct — nobody turned up — so it moves volume
hosted and nothing else. A dispute that was _refused_ is likewise not a mark
against the creator: they were right and somebody disagreed, which is the system
working.

**The creator's fee is stamped on the market at creation.** §2.14a shows a
creator an earnings preview before they commit, and §2.14c bumps a Pro creator
from 4% to 4.5%. Reading the split from config at settlement would let a
promotion (or a demotion) rewrite the terms of a market that was already
trading, so `markets.creatorBps` is written when the market opens and read at
payout, clamped to the market's own `feeBps` so a misconfigured level cannot
make the platform's leg negative. Markets opened before the ladder existed fall
back to config — the split they opened under.

**Nudges are throttled against the send log, not a column.** §2.14d's prompts
spend the one channel the platform has to reach a creator who can still fix
something, so at most one per market per `nudge_min_hours_between`, decided by
querying what was actually sent. A `lastNudgedAt` field would be one more thing
that can disagree with the record of what happened. The studio shows the same
prompts unthrottled, because a line on a screen is not a message.

**Views are recorded by the client, on purpose.** A server-side render is not a
person. A conversion rate whose denominator counts crawlers tells a creator to
fix a problem they do not have, so `POST /markets/:id/view` is explicit and
carries `?src=` from the shared link — which is what turns §2.14d's "traffic
sources" from a guess into a count. A market nobody has looked at has a **null**
conversion rate, not zero.

**Unmet demand counts people, not searches.** §2.14b's "47 users searched…" is
distinct users over a window, normalised so that "BBNaija eviction",
"bbnaija evictions" and "Eviction BBNaija" are one signal rather than three. A
gap is suppressed when a live market already answers it, using §2.9's own
similarity function — pointing a creator at a market that exists splits its
liquidity (§2.14e), which is worse than saying nothing. Anonymous searchers are
counted by their query text, which can over-count by one; dropping them entirely
would discard exactly the people who have not converted yet.

**The autopsy is deterministic, and gives one tip.** §2.14d says "creators and
the AI improve from the same signals", so the review is computed from the same
facts §2.9's `recordOutcome` reads — final split, volume, stakers, whether a
dispute was upheld — with no model call and no API key. A creator whose market
closes at 2am gets their review at 2am. It is one tip because §2.14d says one:
a creator handed six things to fix fixes none of them. It is also written in the
same pass that moves the creator's record, keyed by market id, so at-least-once
job delivery cannot count one resolution twice.

**The share card is rendered per request, with the brand font fetched.** The
numbers on it are the point, so a card cached with yesterday's percentages is
worse than none — somebody will paste it into a group as though it were current.
The renderer's default face has no ₦, and half the questions on this platform
carry a naira threshold, so Archivo is fetched as TTF and embedded. If that
fetch fails the card still renders in the fallback face: one wrong glyph beats a 500.

**Studio pool bars are comparative, with the floor as a tick.** §2.14d asks for
an "activation progress bar per side". Drawn against the activation floor alone
it is full on every side the moment the floor is cleared — which is most of the
time, since the floor is small — and a full bar next to a nudge saying one side
is short is a screen a creator cannot reconcile. The bar is drawn against the
best-funded pool, with the floor marked on it.

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

**~~Can `staked[i]` go negative?~~ Answered in step 8: yes, and it mattered.**
The seeded scenarios added to the property suite in step 7 found it within a
hundred runs, and the counterexample is an ordinary sequence of trades: buy
heavily into one outcome so the other prices near zero, buy a little of that
other outcome (cheap by the share), sell the first back down so the book swings,
then sell the second. More money leaves through the second outcome than was ever
staked on it, and its `staked` goes deeply negative.

Unclamped, `pot − staked[w]` then exceeds the whole pot: on the shrunk case the
fee came to ₦3,829,999 against a pot of ₦3,828,588 and **every payout came out
negative** — the market billing its own winners. Conservation still held
(`Σpayouts + fee === pot`), which is why only the `fee ≤ pot` assertion caught
it.

The fix is in `resolve()`: the losing pool is a quantity of _money_, so it is
clamped to `[0, pot]` at the point where it stops being a bookkeeping figure and
becomes a fee basis. `resolve()` also now refuses to return a negative payout.
The counterexample is pinned as a fixed test in `seed.test.ts`.

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
