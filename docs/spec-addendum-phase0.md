# Spec addendum — Phase 0

`platform-architecture.md` and `market-rulebook.md` are not in the repository yet.
This addendum was supplied as **authoritative for Phase 0** and is what the
scaffold was built against. When the full documents land, add them alongside this
file; where they disagree with anything here, they win and this file should be
reconciled against them.

---

## 1. Engine formulas (`packages/engine`) — decimal.js only

State per market: `q[i]` = shares outstanding per outcome _i_ (n outcomes),
`L` = liquidity constant (Decimal, fixed at market creation), `pot` (Decimal).

```
Cost function    C(q) = L · ln( Σ_j e^(q_j / L) )
                 (computed as a stable log-sum-exp: factor out max(q_j)/L)

Display price    p_i  = e^(q_i/L) / Σ_j e^(q_j/L)          // always sums to 1

BUY (spend m on outcome i)
                 Δ = L · ln( (e^(m/L) − 1 + p_i) / p_i )
                 q[i] += Δ ; pot += m

SELL (return Δ shares of outcome i)
                 r = C(q) − C(q with q[i] −= Δ)
                 q[i] −= Δ ; pot −= r

INVARIANT        pot === C(q) − C(q0)  and  pot >= 0
                 asserted after every op, where q0 is q at market open.
                 This is an identity, not enforcement — if the assert fires,
                 the implementation is wrong.

RESOLVE(w, feeRate)
                 fee = pot · feeRate
                 distributable = pot − fee
                 holder of s shares of w receives distributable · s / q[w]
                 assert Σpayouts + fee === pot   (to 1e-9)
```

Estimated payout per share shown pre-resolution is `pot / q[w]`, and must be
labelled "estimate".

Rules:

- trading freezes at event start
- `L` is immutable per market; rule of thumb `L ≈ 25 × typical stake`
- optional `exitFee` 0–0.5%, default 0

The fast-check suite must prove, over random buy/sell sequences (2–8 outcomes,
mixed magnitudes):

- prices sum to 1 (±1e-9)
- the pot identity holds
- the pot is never negative, including full-position exits
- resolution conserves money exactly

### Implementation notes

- **Where the exit fee comes from.** The pot always gives up the full refund
  `r`; the exit fee is withheld from the seller and booked to platform fees.
  Taking it out of the pot instead would break `pot === C(q) − C(q0)`.
- **Invariant tolerance.** The identity subtracts two numbers the size of `L`
  and `q`, so the allowed slack is scaled to the market, not to the pot — a
  fully-exited market has a near-zero pot after millions have traded through it.
  At 40 significant digits this lands around 1e-24 on a ₦2.5m book, i.e. twenty-
  two orders of magnitude below one kobo.
- **Resolution conservation** requires the supplied holdings to account for every
  outstanding winning share, so a seeded market must attribute its `q0` shares.
  `resolve()` checks this and refuses to pay out otherwise.

## 2. Prisma schema

Columns as specified in the addendum, implemented in
`apps/api/prisma/schema.prisma`. Tables are snake_case via `@@map`, ids are cuid,
`createdAt` defaults to `now()`, and every money or share quantity is
`Decimal(38,18)` — never a float.

Deviations, all deliberate:

- **`price_history`** has no natural key in the spec and is high-volume time
  series, so it takes a `BigInt` identity key rather than a cuid.
- **Enums** were created only where the addendum enumerated values in a comment.
  Fields such as `users.status`, `disputes.state`, `syndicates.state`,
  `squads.screeningState` and `support_tickets.category` are `String` until the
  full §3 pins their values down.
- **`syndicate_members`** gained a `@@unique([syndicateId, userId])` — a member
  contributing twice to one syndicate is a bug, not a feature.

`ledger` and `admin_audit` are append-only, enforced in
`prisma/migrations/20240101000001_ledger_append_only` by both a `REVOKE UPDATE,
DELETE` from the `stakeam_app` role _and_ a trigger. The revoke is the control
the architecture asks for; the trigger is there because grants do not constrain
a table's owner, and in development the app usually connects as the owner. CI
proves the rule binds against a live Postgres.

## 3. Design tokens (`packages/tokens`)

| Role      | Light     | Note                             |
| --------- | --------- | -------------------------------- |
| paper     | `#FAFDF7` | page ground                      |
| ink       | `#10241B` | primary text                     |
| green     | `#0E7A3D` | rise / YES                       |
| greenDeep | `#0A5A2D` | pressed, emphatic                |
| red       | `#C93A2E` | fall / NO                        |
| gold      | `#E3A81C` | money ONLY — pots, fees, payouts |
| muted     | `#5E7267` | secondary text                   |
| line      | `#DCE7DC` | hairlines, 1px borders           |

Dark mode surface: `#0B1A13`, same semantic roles. The addendum pins down only
the dark base; the other dark values in `semantic.dark` are derived to hold the
same contrast relationships and are the first thing to revisit when the full
§7.4 arrives.

- **Fonts** — Archivo (variable, 400–900; 900 for headline numbers and market
  questions) for display and body; Space Mono for all live figures, tabular
  numerals. Both loaded via `next/font`.
- **Type scale (px)** — 12 / 13.5 / 15 / 17 / 21 / 28 / 34.
- **Radii** 8–14px; borders 1px `line`; single-layer soft shadows; 4px grid.
- **Motion** — `priceTick` 250ms count-up with a green/red tint; `barEase`
  `cubic-bezier(.2,.8,.2,1)`; `prefers-reduced-motion` respected in base styles.

## 4. Integration interfaces

Defined in `apps/api/src/integrations/types.ts`.

- `PaymentsProvider` — `paystack.stub.ts` and `flutterwave.stub.ts`, every method
  throws `NotImplementedError('licensed phase')`.
- `KycProvider` — `smileid.stub.ts`, same pattern.
- `SmsProvider` — `termii.ts` is a **real** thin REST client over `fetch`,
  reading `TERMII_KEY` from the environment. No SDK.

The stubs fail closed on purpose. Do not soften them into no-ops or fixtures: a
caller that reaches one is trying to move real naira.
