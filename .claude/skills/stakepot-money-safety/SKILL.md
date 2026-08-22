---
name: stakepot-money-safety
description: >
  The money-path law for StakeAm: decimal arithmetic only, an append-only
  ledger where every posting sums to zero, escrow invariants, four eyes on
  anything that moves significant user money, and no automated path that can
  settle a market. Load this before touching balances, the ledger, escrow,
  trades, payouts, settlement, refunds, voids, bonds, prizes, withdrawals or
  the reconciliation and audit jobs — and before adding any admin endpoint that
  changes an amount or a market state. Also load it when reviewing a diff that
  touches apps/api/src/{ledger,trade,wallet,resolution,approvals,reconciliation,hardening}
  or packages/engine, when you see a bare number where an amount should be, or
  when an AI or a job looks like it is about to decide an outcome. If a task
  mentions money, balance, ledger, escrow, payout, settle, resolve, refund,
  void or withdraw, assume this applies.
---

# The money path

Everything here exists because of one asymmetry: a bug in the catalogue makes a
screen look wrong, and a bug in this code makes somebody's balance wrong. The
second kind is discovered by the person who lost the money, which is the worst
possible way to find out.

None of these are conventions. Each is enforced somewhere, and the enforcement
is named below so you can check your change still passes through it rather than
around it.

## 1. Decimals, never floats

Money is `Decimal` from `@stakeam/engine` (decimal.js) and crosses every
boundary — HTTP, JSON, Prisma — as a **string**. There is no point at which an
amount becomes a JavaScript number.

```ts
// wrong, and it will pass tests for months
const total = Number(a) + Number(b);
// right
const total = new Decimal(a).plus(b);
```

`packages/engine` lints `@typescript-eslint/no-explicit-any` as an error for
this reason: `any` erases the Decimal guarantees, and the value that arrives is
a float nobody declared. Prisma columns are `Decimal(38, 18)` for amounts and
`Decimal(60, 30)` for share counts; read them with `.toString()`, never with
`Number()`.

If you find yourself rounding, ask what the remainder does. It has to go
somewhere, and "it is only kobo" is how a pot stops summing to its stakes.

## 2. The ledger is append-only and every posting sums to zero

There is no `update` on a ledger entry and no way to write one directly. The
only door is `LedgerService.post(tx, postings, ref)`, and the first thing it
does is `assertBalanced(postings)` — a set of postings that does not sum to
zero throws before anything is written.

This is why a correction is **a new pair of rows**, never an edit. The
`ledger.adjust` four-eyes action posts a reversing entry between the user and
the platform; it does not change a number. A balance is derived by summing
entries, so an edit would rewrite history and no audit could tell.

Four `FundClass`es, and they do not mix casually:

| Class            | What it holds                                                          |
| ---------------- | ---------------------------------------------------------------------- |
| `user_available` | Spendable balance.                                                     |
| `user_escrow`    | Staked in an open market. Locked from the moment of the trade.         |
| `platform_fees`  | The only class company costs may be paid from.                         |
| `prize_pool`     | Promotional money, kept separate so it cannot be confused with stakes. |

## 3. The invariants, checked nightly

`apps/api/src/hardening/ledger-audit.service.ts` runs four checks and they are
the definition of "the money adds up":

1. **Every posting sums to zero.**
2. **Escrow matches open markets** — the sum of `user_escrow` equals what the
   open markets say is staked.
3. **No negative user balances.**
4. **Staked matches pot** — each market's outcome stakes sum to its pot.

A violation is logged at `error` with `LEDGER AUDIT FAILED`, never swallowed. If
your change makes one of these fail, the change is wrong — do not adjust the
invariant to fit it. They are also the fastest way to check your own work:
run the audit after a change that moves money.

`ReconciliationService` is the daily companion (§2.7) — it runs on a cron
pattern rather than an interval so a control that can freeze withdrawals cannot
drift onto peak trading hours after a redeploy.

## 4. Trades execute atomically, and the freeze is checked at execution

One transaction: take the market's row lock (`SELECT ... FOR UPDATE`), read the
pot, price through the engine, post the ledger entries, write the new pot,
snapshot the price. `TradeService.lockAndLoad` is the single door into both
buying and selling, which is what makes every guard it applies hold for both
directions and for any endpoint added later.

Guards that live there, and why:

- **Frozen** (§2.3, rule 22) — checked inside the transaction, so a trade that
  queued before the freeze and reached the front after it is refused. See the
  `stakepot-market-rules` skill for the freeze model itself.
- **Creator cannot take a side in their own market** — they also settle it.
- **Staff cannot trade at all** — they see the resolution queue first.
- **A frozen account keeps its balance** and loses the ability to add to a
  position.

Idempotency is by `requestId`, unique on the trade row. A retried submit
returns the original fill; it does not trade twice.

## 5. Four eyes on anything significant

`apps/api/src/approvals/approval-actions.ts` holds the registry, and
`approvals.service.ts` holds the executors. An action not listed there has no
schema and no executor — the workflow cannot be used to smuggle through
something nobody wrote down. Currently: void after activation, bond forfeiture,
ledger adjustment, config change, prize run, withdrawal release, and unfreezing
a market.

The rule that makes it real: **the proposer cannot approve**, and a money-class
action needs a finance or admin approver with a TOTP step-up. If you add an
action, add it to the registry with a schema, and write the executor in the
`switch` — a plugin registry would let one land without anybody reading it.

## 6. No automated path can settle a market

This is the one to be most careful with, because it is the one an AI feature
will drift into by accident.

The research pipeline reads sources. The dossier service assembles evidence and
an analyst can summarise it. **Neither can reach the resolution flow, the
ledger, market state, propose or finalise.** That is asserted structurally in
`apps/api/src/intel/no-automated-settlement.integration.test.ts`, and it is
verified to fail when a call to the resolution flow is added to a dossier
handler — so it is a real guard, not a comment.

A human proposes a resolution against the source the market named, a second
human confirms, the dispute window runs, and only then does money move. If you
are wiring an AI output into anything downstream, the question to ask is
whether a wrong answer from it could move money without a person agreeing.

## 7. What we deliberately do not do

**No withdrawal lock near settlement.** Escrow already holds staked funds from
the moment of the trade, so free balance stays withdrawable at all times.
Blocking withdrawals is what untrustworthy platforms do and this one does not
need it. If a change starts to look like a withdrawal lock, say so out loud
rather than shipping it.

## Checking your work

```bash
pnpm --filter @stakeam/engine test                    # the arithmetic, property-tested
TEST_DATABASE_URL=... pnpm --filter @stakeam/api test # ledger, trade, resolution suites
node scripts/check-wiring.mjs                         # a service with no caller is a control that never runs
```

The last one matters more than it looks. Several money-adjacent services in
this codebase were written, registered, tested and never called by anything —
including the nightly reconciliation. A control nobody invokes cannot be told
apart from one that passes.
