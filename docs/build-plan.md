# StakePot — Phased Build Plan
### Six verified phases from empty repo to full platform
*Companion to `platform-architecture.md` (v1.1) and `market-rulebook.md`. Each phase is one Claude Code session with a hard definition of done. Do not start a phase until the previous phase's gate is green.*

---

## Why phased, not one-shot
1. **Trust chains.** Every layer must be proven before the next builds on it — the engine is only trustworthy on an airtight ledger; the UI is only worth building on a tested engine. A foundation bug found under forty features is a rebuild, not a refactor.
2. **Verification limits.** 77 features, ~30 tables, two apps. Bounded steps with green tests beat one heroic pass where nothing is verified until the end — one-shot builds fail in the seams (escrow atomicity, payout batches, idempotency), exactly where a money platform cannot afford seams.
3. **The founder is part of the loop.** Between phases you click the product, read the reconciliation output, correct the bracketed numbers cheaply. One-shot removes you until mistakes are expensive.

Sequencing: Phases 0 → 1 → 2 are strictly sequential. Phases 4 and 5 may overlap if two developers are available. **Phase 2 is the demo-able milestone** — after it you have a real product to show anyone.

---

## Phase 0 — Scaffold
**Scope:** Monorepo, dependency manifest (§5.1), full Prisma schema (§3), engine package with exact v1.1 math (§2.3), design tokens (§7.4), Docker + CI.

**Claude Code prompt:**
```
You are setting up the repository for StakePot — a Nigerian prediction-market
platform. The full specification lives in docs/platform-architecture.md and
docs/market-rulebook.md — read both before writing any code; they are the
source of truth. This is Phase 0: scaffold the monorepo and install the exact
dependency manifest, wired so each build step picks up its own packages.

REPO STRUCTURE (pnpm monorepo):
- apps/web       -> Next.js 14+ (TypeScript, App Router) — user app + /admin routes
- apps/api       -> NestJS (TypeScript) — API, trade workers, jobs
- packages/engine-> hybrid pricing engine (pure TS; only runtime dep: decimal.js),
                    implementing the exact v1.1 formulas from architecture §2.3
- packages/tokens-> design tokens from §7.4 exported as a Tailwind preset
- docs/          -> platform-architecture.md, market-rulebook.md, README.md
- scripts/       -> keep pricing_sim.py and ai_backtest.py as reference

DEPENDENCY MANIFEST — install EXACTLY these, grouped by build step (§5.1).
No package outside this list without a written reason in the PR.

Step 1 — Foundation (install now):
  next react react-dom typescript
  @nestjs/core @nestjs/common @nestjs/platform-fastify
  prisma @prisma/client
  decimal.js                # ALL money math — floats forbidden in the ledger
  argon2 @nestjs/jwt passport passport-jwt
  zod class-validator class-transformer
  ioredis pino pino-pretty helmet

Step 2 — Engine + tests (install now, dev):
  vitest supertest fast-check       # fast-check: property tests proving pot >= 0
  eslint prettier husky lint-staged

Step 3 — CI/CD & observability (install now):
  @sentry/nextjs @sentry/node prom-client
  Also create: Dockerfile per app; docker-compose.yml (postgres:16, redis:7);
  .github/workflows/ci.yml (lint -> typecheck -> test -> build; block merge on failure)

Step 4 — Live prices & Ticket View (install now — first UI milestone):
  socket.io socket.io-client
  lightweight-charts               # the §7.2 area chart with annotations
  tailwindcss postcss autoprefixer # consumes packages/tokens preset
  framer-motion @formkit/auto-animate
  zustand lucide-react date-fns

Step 6 — Community shelf & wizard (install when that phase starts):
  react-hook-form @hookform/resolvers
  @anthropic-ai/sdk                # AI question engine + wizard co-pilot (§2.9, §2.14a)
  bullmq

Step 9 — Support, notifications, RG (install when that phase starts):
  web-push otplib qrcode nodemailer
  # Termii SMS = thin REST client in apps/api/src/integrations/termii.ts (no SDK)

Steps 11–13 — Creator tools, community, sharing (install when those phases start):
  @vercel/og canvas-confetti next-intl @serwist/next

Step 14 — Hardening (install when that phase starts):
  rate-limiter-flexible
  Dev/e2e: playwright; k6 via system install (npm script test:load)
  Scale trigger only (§12): kafkajs — commented placeholder in package.json, do NOT install

Licensed phase — do NOT install; stub instead:
  apps/api/src/integrations/{paystack,flutterwave,smileid}.stub.ts with typed
  interfaces per architecture §9, throwing NotImplementedError.

WIRING REQUIREMENTS:
1. package.json scripts per app: dev, build, test, test:props, lint, migrate;
   root scripts run all.
2. prisma/schema.prisma: the FULL data model from architecture §3 (users, wallets,
   ledger [append-only], markets, outcomes, trades, positions, syndicates, bonds,
   resolutions, disputes, market_drafts, market_outcomes_log, approvals,
   admin_audit, reconciliation_runs, support_tickets, rg_settings, notifications,
   events, creator_profiles, followers, ticket_templates, opportunities,
   market_autopsies, comments, reputation, squads, squad_members,
   squad_challenges, challenges, top_calls, price_history, market_annotations).
   Ledger: no UPDATE/DELETE — enforce via Postgres grants in a migration.
3. packages/engine: implement C(q), prices(q), buy(), sell() exactly per §2.3
   using decimal.js, closed-form share formula, plus a vitest+fast-check suite
   asserting: prices sum to 1; pot === C(q)-C(q0) after any random buy/sell
   sequence; pot never negative; resolution payouts+fees === pot.
4. packages/tokens: §7.4 palette, type scale, radii as a Tailwind preset;
   apps/web extends it; load Archivo + Space Mono via next/font.
5. .env.example listing every secret (DATABASE_URL, REDIS_URL, JWT_SECRET,
   ANTHROPIC_API_KEY, SENTRY_DSN, TERMII_KEY, VAPID keys); .env gitignored.
6. Run the engine test suite and both app builds; fix anything red before
   finishing. Output a summary and the dev-start command.

Constraints: TypeScript strict everywhere; no `any` in packages/engine;
conventional commits; no UI beyond a placeholder home page — Phase 0 is
scaffold + engine + tokens + schema + CI, nothing more.
```

