# Feature Matrix

Every feature in `platform-architecture.md` (§2.1–§2.16, §6, §7), audited against
the code as it stands, grouped by the build-plan blocks A–J.

**Status means:**

- **IMPLEMENTED** — built, wired to the real backend, and covered by a test or
  verified in a browser.
- **PARTIAL** — the substance exists but a named part of the spec is absent. The
  gap is stated, not glossed.
- **MISSING** — no code.

Read the PARTIALs, not the counts. A block that is 80% implemented can still be
unusable if the missing 20% is the thing a user reaches for.

_Audited: 2026-08-19, re-audited 2026-08-20 for blocks K, M and S/T. Branch
`claude/plugin-ktnja5`. Paths are from the repo root._

_Updated after building blocks C, E, F, G, H, I and J. The five rows still
short are named at the bottom; four of them are deferred by the spec itself
and the fifth is stated with its reason._

**Two of my own rows in the first audit were wrong**, and both are corrected
below:

- **E2 proof-of-reserves** was marked MISSING. `GET /admin/reserves` existed
  all along; what §2.10 actually specifies — the _signed export_ — did not.
- **I1 streaks** was marked as having no streak counter. The counter existed
  and was on the leaderboard; the badge award was the gap, and `topForecaster`
  had been exported and tested since step 13 with no caller.

A third thing neither the audit nor any test caught, found by looking at a
screenshot: every amber "needs attention" state in the admin console had
turned green when the redesign re-pointed `money` from gold. See the
`caution` role in `packages/tokens`.

---

## Summary

| Block                                             | Implemented | Partial | Missing |
| ------------------------------------------------- | ----------- | ------- | ------- |
| A · Ticket View (§7.2)                            | 27          | 0       | 0       |
| B · Wallet (§7.5)                                 | 7           | 1       | 0       |
| C · Community shelf (§2.4, §2.14a)                | 12          | 0       | 0       |
| D · Resolution & disputes (§2.6)                  | 9           | 0       | 0       |
| E · Admin platform (§6)                           | 17          | 0       | 0       |
| F · Company layer (§2.11–13)                      | 15          | 2       | 0       |
| G · Creator platform (§2.14)                      | 13          | 0       | 1       |
| H · Community threads (§2.15)                     | 10          | 0       | 2       |
| I · Engagement (§2.8)                             | 7           | 0       | 0       |
| J · Landing, routing, fintech (§7.6, §7.1, §2.16) | 13          | 1       | 0       |
| K · Ticket-creation checklist                     | 5           | 0       | 0       |
| M · Market intelligence layer                     | 5           | 1       | 0       |
| S/T · Studio and ticket surface                   | 6           | 0       | 0       |

The shape of it: the **money core and the engine are the strongest part** of this
codebase — ledger, escrow, pricing, payouts and the four-eyes workflow are all
real and tested.

**One correction to that sentence, which used to include reconciliation.** §2.7's
nightly reconciliation was written and tested and had no caller: nothing ever
ran it, which is why the admin dashboard read `reconciliation never-run` from
the day it was built. It runs nightly now. The lesson generalised into
`scripts/check-wiring.mjs`, which fails the build when nothing calls a service
— tests prove a unit works and say nothing about whether it is reachable. The **thinnest parts are the moments around a
trade**: what a market looks like while it is still funding, what it looks like
once it has resolved, and what the trade sheet tells you about your own limits.

---

## Block A · Ticket View (§7.2)

The market detail page. Currently `apps/web/src/components/ticket-view.tsx`,
laid out per `docs/design-reference.html`'s `#detail`.

