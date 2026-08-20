# StakeAm — working notes for Claude

A Nigerian prediction market. pnpm monorepo: `apps/web` (Next.js 15 App
Router), `apps/api` (NestJS + Prisma + Postgres + Redis), `packages/engine`
(the pricing arithmetic), `packages/rules` (the ticket-creation checklist as
code), `packages/tokens` (the design system).

## Skills

`.claude/skills/` holds instructions worth loading before certain kinds of
work. They are not documentation to skim — load the relevant one first, because
each encodes a rule this codebase already enforces somewhere, and the usual
failure is re-implementing a control that exists rather than finding it.

| Skill                   | Load it before                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stakepot-market-rules` | Anything that opens a market: the Studio wizard, the AI question engine, community creation, templates and recurring series, `packages/rules`. Also when drafting or critiquing an actual market question, or touching event dates, void dates, freeze times, outcomes, thresholds or resolution sources. |
| `stakepot-money-safety` | Anything touching balances, the ledger, escrow, trades, payouts, settlement, refunds, voids, bonds, prizes, withdrawals, or the audit and reconciliation jobs. Also when reviewing a diff over `apps/api/src/{ledger,trade,wallet,resolution,approvals,reconciliation,hardening}` or `packages/engine`.   |
| `frontend-design`       | Building or reshaping any screen. UI quality is this project's known weak spot; the design reference is `docs/design-reference.html` and the tokens are in `packages/tokens`.                                                                                                                             |
| `claude-api`            | Any work on the three services that call `@anthropic-ai/sdk` — the question engine, the wizard co-pilot, the resolution analyst. Model ids and pricing come from there, not from memory.                                                                                                                  |
| `skill-creator`         | Writing or improving a skill in `.claude/skills/`.                                                                                                                                                                                                                                                        |

Provenance and licences for the vendored ones are in
`.claude/skills/README.md`. They are copied unmodified from
[anthropics/skills](https://github.com/anthropics/skills); do not edit them in
place.

## The two rules that outrank everything else

**No automated path may settle a market.** The research pipeline reads, the
dossier assembles, an analyst summarises — none of them can reach the
resolution flow, the ledger or market state. Asserted structurally in
`apps/api/src/intel/no-automated-settlement.integration.test.ts`.

**Money is `Decimal`, and the ledger is append-only.** Every posting sums to
zero or `LedgerService.post` throws. A correction is a new pair of rows, never
an edit.

## Running things

```bash
./scripts/dev/ensure-services.sh          # Postgres + Redis; idempotent
pnpm --filter @stakeam/api exec prisma migrate deploy
pnpm dev                                  # api on :3001, web on :3000
```

Tests, and what each covers:

```bash
pnpm -r test                              # unit everywhere
TEST_DATABASE_URL="postgresql://stakeam:stakeam@localhost:5432/stakeam_test" \
  pnpm --filter @stakeam/api test         # integration suites need this set
pnpm --filter @stakeam/web exec playwright test   # journeys; needs the stack up
pnpm lint                                 # eslint + vocabulary + wiring
```

`pnpm lint` runs three gates, and the last two are project-specific:

- **`check-vocabulary.mjs`** — user-facing strings use trading language, not
  betting language.
- **`check-wiring.mjs`** — every `@Injectable` has a caller in a controller,
  worker or another service. Module registration and tests do not count as
  callers, because the defect this catches is a service that is registered,
  tested and never invoked. Several money-adjacent ones were, including the
  nightly reconciliation.
- **`react-hooks/rules-of-hooks`** — an error, not a warning. A hook below an
  early return passes typecheck, lint, tests and a production build, then
  blanks the page at runtime with a minified error number.

## Traps that have each cost a cycle

- **A stale dev server serves the old build.** Run
  `fuser -k 3000/tcp 3001/tcp` before trusting any render. A skipped
  `cd apps/api` that leaves `tsc -p tsconfig.build.json` unrun looks identical:
  a 404 on an endpoint you just wrote. A dev API also drains the shared Redis
  trade streams against its own database, which fails the e2e queue tests.
- **A DTO declared below the controller that uses it dies on boot.**
  `emitDecoratorMetadata` reads the type where the method is defined, so the
  class is still in its temporal dead zone: it compiles, typechecks, passes
  every test, then throws `Cannot access X before initialization`. Keep DTOs
  above the `@Controller`.
- **A Nest module that lists only the `@Global` modules dies on boot** the
  moment it needs a non-global one. Prisma, audit and platform-config are
  global; notifications is not.
- **`resetDatabase` in the vitest suites wipes tables under a running API.**
- **`stakeam_shadow` must exist** for the migration-diff gate.
- **The SMTP sink** (`scripts/dev/smtp-sink.mjs`) gets reclaimed on worker
  restarts, and the walkthrough's verification-code step fails without it.

## Conventions

Comments explain **why**, at the density of the surrounding file — this
codebase records the reasoning behind a decision, especially where an obvious
alternative is wrong. Match that. Do not add comments that restate the code.

Prose in docs and commit messages is plain and specific. No marketing register.

Production is reachable only through GitHub Actions probes; the sandbox's
egress proxy 403s the deployment host by org policy. Report a blocked host
rather than routing around it.