**Definition of done:** engine property suite green · both apps build · docker compose brings up Postgres + Redis · CI pipeline passes on the first commit.

---

## Phase 1 — Money Core
**Scope:** Architecture §2.1, §2.2, §2.10, §2.11 — tiered auth (Tier 0/1; Tier 2 stubbed), wallet + append-only ledger with fund tagging, escrow moves, daily reconciliation job with freeze-on-mismatch, admin audit log, four-eyes approvals workflow, staff 2FA.

**Claude Code prompt:**
```
Implement Phase 1 (Money Core) per docs/platform-architecture.md §2.1, §2.2,
§2.10 and §2.11. Read those sections fully first.

Build in apps/api:
- Tiered auth: Tier 0 signup (email OR phone + password, age attestation),
  Tier 1 contact verification (OTP/link; one account per verified contact;
  Tier 0 expiry job), JWT sessions, roles (user/creator/resolver/admin),
  staff TOTP 2FA (otplib is installed in a later phase — stub the 2FA
  verification behind an interface for now and note it).
- Wallet & ledger: double-entry, append-only, every row typed and fund-class
  tagged (user_escrow | user_available | platform_fees | prize_pool),
  currency field (PTS default). All balance mutations happen ONLY through
  ledger service methods that write atomically. decimal.js everywhere.
- Escrow: available -> escrow on stake/buy; escrow -> available on payout/refund.
- Reconciliation: daily job recomputing all balances from the ledger vs stored
  wallets; any mismatch writes reconciliation_runs, pages (log-level fatal),
  and sets a global withdrawals_frozen flag.
- Approvals: generic four-eyes workflow table + service (request -> approver1
  -> approver2 -> execute), used later by withdrawals/voids/bond forfeits.
- Admin audit: middleware writing every admin-role mutation to admin_audit
  (append-only, same grant treatment as ledger).

Tests required before finishing: unit tests on ledger invariants (balances
derivable from ledger; fund classes never cross), an integration test running
signup -> Tier 1 -> credit -> escrow -> release -> reconciliation clean, and a
test proving a deliberately corrupted wallet row is caught by reconciliation
and freezes withdrawals. All green, CI passing.
```

**Definition of done:** reconciliation runs clean on seeded data · corrupted-row test triggers freeze · ledger rejects UPDATE/DELETE at the database level · every admin mutation appears in admin_audit.

---

## Phase 2 — The Market (demo-able milestone)
**Scope:** Architecture §2.3, §7.1–§7.4, §11 — trade endpoint through per-market ordered queue with idempotency, the full Ticket View (live area chart with annotations, argument bar, money strip, trade panel, sell slider, position P&L), multi-outcome markets, resolution + receipt, official-shelf admin creation.