| §    | Feature                                                                | Status          | Evidence / gap                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.2a | Area probability chart, 0–100%                                         | **IMPLEMENTED** | `components/price-chart.tsx` (lightweight-charts)                                                                                                                                |
| 7.2a | Timeframes 1H · 6H · 1D · 1W · ALL                                     | **IMPLEMENTED** | `price-chart.tsx:20` `TIMEFRAMES`                                                                                                                                                |
| 7.2a | Event annotations pinned on the chart                                  | **IMPLEMENTED** | `price-chart.tsx`, fed by `market_annotations` via `GET /markets/:id`                                                                                                            |
| 7.2a | Multi-outcome overlay, tap to isolate                                  | **IMPLEMENTED** | `price-chart.tsx:62` `isolated` state                                                                                                                                            |
| 7.2a | Live points appended over WebSocket                                    | **IMPLEMENTED** | `hooks/use-market-feed.ts`, `store/live-prices.ts`                                                                                                                               |
| 7.2a | **Candlestick toggle for power users**                                 | **IMPLEMENTED** | `price-chart.tsx` candles toggle; OHLC buckets in `lib/candles.ts` (7 tests)                                                                                                     |
| 7.2b | Argument bar, synced to last point                                     | **IMPLEMENTED** | `components/argument-bar.tsx`, rendered in the chart box                                                                                                                         |
| 7.2c | Money strip: pot, 24h volume, traders, fee                             | **IMPLEMENTED** | `ticket-view.tsx` stats row, with the pot-growth sparkline drawn from the pot column `history` already returns                                                                   |
| 7.2d | Bottom-sheet Trade Ticket                                              | **IMPLEMENTED** | `components/trade-sheet.tsx`, opened from grid and ticket                                                                                                                        |
| 7.2d | Priced outcome buttons (`Buy YES 62k`)                                 | **IMPLEMENTED** | `components/market/side-button.tsx`, `market-card.tsx`                                                                                                                           |
| 7.2d | Amount-first entry with ₦500/1k/2k/5k chips                            | **IMPLEMENTED** | `trade-sheet.tsx` `AMOUNT_CHIPS`                                                                                                                                                 |
| 7.2d | Live figures: price, shares, total, est. to win, slippage              | **IMPLEMENTED** | `lib/trade-quote.ts`, rendered in sheet and `market/trade-panel.tsx`                                                                                                             |
| 7.2d | One-tap side-flip arrow                                                | **IMPLEMENTED** | `trade-sheet.tsx` `ArrowUpDown` control                                                                                                                                          |
| 7.2d | **Advanced toggle → shares-entry with −100/−10/+10/+100**              | **IMPLEMENTED** | `trade-sheet.tsx` mode toggle; inverse quote `costOfShares` in `lib/trade-quote.ts`                                                                                              |
| 7.2d | Selling through the same sheet                                         | **IMPLEMENTED** | `trade-sheet.tsx` — slider for partial exits, exact refund quoted before confirm                                                                                                 |
| 7.2d | **Tier 0 starter-balance cap surfaced inline**                         | **IMPLEMENTED** | `lib/trade-allowance.ts` + `GET /account/trade-allowance`. The cap itself did not exist server-side and was built: `trade/tier-cap.ts` (8 tests), enforced in `trade.service.ts` |
| 7.2d | **RG limit warnings surfaced inline (§2.12)**                          | **IMPLEMENTED** | `blockerFor()` reads the same RG figures `assertMayStake` enforces                                                                                                               |
| 7.2d | Sheet behaviours: drag-to-dismiss, disabled-with-reason                | **IMPLEMENTED** | `trade-sheet.tsx` drag handlers; `closedReason()`                                                                                                                                |
| 7.2e | **Community FUNDING state: activation view replacing the chart**       | **IMPLEMENTED** | `market/funding-activation.tsx` — per-side and backer meters, countdown, seed composition, share-to-fill; replaces the chart box                                                 |
| 7.2e | Activation moment permanently annotated                                | **IMPLEMENTED** | `activation` annotation type written by the lifecycle job                                                                                                                        |
| 7.2f | Take thread with position badges                                       | **IMPLEMENTED** | `components/take-thread.tsx`                                                                                                                                                     |
| 7.2f | Rules card (criteria, source, dates, freeze)                           | **IMPLEMENTED** | `components/rules-card.tsx`                                                                                                                                                      |
| 7.2f | **Resolution status: proposed outcome + evidence + dispute countdown** | **IMPLEMENTED** | `market/resolution-status.tsx`; detail endpoint now returns `resolution` + `disputeClosesAt`                                                                                     |
| 7.2f | Share button                                                           | **IMPLEMENTED** | `components/share-sheet.tsx`                                                                                                                                                     |
| 7.2f | **Challenge button on the ticket**                                     | **IMPLEMENTED** | `market/challenge-button.tsx`, minting through the existing service                                                                                                              |
| 7.2g | **Resolved state: receipt panel with payout math**                     | **IMPLEMENTED** | `market/resolved-receipt.tsx` + `GET /markets/:id/receipt`, read from the ledger so it cannot disagree with the books                                                            |
| 7.2g | Chart freezes with a final ✓ annotation                                | **IMPLEMENTED** | `resolution` annotation type                                                                                                                                                     |
| 7.2g | Thread receipts light up at resolution                                 | **IMPLEMENTED** | `take-thread.tsx` keeps badges permanently                                                                                                                                       |

> **Built 2026-08-19.** Every row above is now IMPLEMENTED. One thing was built
> outside §7.2 to get there, deliberately: §7.2d requires the Tier 0 cap to be
> shown in the sheet, and **no such cap existed anywhere in the API** — §2.1
> names it as a fraud control but nothing enforced it. A warning about a limit
> that does not exist is worse than no warning, so the rule was built first
> (`apps/api/src/trade/tier-cap.ts`, 8 tests, enforced in the one path stake
> leaves a balance through) and only then surfaced. That is a §2.1 addition
> reached through a §7.2 requirement, and it is called out here rather than
> buried in the diff.

**Block A verdict (before this build):** the chart, the trade sheet and the thread are solid. The
gaps cluster in the two states that are not "market is open and I want to buy":
**funding** and **resolved**. Plus the sheet does not know about the user's own
limits, which is a spec requirement and a real refusal-after-submit annoyance.

---

## Block B · Wallet (§7.5, §2.2)

