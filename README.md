# StakeAm

Nigeria's prediction market. Trade on elections, the naira, the Super Eagles and
BBNaija with live-moving odds, or open your own ticket for your community to
call. Winners split the pot, creators earn from the markets they start, and every
result settles against one official source — no house, no house edge, receipts
forever.

The source of truth is [`docs/platform-architecture.md`](docs/platform-architecture.md)
and [`docs/market-rulebook.md`](docs/market-rulebook.md).
[`docs/spec-addendum-phase0.md`](docs/spec-addendum-phase0.md) records how the
Phase 0 scaffold reconciles against them, and the open questions it raised.

## Status: Phase 3 — community shelf

Money core, live market and ticket view, multi-outcome markets, community
creation with AI screening, Path B symmetric seeds, Sponsor Syndicates and
conduct bonds, the resolution and dispute flow, four-eyes approvals, the admin
cockpit at `/admin` — and, as of step 9, the company layer: responsible-gambling
limits, support ticketing with SLAs, notifications, staff 2FA and a public
status page at `/status`.

## Quickstart

```bash
pnpm install
cp .env.example .env          # then fill in JWT_SECRET
docker compose up -d          # postgres:16 + redis:7
pnpm migrate                  # apply the schema
pnpm dev                      # web on :3000, api on :3001
```

## Layout

| Path              | What                                                         |
| ----------------- | ------------------------------------------------------------ |
| `apps/web`        | Next.js user app and `/admin` routes                         |
| `apps/api`        | NestJS API, trade workers, jobs                              |
| `packages/engine` | Hybrid pricing engine (§2.3 v1.1) — pure TS, decimal.js only |
| `packages/tokens` | Design tokens (§7.4) as a Tailwind preset                    |
| `docs/`           | Architecture, rulebook, Phase 0 addendum                     |
| `scripts/`        | Reference simulations and the k6 load script                 |

## Commands

| Command           | What                                    |
| ----------------- | --------------------------------------- |
| `pnpm dev`        | every package in watch mode             |
| `pnpm build`      | build all, in dependency order          |
| `pnpm test`       | all test suites                         |
| `pnpm test:props` | the engine's fast-check invariant suite |
| `pnpm test:load`  | k6 smoke test (k6 is a system install)  |
| `pnpm lint`       | eslint across the workspace             |
| `pnpm typecheck`  | tsc across the workspace                |
| `pnpm migrate`    | `prisma migrate deploy`                 |

## Rules that are not negotiable

- **Floats are forbidden in the ledger.** Every money and share quantity is a
  `Decimal` in code and `Decimal(38,18)` in Postgres.
- **`ledger` and `admin_audit` are append-only.** `UPDATE` and `DELETE` are
  revoked and trigger-blocked. Corrections are new rows. CI proves it against a
  live Postgres on every run.
- **No `any` in `packages/engine`.** It is the money path; `any` erases the
  guarantees the ledger depends on.
- **The pot invariants are asserts, not enforcement.** If
  `pot === C(q) − C(q0)` or `Σstaked === pot` ever fires, the implementation is
  wrong — do not clamp around it.
- **Self-exclusion always wins** (§2.12). It is checked inside the transaction
  that moves the money, it blocks staking and never withdrawal, and there is no
  code path that undoes it — reinstatement is a person's decision, not a button.
- **No god button** (§6). No screen lets one person edit a balance, resolve a
  market without a trail, or spend escrow. Voids after activation, bond
  forfeitures, manual ledger corrections and config changes are proposals; a
  second person approves them, and the proposer never can.
- **Tunable values live in `platform_config`, never in code** (§6.4b). Fees,
  limits, thresholds and windows are four-eyes-approved database rows with an
  immutable history. Constants in the engine are validation rails, not settings.
