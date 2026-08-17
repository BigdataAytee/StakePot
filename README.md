# StakeAm

Nigeria's prediction market. Trade on elections, the naira, the Super Eagles and
BBNaija with live-moving odds, or open your own ticket for your community to
call. Winners split the pot, creators earn from the markets they start, and every
result settles against one official source — no house, no house edge, receipts
forever.

Full product copy lives in [`docs/README.md`](docs/README.md). The Phase 0
specification is [`docs/spec-addendum-phase0.md`](docs/spec-addendum-phase0.md).

## Status: Phase 0 — scaffold

Pricing engine, design tokens, data model and CI. No market UI yet.

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
  `pot === C(q) − C(q0)` ever fires, the implementation is wrong — do not clamp
  around it.