| §   | Feature                                                       | Status          | Evidence / gap                                                                                                                                 |
| --- | ------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.2 | Double-entry append-only ledger, typed rows                   | **IMPLEMENTED** | `apps/api/src/ledger/`, ledger grants migration                                                                                                |
| 2.2 | `available` / `escrowed` split                                | **IMPLEMENTED** | `apps/api/src/wallet/wallet.service.ts`                                                                                                        |
| 2.2 | Escrow moves on stake/payout/refund                           | **IMPLEMENTED** | `wallet.service.ts`, `trade/`                                                                                                                  |
| 2.2 | Per-market invariant: payouts + fees ≤ pot                    | **IMPLEMENTED** | `packages/engine` property tests; `hardening/ledger-audit`                                                                                     |
| 2.2 | Currency field (SPC now, NGN later)                           | **IMPLEMENTED** | Prisma `ledger.currency`                                                                                                                       |
| 7.5 | Balance header: available vs in-open-markets                  | **IMPLEMENTED** | `apps/web/src/app/wallet/page.tsx`                                                                                                             |
| 7.5 | Transaction history in plain language                         | **IMPLEMENTED** | `app/wallet/page.tsx` — ledger-backed, now filterable by kind (stakes, wins, exits, fees, bonuses, bonds)                                      |
| 7.5 | **Monthly statement download + per-transaction receipt view** | **IMPLEMENTED** | `GET /me/wallet/statement?month=` returns CSV built from the ledger; each row expands to its receipt (exact amount, reference, ledger id)      |
| 7.5 | Deposit/Withdraw actions                                      | **PARTIAL**     | Correctly absent in points mode; the fintech interfaces are stubbed (Block J). Wallet shows points, history and prize credits as the spec asks |

---

> **Built 2026-08-19.** The wallet was also the last screen still wearing the
> pre-redesign `AppHeader` — a second visual style, which the build rules
> forbid. It now uses `SiteHeader`, the shared page width and the mobile nav.
> The one remaining PARTIAL is deliberate: deposit and withdrawal are correctly
> absent in points mode, and the fintech interfaces they will hang off are
> stubbed (Block J). Building the buttons before the rails exist would be
> theatre.

## Block C · Community shelf (§2.4, §2.5, §2.14a)

| §     | Feature                                                                                                 | Status          | Evidence / gap                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.4   | Lifecycle state machine                                                                                 | **IMPLEMENTED** | `apps/api/src/market/market-state.ts`                                                                                                                 |
| 2.4   | Path A organic activation + auto-void refund                                                            | **IMPLEMENTED** | `community/activation.ts` + `activation.test.ts`                                                                                                      |
| 2.4   | Path A multi-outcome amended rule (total pot + ≥2 funded)                                               | **IMPLEMENTED** | `community/activation.ts`                                                                                                                             |
| 2.4   | Path B symmetric seed, server-enforced equal split                                                      | **IMPLEMENTED** | `community/` seed service                                                                                                                             |
| 2.4   | Participation floor re-check at window close                                                            | **IMPLEMENTED** | `community/activation.ts`                                                                                                                             |
| 2.4   | Syndicates: rounds, caps, fee-split locked at open                                                      | **IMPLEMENTED** | `community/`, Rulebook Part 3 §3 worked examples tested                                                                                               |
| 2.5   | Template-only creation with server validation                                                           | **IMPLEMENTED** | `community/market-template.ts`                                                                                                                        |
| 2.5   | Conduct bond escrowed on creation                                                                       | **IMPLEMENTED** | `bonds` table, approvals-gated forfeit                                                                                                                |
| 2.5   | Creator cannot take directional stakes in own market                                                    | **IMPLEMENTED** | Trade endpoint guard                                                                                                                                  |
| 2.14a | Creation wizard: natural input → AI restructure → balance meter → earnings preview → path choice → bond | **IMPLEMENTED** | `apps/web/src/app/create/page.tsx`, `components/balance-meter.tsx`                                                                                    |
| 2.14a | Ticket suggestion library                                                                               | **IMPLEMENTED** | `ticket_templates`, surfaced in the wizard                                                                                                            |
| 2.14a | **Wizard restyled to the new design system**                                                            | **IMPLEMENTED** | `components/market/page-shell.tsx` — one frame for every screen, header, width and phone nav included                                                 |
| 2.5   | **Banned-topic human review queue for first-time creators**                                             | **IMPLEMENTED** | `community/draft-ranking.ts` `byQueuePriority` + badge in `app/admin/drafts`. The routing always existed; the flag moved nothing — see the note above |

---

## Block D · Resolution & disputes (§2.6)

| §   | Feature                                           | Status          | Evidence / gap                                                                              |
| --- | ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| 2.6 | Propose resolution (creator/staff) with evidence  | **IMPLEMENTED** | `apps/api/src/resolution/resolution-flow.service.ts`                                        |
| 2.6 | 48h dispute window state + timer                  | **IMPLEMENTED** | `resolution-flow.service.ts`, `disputeClosesAt` column                                      |
| 2.6 | Dispute filing with named-source evidence         | **IMPLEMENTED** | `disputes` table, admin decision flow                                                       |
| 2.6 | Resolver review → final resolution → payout batch | **IMPLEMENTED** | `trade/resolution.service.ts`, chunked resumable payouts                                    |
| 2.6 | Bonds refunded/forfeited on outcome               | **IMPLEMENTED** | Approvals-gated                                                                             |
| 2.6 | Void path at every state, full refund, zero fees  | **IMPLEMENTED** | `resolution-flow.integration.test.ts`                                                       |
| 2.6 | Immutable resolution log                          | **IMPLEMENTED** | `admin_audit`, append-only                                                                  |
| 2.6 | **User-facing dispute filing UI**                 | **IMPLEMENTED** | `market/resolution-status.tsx` posts to the existing `POST /community/markets/:id/disputes` |
| 2.6 | **Dispute-window countdown on the ticket**        | **IMPLEMENTED** | `market/resolution-status.tsx`                                                              |

---

## Block E · Admin platform (§6, nine screens, no-god-button)