**Claude Code prompt:**
```
Implement Phase 2 (The Market) per docs/platform-architecture.md §2.3 (engine
integration), §7.1–7.4 (client app + design system) and §11 (throughput).
Read those sections fully first. Phase 1 services are the only way money moves.

apps/api:
- Trade pipeline: POST /markets/:id/trade -> Redis Streams partition per
  market_id -> single consumer per market executes atomically via
  packages/engine + ledger service -> price_history snapshot ->
  price_changed event published. Client-supplied request_id enforces
  idempotency (duplicate = same response, no double charge).
- Sell/early-exit through the same pipeline; refund quoted then executed.
- Resolution flow (official shelf, staff role): propose -> 48h dispute window
  timer -> finalize -> chunked payout batch (resumable, idempotent per
  position) -> receipts.
- GET /markets, GET /markets/:id, GET /markets/:id/history?tf=...,
  WS /live per-market subscriptions.
- Admin (minimal): create official market from template fields (§ Rulebook
  Part 2), set liquidity_param with the L ≈ 25x typical stake guidance
  surfaced, pause/freeze at event start, resolve, void.

apps/web (mobile-first, tokens preset, §7.4 motion rules):
- Markets home: official shelf cards with live % + 24h sparkline + state badges.
- Ticket View per §7.2: area price chart (lightweight-charts) with event
  annotations from market_annotations, timeframe switcher, argument bar synced
  to last point, money strip, trade panel (amount chips, payout estimate,
  slippage preview), position panel with live P&L and sell slider, rules card,
  resolved-state receipt. Binary + multi-outcome (multi-line chart, tap to
  isolate a candidate).
- Living numbers: all prices count between values with tint flash;
  prefers-reduced-motion respected.

Tests: engine-through-pipeline integration (concurrent duplicate request_ids
-> one execution), payout batch crash-resume test, Playwright happy path
(open ticket -> buy -> price moves -> sell -> resolve -> receipt). All green.
```

**Definition of done:** one market runs end-to-end on a phone · concurrent duplicate trades execute once · payout batch survives a mid-run kill · the receipt shows pot fully distributed (platform cost ₦0.00).

---

## Phase 3 — Community Shelf
**Scope:** Architecture §2.4, §2.5, §2.6, §2.9, §2.14a — creation wizard with AI co-pilot and balance meter, ticket template library, Path A funding windows, Path B symmetric seeds, sponsor syndicates, conduct bonds, community resolution with platform confirmation, dispute flow, admin resolution centre + review queue.

**Claude Code prompt:**
```
Implement Phase 3 (Community Shelf) per docs/platform-architecture.md §2.4,
§2.5, §2.6, §2.9 and §2.14a, and docs/market-rulebook.md Part 3. Read all
fully first.

apps/api:
- Market lifecycle state machine per §2.4 (draft -> seeding -> funding ->
  active -> pending_resolution -> dispute_window -> resolved | voided) with
  bullmq jobs for window closes and auto-void refunds (full escrow refund,
  zero fees).
- Path A activation checks per the amended rulebook rule (binary: per-side
  minimums; multi-outcome: total pot threshold + >=2 funded outcomes).
- Path B symmetric seed (creator or syndicate; equal split across all
  outcomes enforced server-side; participation floor re-check at window close).
- Syndicates: seeding rounds, contribution caps, fee-split table (pro-rata or
  creator-defined, locked at round open).
- Conduct bonds (post/refund/forfeit via the Phase 1 approvals workflow).
- Creator restrictions: no directional stakes in own market (trade endpoint
  guard), influence attestation stored.
- AI Question Engine (@anthropic-ai/sdk) per §2.9: co-pilot endpoint for the
  wizard (restructure free text into the full template, balance estimate,
  blocklist), screening endpoint for submissions, market_drafts queue.
  The AI NEVER publishes — staff approval required.

apps/web:
- Creation wizard per §2.14a: natural input -> AI restructure -> balance
  meter (green 35–65 / amber / red with explanation) -> earnings preview ->
  path choice -> bond -> submit. Ticket template library (BBNaija, fixtures,
  elections, economic thresholds, transfers, awards) with localisable fields.
- Community shelf cards + funding-state Ticket View (activation meters,
  countdown, seed composition) flipping to live chart on activation with the
  moment annotated.
- Admin: resolution centre (proposed outcome vs rules vs source side-by-side,
  dispute handling), community review queue with AI scores.

Tests: full lifecycle integration for Path A success, Path A void-and-refund,
Path B seed with floor failure refund (seed included), syndicate payout math
against Rulebook Part 3 worked examples. All green.
```

**Definition of done:** a second person can create a ticket through the wizard, fund it, and have it resolve after your approval · every void path refunds to the kobo · AI drafts appear in the queue but nothing publishes without a human click.

---

## Phase 4 — Company Layer
**Scope:** Architecture §2.12, §2.13 (remaining), §6 (full admin) — support ticketing with SLAs, notifications service, public status page, RG module (limits, cool-offs, self-exclusion, reality checks — dormant thresholds), staff 2FA activation, AI drafts queue polish, complete nine-screen admin cockpit.