| §    | Screen / rule                                                                       | Status          | Evidence / gap                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | Dashboard (reconciliation, escrow, volume, queues, SLAs)                            | **IMPLEMENTED** | `apps/web/src/app/admin/page.tsx`, `admin/solvency.service.ts`                                                                                                       |
| 6.2  | Markets console: official create, AI drafts queue                                   | **IMPLEMENTED** | `app/admin/drafts/page.tsx`                                                                                                                                          |
| 6.2  | Community review queue with AI scores                                               | **IMPLEMENTED** | `app/admin/drafts/`, `market_drafts`                                                                                                                                 |
| 6.2  | **Lifecycle controls: funding checks, post-activation void, seed composition view** | **IMPLEMENTED** | `app/admin/lifecycle`, `http/admin-ops.controller.ts`. Void stays four-eyes; this is the view that was missing                                                       |
| 6.3  | Resolution centre, side-by-side evidence                                            | **IMPLEMENTED** | `app/admin/resolution/page.tsx`                                                                                                                                      |
| 6.4  | Money room: ledger explorer, reconciliation history, fund classes                   | **IMPLEMENTED** | `app/admin/money/page.tsx`                                                                                                                                           |
| 6.4  | Approvals inbox, first/second approver                                              | **IMPLEMENTED** | `app/admin/approvals/page.tsx`, `approvals/`                                                                                                                         |
| 6.4  | **Proof-of-reserves export**                                                        | **IMPLEMENTED** | `admin/reserves-export.ts` — signed, canonicalised, 8 tests. `GET /admin/reserves` already existed; the _export_ did not                                             |
| 6.4b | **Platform Config Console**                                                         | **IMPLEMENTED** | `app/admin/config` + `platform-config/config-notes.ts` — blast radius per key, pending diffs with the clock. Step-up is on the approve endpoint, not the read screen |
| 6.5  | Users & Trust/Safety, abuse queue, moderation queue                                 | **IMPLEMENTED** | `app/admin/moderation/page.tsx`, `hardening/abuse.service.ts`                                                                                                        |
| 6.6  | **Creators desk**                                                                   | **IMPLEMENTED** | `app/admin/creators` — levels, clean rate, bonds held. Bond forfeit stays in the approvals inbox by design                                                           |
| 6.7  | Support desk with SLA timers                                                        | **IMPLEMENTED** | `app/admin/support/page.tsx`, `support/support.service.ts`                                                                                                           |
| 6.8  | Content & growth: prize runs, analytics                                             | **IMPLEMENTED** | `app/admin/prizes/`, `app/admin/analytics/`                                                                                                                          |
| 6.8  | **Top Calls curation, notification broadcasts, feature flags UI**                   | **IMPLEMENTED** | `app/admin/growth` — flags ramp by percentage, broadcasts need a second pair of eyes to send                                                                         |
| 6.9  | **System room (queues, deploys, alerts, restore drills)**                           | **IMPLEMENTED** | `app/admin/system` — queue depths, key rotation status, canaries, restore-drill log                                                                                  |
| 6.10 | **Command palette, saved views, work-queue auto-advance**                           | **IMPLEMENTED** | `components/admin/command-palette.tsx`, `components/admin/work-queue.ts`. Both have real callers                                                                     |
| 6.11 | Role → screen matrix in middleware                                                  | **IMPLEMENTED** | Roles guard + permission matrix, tested                                                                                                                              |
| 6    | **No-god-button**                                                                   | **IMPLEMENTED** | Balance mutation only via approvals; test asserts it                                                                                                                 |

---

## Block F · Company layer (§2.11–§2.13)

| §    | Feature                                                 | Status          | Evidence / gap                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.11 | Least-privilege role matrix in middleware               | **IMPLEMENTED** | Roles guard                                                                                                                                                                                                                 |
| 2.11 | `admin_audit` on every admin mutation                   | **IMPLEMENTED** | `audit/admin-audit.service.ts`                                                                                                                                                                                              |
| 2.11 | Staff TOTP 2FA + step-up on sensitive actions           | **IMPLEMENTED** | `auth/`, secrets encrypted at rest                                                                                                                                                                                          |
| 2.11 | Abuse detection: wash trading, stake floods, clusters   | **IMPLEMENTED** | `hardening/abuse.ts` + tests                                                                                                                                                                                                |
| 2.11 | **PII encryption at rest + field-level access logging** | **PARTIAL**     | Read log done and enforced (`audit/pii-access.service.ts`, masked by default). **Phone/email are still plaintext at rest** — `auth/pii.ts` has the blind-index mechanism, the migration is deliberately not done: see below |
| 2.11 | **Secrets manager with rotation**                       | **IMPLEMENTED** | `config/secrets.ts` + rotation-aware `secret-box.ts`, 10 tests                                                                                                                                                              |
| 2.12 | RG: limits, cool-off, self-exclusion                    | **IMPLEMENTED** | `rg/rg.service.ts`, self-exclusion blocks trading, permits withdrawal                                                                                                                                                       |
| 2.12 | Session reality-check after 60 min                      | **IMPLEMENTED** | `components/reality-check.tsx`                                                                                                                                                                                              |
| 2.12 | Support ticketing with SLA escalation                   | **IMPLEMENTED** | `support/`                                                                                                                                                                                                                  |
| 2.12 | Status page + incidents                                 | **IMPLEMENTED** | `status/`, `app/status/page.tsx`                                                                                                                                                                                            |
| 2.12 | Notifications: in-app, email, SMS, preferences          | **IMPLEMENTED** | `notifications/`, honest delivery reporting tested                                                                                                                                                                          |
| 2.13 | Test suite: property, integration, load, e2e            | **IMPLEMENTED** | `packages/engine` fast-check, k6 (`docs/loadtest.md`), Playwright                                                                                                                                                           |
| 2.13 | CI/CD with staging + canary                             | **PARTIAL**     | Flag service with sticky percentage rollout built and wired (`flags/`, 8 tests). **The deploy workflow does not yet gate on it** — a pipeline change                                                                        |
| 2.13 | Observability: metrics, traces, alerts                  | **IMPLEMENTED** | `observability/`, prom-client                                                                                                                                                                                               |
| 2.13 | **Backups & restore drills**                            | **IMPLEMENTED** | `scripts/ops/backup.sh`, `scripts/ops/restore-drill.sh`, `docs/backup-and-restore.md`, surfaced in the system room                                                                                                          |
| 2.13 | Localisation scaffolding                                | **IMPLEMENTED** | `next-intl`, `messages/en-NG.json`                                                                                                                                                                                          |

---

## Block G · Creator platform (§2.14)

| §     | Feature                                                        | Status          | Evidence / gap                                                                                 |
| ----- | -------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| 2.14a | Creation wizard (see Block C)                                  | **IMPLEMENTED** | `app/create/page.tsx`                                                                          |
| 2.14b | Opportunity feed: calendar + unmet-search-demand               | **IMPLEMENTED** | `creator/`, `opportunities` table                                                              |
| 2.14c | Progression ladder as pure rules                               | **IMPLEMENTED** | `creator/` ladder module + tests                                                               |
| 2.14c | Level privileges actually bind                                 | **IMPLEMENTED** | Enforced at creation                                                                           |
| 2.14c | Public creator profiles                                        | **IMPLEMENTED** | `app/c/[handle]/page.tsx`                                                                      |
| 2.14c | Follow system + new-market notification                        | **IMPLEMENTED** | `followers` table, notification on open                                                        |
| 2.14d | Share kit (`@vercel/og` cards)                                 | **IMPLEMENTED** | `app/api/share/[id]/route.tsx`                                                                 |
| 2.14d | Creator analytics (views→stakes, sources)                      | **IMPLEMENTED** | `creator/analytics.service.ts`                                                                 |
| 2.14d | Nudge engine                                                   | **IMPLEMENTED** | `creator/` nudges                                                                              |
| 2.14d | Market autopsies feeding §2.9                                  | **IMPLEMENTED** | `creator/autopsy.service.ts`                                                                   |
| 2.14e | Duplicate detection at creation                                | **IMPLEMENTED** | `community/` duplicate check                                                                   |
| 2.14e | **Conflict-of-interest attestation + auto-void risk warnings** | **IMPLEMENTED** | `community/void-risk.ts` (9 tests) surfaced in the wizard; attestation asked plainly beside it |
| 2.14d | **Creator studio restyled to the reference**                   | **IMPLEMENTED** | `app/studio/page.tsx` on `PageShell`                                                           |
| 2.14f | **Creator community channel**                                  | **MISSING**     | Out of scope for the app; spec says WhatsApp/Telegram initially                                |

---

## Block H · Community threads (§2.15)

| §     | Feature                                                            | Status          | Evidence / gap                                                                                              |
| ----- | ------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------- |
| 2.15a | Take threads on the market page                                    | **IMPLEMENTED** | `components/take-thread.tsx`, `http/threads.controller.ts`                                                  |
| 2.15a | Position badges on comments                                        | **IMPLEMENTED** | `community-layer/badges.ts` + tests                                                                         |
| 2.15a | Prediction receipts persist at resolution                          | **IMPLEMENTED** | Badge snapshot stored on the comment                                                                        |
| 2.15a | Reason prompt at trade time feeding the thread                     | **IMPLEMENTED** | `trade-sheet.tsx`, `trade-panel.tsx`                                                                        |
| 2.15a | Tier 1 + eligibility gate on commenting                            | **IMPLEMENTED** | Threads controller guard                                                                                    |
| 2.15d | Challenge links                                                    | **IMPLEMENTED** | `community-layer/challenge.service.ts`, `app/challenge/[token]/page.tsx`                                    |
| 2.15d | **Challenge mint button on the ticket**                            | **IMPLEMENTED** | `market/challenge-button.tsx` — see Block A                                                                 |
| 2.15e | Moderation queue + tipster auto-flags                              | **IMPLEMENTED** | `app/admin/moderation/page.tsx`                                                                             |
| 2.15b | **Forecasting reputation: accuracy, calibration, category titles** | **IMPLEMENTED** | `community-layer/reputation.ts` + `.service.ts`, 16 tests. Brier rescaled so no-skill reads as 0            |
| 2.15b | **Weekly Top Calls**                                               | **IMPLEMENTED** | `proposeTopCalls`, `GET /top-calls`, curated in `app/admin/growth`                                          |
| 2.15c | **Squads**                                                         | **MISSING**     | Tables exist; no code. Spec defers to post-launch                                                           |
| 2.15d | **Resolution-day recap cards**                                     | **IMPLEMENTED** | Distribution wired into `resolution-flow.service.ts` — every holder gets the link, winners and losers alike |
| 2.15c | **Squad vs Squad challenges**                                      | **MISSING**     | Post-launch per §2.15f                                                                                      |