**Claude Code prompt:**
```
Implement Phase 4 (Company Layer) per docs/platform-architecture.md §2.12,
§2.13 and the full §6 Admin Platform Specification. Read fully first.

- Support: in-app ticketing (categories, SLA timers with escalation states),
  support role sees tickets + read-only user/market context only.
- Notifications: transactional events (trade confirmed, market resolved,
  payout, dispute update, follow/challenge placeholders) via queue to in-app
  + web-push + email; per-user preferences.
- RG module per §2.12: user-set and platform deposit/stake/loss limits
  (dormant/high in points mode but fully functional), cool-off periods,
  permanent self-exclusion (blocks trading, allows withdrawal), session
  reality-check prompt after 60 min, helpline surface. Self-exclusion must
  work end-to-end in points mode.
- Staff TOTP 2FA live (otplib + qrcode), replacing the Phase 1 stub;
  re-auth for sensitive admin actions.
- Public status page fed by health checks; incident posting from the admin
  system room.
- Complete the nine admin screens per §6 with the role->screen matrix
  enforced in middleware; confirm no path exists to mutate balances outside
  the approvals workflow ("no god button" test).

Tests: RG self-exclusion blocks trades but permits withdrawal; SLA escalation
fires; role matrix denies cross-role access; the no-god-button test attempts
direct balance mutation from every admin screen and fails. All green.
```

**Definition of done:** a support ticket and an RG self-exclusion both work end-to-end · the no-god-button test passes · status page reflects a simulated incident.

---

## Phase 5 — Growth & Hardening
**Scope:** Architecture §2.14 (full), §2.15 phase 1, §2.8, step 14 — creator profiles/ladder/follows, opportunity feed, share kit (@vercel/og cards), analytics + nudges + autopsies, take threads with position badges, challenge links, leaderboards + prizes, rate limits, abuse detection, localisation scaffolding, PWA install, k6 load test at 10× peak.

**Claude Code prompt:**
```
Implement Phase 5 (Growth & Hardening) per docs/platform-architecture.md
§2.14 (complete), §2.15a+d (community phase 1), §2.8, and build-order step 14.
Read fully first.

Growth:
- Creator profiles (level, clean resolutions, volume, accuracy), progression
  ladder rules, follow system with new-market notifications.
- Opportunity feed: event calendar entries + unmet-search-demand surfacing.
- Share kit: @vercel/og server-rendered market cards and receipts using
  packages/tokens (identical branding in-app and shared); challenge links
  ("I'm YES at 60% — prove me wrong") landing on the ticket with the
  challenger's position shown.
- Take threads on tickets with position badges and permanent prediction
  receipts at resolution; reason prompt at trade time; Tier 1 gate;
  report button feeding the moderation queue.
- Leaderboards (weekly/all-time, profit + accuracy), streaks, prize run tool.
- Market autopsies job writing improvement tips and feeding
  market_outcomes_log.
- Localisation: next-intl wired, all strings in en.json; PWA via
  @serwist/next (installable, offline shell); canvas-confetti win moment per
  §7.4 (reduced-motion respected).

Hardening:
- rate-limiter-flexible on auth, trade, create, comment endpoints.
- Abuse detection jobs: wash-trading pattern flags, stake-flood alerts,
  multi-account clusters -> Trust & Safety queue with freeze action.
- k6 script simulating election night at 10x expected peak on the trade
  pipeline; document results in docs/loadtest.md. Playwright suite covering
  the five core journeys.

All tests green; k6 run attached; finish with a release checklist.
```

**Definition of done:** share cards render pixel-identical to in-app branding · challenge link converts a fresh signup into a positioned view · k6 at 10× peak holds trade latency targets · abuse flags reach the admin queue.

---

## Phase-gate summary

| Phase | Gate (all must be true) |
|---|---|
| 0 | Engine property suite green · CI passes · docker compose up works |
| 1 | Reconciliation clean · corruption test freezes withdrawals · ledger immutable at DB level |
| 2 | Full market runs on a phone · duplicate trades execute once · receipt shows ₦0.00 platform cost |
| 3 | Outsider creates→funds→resolves a ticket · all void paths refund exactly · AI never self-publishes |
| 4 | Self-exclusion works · no-god-button test passes · SLA escalation fires |
| 5 | 10× load test holds · share/challenge loop works · abuse flags surface |

**Launch =** Phase 5 gate + the six official markets created + rulebook thresholds set + first-100-users plan ready.

---
*Bracketed values throughout remain founder-tunable config. Real-money features stay stubbed until licensing (architecture §9).*