_Titles and Top Calls are now built. The two Squad rows are the only ones left,
and §2.15f explicitly sequences them as post-launch — they are on-plan, not
behind._

---

## Block I · Engagement (§2.8)

| §    | Feature                                           | Status          | Evidence / gap                                                                                                      |
| ---- | ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 2.8  | Weekly + all-time leaderboards (profit, accuracy) | **IMPLEMENTED** | `leaderboard/leaderboard.service.ts`, `app/leaderboard/page.tsx`                                                    |
| 2.8  | Leaderboard snapshots                             | **IMPLEMENTED** | `leaderboard/snapshot` job                                                                                          |
| 2.8  | Shareable market cards                            | **IMPLEMENTED** | `app/api/share/[id]/route.tsx`                                                                                      |
| 2.8  | Prize distribution tool with four-eyes            | **IMPLEMENTED** | `leaderboard/prize.service.ts`, `app/admin/prizes/`                                                                 |
| 2.8  | Analytics events taxonomy                         | **IMPLEMENTED** | `analytics/events.ts`                                                                                               |
| 2.8  | **Streaks and "Top Forecaster" badges**           | **IMPLEMENTED** | `awardTopForecaster` in `leaderboard.service.ts`. The streak counter already existed; `topForecaster` had no caller |
| 2.17 | **Referral programme**                            | **IMPLEMENTED** | `account/referral.service.ts` — paid on stake, not signup; same-device and same-mailbox checks                      |

---

## Block J · Landing, routing, fintech (§7.6, §7.1, §2.16)

| §    | Feature                                                                        | Status          | Evidence / gap                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | Markets home, both shelves, filters                                            | **IMPLEMENTED** | `app/page.tsx`, `app/markets/page.tsx`                                                                                                                                                       |
| 7.1  | Market card: %, sparkline, pot, state badge                                    | **IMPLEMENTED** | `components/market/market-card.tsx`                                                                                                                                                          |
| 7.1  | Search                                                                         | **IMPLEMENTED** | Header search filters the catalogue server-side                                                                                                                                              |
| 7.1  | **Search feeding unmet-demand capture (§2.14b)**                               | **IMPLEMENTED** | `components/market/search-demand.tsx` — the recording endpoint existed and nothing called it                                                                                                 |
| 7.1  | My positions                                                                   | **IMPLEMENTED** | `components/position-panel.tsx` on the ticket                                                                                                                                                |
| 7.1  | **A dedicated positions/portfolio screen**                                     | **IMPLEMENTED** | `app/positions/page.tsx`                                                                                                                                                                     |
| 7.6  | **Public landing page**                                                        | **IMPLEMENTED** | `app/welcome/page.tsx` — at `/welcome`, not `/`; §7.6 in the architecture records the divergence                                                                                             |
| 7.6  | SEO-complete server-rendered market pages                                      | **IMPLEMENTED** | `/market/[id]` SSR with OG cards, sitemap, robots                                                                                                                                            |
| 2.16 | PaymentProvider interface + adapters stubbed                                   | **IMPLEMENTED** | `apps/api/src/integrations/{paystack,flutterwave}.stub.ts`                                                                                                                                   |
| 2.16 | KYC provider stubbed                                                           | **IMPLEMENTED** | `integrations/smileid.stub.ts`                                                                                                                                                               |
| 2.16 | SMS provider (Termii) with interface                                           | **IMPLEMENTED** | `integrations/termii.ts`                                                                                                                                                                     |
| 2.16 | Fintech endpoints (`/wallet/deposit-account`, withdrawals, statement, webhook) | **PARTIAL**     | Correctly not built in points mode. **The webhook idempotency rule is now built and tested** (`integrations/webhook-idempotency.ts`, 9 tests); the endpoints themselves wait for the licence |
| 2.18 | Legal pages in-app                                                             | **IMPLEMENTED** | `/rules`, `/privacy`, `/faq`, `/support`                                                                                                                                                     |
| 2.18 | **Account recovery, SIM-swap freeze, session/device management**               | **IMPLEMENTED** | `account/sessions.service.ts`, `account/freeze.service.ts`, `app/account/page.tsx`                                                                                                           |
| 2.18 | Consent versioning                                                             | **IMPLEMENTED** | `account/consent.service.ts`, `consents` table append-only, marketing kept separate per NDPA                                                                                                 |

---

## Block K · The ticket-creation checklist as operating law (`docs/ticket-creation-checklist.md`)

| #   | Feature                                                                                           | Status      | Where                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| K1  | All 49 rules encoded once, shared by AI, wizard and community                                     | IMPLEMENTED | `packages/rules/src/registry.ts`, `validators.ts`                   |
| K2  | CI fails if a documented rule has no validator                                                    | IMPLEMENTED | `packages/rules/src/__tests__/checklist-sync.test.ts`               |
| K3  | Parts 1–3 and 6 in the generation prompt verbatim; self-rejection logged and shown                | IMPLEMENTED | `packages/rules/src/prompt.ts`, Studio Suggestions tab              |
| K4  | Community creation identical but stricter — templates or co-pilot only, attestation, review queue | IMPLEMENTED | `question-engine.service.ts` (`checkOrigin`), `template-library.ts` |
| K5  | Part 5 monitoring on a sweep; post-mortems carry the flags that fired                             | IMPLEMENTED | `market/health.service.ts`, `creator/autopsy.ts`                    |

Two things worth naming. The wizard's **pre-publish review screen** runs the
whole checklist with the two judgement prompts and the conflict check as
explicit confirmations, and `publish()` refuses on `report.blocked` regardless
of what the screen showed — the screen is a courtesy, the service is the rule.
And the create form **collected the influence attestation and dropped it**, so
rule 16 failed every submission made through the real UI while every
service-level test passed by supplying it directly; it is a required DTO field
now.

---

## Block M · Market intelligence layer

| #   | Feature                                                      | Status      | Where                                                                                                                                    |
| --- | ------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Tiered source registry, bulk import, trust, kill switches    | IMPLEMENTED | `intel/source-registry.service.ts`, `POST /admin/studio/sources/import`                                                                  |
| M2  | Continuous research pipeline — cluster, link, flag conflicts | IMPLEMENTED | `intel/research.service.ts` on a five-minute sweep; `intel/http-fetcher.ts` reads RSS/Atom for real. Off unless `RESEARCH_FETCHER=http`. |
| M3  | Evidence-backed AI drafts                                    | IMPLEMENTED | `intel/briefing.service.ts`, Studio Suggestions tab                                                                                      |
| M4  | Streaming context on the live ticket                         | IMPLEMENTED | `markets.controller.ts` `:id/context`, `market/context-panel.tsx`                                                                        |
| M5  | Resolution dossiers — AI proposes, humans decide             | IMPLEMENTED | `intel/dossier.service.ts`, Resolution Centre panel                                                                                      |
| M6  | Crawl health, guardrails, cost controls                      | IMPLEMENTED | `intel/crawl-health.service.ts`, Studio Research tab                                                                                     |

M2 was this block's PARTIAL and is now closed for feeds. `HttpFetcher`, wrapped
in `PoliteFetcher`, does conditional requests (ETag / If-Modified-Since, 304),
honours `robots.txt` before the first read, dedupes on guid as well as URL, and
never throws — a source having a bad day costs one pass, not the sweep.
`http-fetcher.integration.test.ts` drives the whole path over a real socket.

Two things remain true and are stated rather than glossed. **HTML extraction is
not built**, so a `crawl` or `sitemap` source is registered and visibly not
read rather than silently returning nothing; the verified finding that pushed
this up the list is that CAF — the source rated most likely to have a feed —
publishes none. And **nothing is switched on in production**: the fetcher binds
only when `RESEARCH_FETCHER=http` is set, and it is not.

**The safety property is structural, not a promise.** No automated path can
settle a market: `no-automated-settlement.integration.test.ts` asserts the
dossier service cannot reach the resolution flow, the ledger or market state,
and asserts the same of the three dossier endpoints — verified to fail when a
call to the resolution flow is added to one.

---

## Block S/T · Market Studio and the ticket surface

| #   | Feature                                                            | Status      | Where                                                                 |
| --- | ------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------- |
| S1  | Studio shell, Manage tab with Part 5 flags                         | IMPLEMENTED | `app/admin/markets/page.tsx`                                          |
| S2  | Create wizard with the live checklist and pre-publish review       | IMPLEMENTED | `create-tab.tsx`, `market/studio.service.ts`                          |
| S3  | Library: template curation, recurring markets; duplicate detection | IMPLEMENTED | `library-tab.tsx`, `studio.service.ts` (`repeatable`, `nextInSeries`) |
| T1  | Ticket chart: multi-outcome lines, live dot, scrub, annotations    | IMPLEMENTED | `components/market/`                                                  |
| T2  | Ticket information header                                          | IMPLEMENTED | `components/market/`                                                  |
| T3  | Context panel: rules, source watch, news, key stats, activity      | IMPLEMENTED | `market/context-panel.tsx`                                            |

A repeat opens as a **draft**, never as a market, and the full checklist runs on
it — a repeat is exactly the market that gets waved through because the last one
was fine.

---

## Block P · Market freeze (§2.3, checklist rule 22)

| #   | Feature                                                                  | Status      | Where                                                      |
| --- | ------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------- |
| P1  | `freezeAt` at creation, event less a configurable buffer, state `frozen` | IMPLEMENTED | `packages/rules/src/freeze.ts`, `freeze_buffer_seconds`    |
| P2  | Server-side refusal of buys **and** sells at execution time              | IMPLEMENTED | `trade.service.ts` `lockAndLoad`                           |
| P3  | Scheduled sweep, idempotent, with annotation, audit and notification     | IMPLEMENTED | `market/freeze.service.ts`, `freeze-sweep` job             |
| P4  | Countdown from creation, final-hour clock, badge, inline refusals        | IMPLEMENTED | `components/market/freeze-notice.tsx`                      |
| P5  | Emergency freeze, four-eyes unfreeze, freeze desk                        | IMPLEMENTED | `POST /admin/studio/markets/:id/freeze`, `market.unfreeze` |

**Where the rule actually binds is the trade transaction, not the job.** The
sweep runs on a schedule and a schedule can be late, so the money path reads
the clock itself, inside the transaction, after the row lock — which is what
refuses a trade that queued before the freeze and reached the front after it.
`market/freeze.integration.test.ts` drives that case through the real Redis
queue.

Two decisions worth recording. The freeze is **the earlier of `freezeAt` and
`eventDate`**, so no amendment or hand-edit can leave a market trading after its
event has started. And it blocks **exits as well as entries**: a half-freeze
would let somebody who has seen the score sell a losing position to somebody who
has not, which is worse than no freeze at all because it looks protective.

Freezing takes one person and a reason; reopening takes two, through the same
approvals inbox as a void or a bond forfeiture, and only from `frozen` — never
from a dispute window or a settled market.

**Not done, and deliberately:** no withdrawal lock near settlement. Escrow
already holds staked funds from the moment of the trade, and free balance stays
withdrawable throughout.

---

## What is left

All five of the original "fix first" items are built (A1, A2, A3, dispute
filing, and the §7.6 landing page — at `/welcome`, with the divergence
recorded in the architecture). What remains:

**Deferred by the spec itself, not behind:**

1. **Squads and Squad-vs-Squad (§2.15c).** §2.15f sequences these as
   post-launch, into a season moment.
2. **Creator community channel (§2.14f).** The spec says WhatsApp or Telegram
   initially — it is not an app feature.
3. **Deposit and withdrawal (§7.5, §2.16).** Correctly absent in points mode.
   The interfaces are stubbed and the webhook idempotency rule is now built
   and tested, which was the one piece worth having before the licence rather
   than after.

**Genuinely short, with reasons:**

4. **Phone and email are still plaintext at rest (§2.11).** The read side is
   done — contacts are masked in the console and every reveal is logged to an
   append-only table before the value is returned, which is where the real
   exposure was. Encryption at rest needs a blind index, because sealing a
   contact with a random IV destroys both the login lookup and the uniqueness
   constraint; that mechanism is built and tested in `auth/pii.ts`. What is
   not done is the migration, because it rewrites how login finds an account
   and neither Postgres nor Redis was available in the environment this was
   built in, so the integration suites that would prove auth still works are
   skipped. Shipping that unverified would be reckless. It is a separate,
   verifiable change.

5. **The deploy pipeline does not gate on feature flags (§2.13).** The flag
   service is built, tested and wired into the app, with sticky percentage
   rollout that only ever adds people as a canary ramps. Making the deploy
   workflow itself consult it is a CI change rather than an application one.

6. **`MarketService` is dead code kept alive by a test.** Nothing in production
   injects it; `trade.integration.test.ts` uses `create()` for fixtures. It is
   allowlisted in `scripts/check-wiring.mjs` marked DEBT. Clearing it means
   moving that suite's fixtures onto the paths production actually uses.

7. **HTML extraction is not built.** Feeds are read; a page is not. Most
   Nigerian official bodies — CBN, NBS, NNPC, INEC, and now CAF, checked and
   confirmed feedless — publish HTML, so each needs a per-source rule: the page,
   the element carrying the release, and the figure inside it. Registered
   sources of those kinds say `needs HTML extraction` on the Research tab rather
   than reading `stale`, so the gap is visible rather than silent. See
   `docs/research-sources.md`.

**Not a gap but worth a decision:** the admin console is light, following the
design reference. §6.10 originally specified an ink-green dark theme, and the
architecture now records why it is not. Reversing it means restoring real
values to `semantic.dark` in `packages/tokens`.

---

## Method and limits

Verified by reading the four documents in full, then auditing the tree: 27 web
routes, 12 API controllers, 20 API modules, `packages/engine`, `packages/tokens`.
Statuses come from reading the code, plus browser verification of the screens
touched in this session's redesign.

Two honest limits on this audit:

- **"IMPLEMENTED" means the code exists and its tests pass**, not that it has been
  exercised against production data. Two API tests
  (`auth/token-revocation.test.ts`) need a real Redis and cannot run in this
  sandbox; the Playwright e2e suite needs Postgres + Redis and was not run.
- **Some PARTIALs are judgement calls.** Where a feature works but a named part
  of the spec is absent, I marked it PARTIAL rather than IMPLEMENTED even when
  the missing part is small — the gap is written out in every case so you can
  disagree with the grade and still see the fact.

---

## Screenshots

`docs/walkthrough/blocks-c-j/` — every screen built for blocks C–J, shot
against a stub API at both 390px and 1440px where the layout differs:

| File                                                 | Screen                                               |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `J3-welcome-desktop.png`, `J3-welcome-phone.png`     | §7.6 landing page                                    |
| `J2-positions-desktop.png`, `J2-positions-phone.png` | §7.1 portfolio                                       |
| `J5-J6-account-phone.png`                            | §2.18 sessions, freeze, consents, referrals          |
| `C1-wizard-phone.png`                                | §2.14a wizard on the shared frame, with §2.14e risks |
| `G2-studio-desktop.png`                              | §2.14d studio on the shared frame                    |
| `E1-lifecycle.png`                                   | §6.2 funding windows and composition                 |
| `E3-config.png`                                      | §6.4b config console with blast radius               |
| `E4-creators.png`                                    | §6.6 creators desk                                   |
| `E5-growth.png`                                      | §6.8 flags, broadcasts, Top Calls                    |
| `E6-system.png`                                      | §6.9 system room                                     |
| `E7-palette.png`                                     | §6.10 command palette                                |
