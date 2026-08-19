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

_Audited: 2026-08-19, branch `claude/plugin-ktnja5`. Paths are from the repo root._

---

## Summary

| Block                                             | Implemented | Partial | Missing |
| ------------------------------------------------- | ----------- | ------- | ------- |
| A · Ticket View (§7.2)                            | 7           | 6       | 4       |
| B · Wallet (§7.5)                                 | 5           | 2       | 1       |
| C · Community shelf (§2.4, §2.14a)                | 9           | 2       | 1       |
| D · Resolution & disputes (§2.6)                  | 6           | 2       | 1       |
| E · Admin platform (§6)                           | 9           | 5       | 3       |
| F · Company layer (§2.11–13)                      | 12          | 3       | 2       |
| G · Creator platform (§2.14)                      | 10          | 2       | 2       |
| H · Community threads (§2.15)                     | 6           | 1       | 5       |
| I · Engagement (§2.8)                             | 5           | 1       | 1       |
| J · Landing, routing, fintech (§7.6, §7.1, §2.16) | 8           | 3       | 3       |

The shape of it: the **money core and the engine are the strongest part** of this
codebase — ledger, escrow, pricing, payouts, reconciliation and the four-eyes
workflow are all real and tested. The **thinnest parts are the moments around a
trade**: what a market looks like while it is still funding, what it looks like
once it has resolved, and what the trade sheet tells you about your own limits.

---

## Block A · Ticket View (§7.2)

The market detail page. Currently `apps/web/src/components/ticket-view.tsx`,
laid out per `docs/design-reference.html`'s `#detail`.

| §    | Feature                                                                | Status          | Evidence / gap                                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.2a | Area probability chart, 0–100%                                         | **IMPLEMENTED** | `components/price-chart.tsx` (lightweight-charts)                                                                                                                                                               |
| 7.2a | Timeframes 1H · 6H · 1D · 1W · ALL                                     | **IMPLEMENTED** | `price-chart.tsx:20` `TIMEFRAMES`                                                                                                                                                                               |
| 7.2a | Event annotations pinned on the chart                                  | **IMPLEMENTED** | `price-chart.tsx`, fed by `market_annotations` via `GET /markets/:id`                                                                                                                                           |
| 7.2a | Multi-outcome overlay, tap to isolate                                  | **IMPLEMENTED** | `price-chart.tsx:62` `isolated` state                                                                                                                                                                           |
| 7.2a | Live points appended over WebSocket                                    | **IMPLEMENTED** | `hooks/use-market-feed.ts`, `store/live-prices.ts`                                                                                                                                                              |
| 7.2a | **Candlestick toggle for power users**                                 | **MISSING**     | Only the area series is created. Spec calls it optional-but-present                                                                                                                                             |
| 7.2b | Argument bar, synced to last point                                     | **IMPLEMENTED** | `components/argument-bar.tsx`, rendered in the chart box                                                                                                                                                        |
| 7.2c | Money strip: pot, 24h volume, traders, fee                             | **PARTIAL**     | Now the `dstats` row in `ticket-view.tsx`; `money-strip.tsx` was removed in the redesign. **Missing: the pot-growth sparkline** the spec asks for beside the pot                                                |
| 7.2d | Bottom-sheet Trade Ticket                                              | **IMPLEMENTED** | `components/trade-sheet.tsx`, opened from grid and ticket                                                                                                                                                       |
| 7.2d | Priced outcome buttons (`Buy YES 62k`)                                 | **IMPLEMENTED** | `components/market/side-button.tsx`, `market-card.tsx`                                                                                                                                                          |
| 7.2d | Amount-first entry with ₦500/1k/2k/5k chips                            | **IMPLEMENTED** | `trade-sheet.tsx` `AMOUNT_CHIPS`                                                                                                                                                                                |
| 7.2d | Live figures: price, shares, total, est. to win, slippage              | **IMPLEMENTED** | `lib/trade-quote.ts`, rendered in sheet and `market/trade-panel.tsx`                                                                                                                                            |
| 7.2d | One-tap side-flip arrow                                                | **IMPLEMENTED** | `trade-sheet.tsx` `ArrowUpDown` control                                                                                                                                                                         |
| 7.2d | **Advanced toggle → shares-entry with −100/−10/+10/+100**              | **MISSING**     | Amount-entry only; no advanced mode                                                                                                                                                                             |
| 7.2d | Selling through the same sheet                                         | **PARTIAL**     | Opens from `position-panel.tsx` with side pre-set to Sell and quotes the exact refund. **Missing: the slider** — only 25/50/100% chips                                                                          |
| 7.2d | **Tier 0 starter-balance cap surfaced inline**                         | **MISSING**     | No tier check in the sheet; refusal only comes back from the API after submit                                                                                                                                   |
| 7.2d | **RG limit warnings surfaced inline (§2.12)**                          | **MISSING**     | RG service exists server-side; the sheet never consults it before submit                                                                                                                                        |
| 7.2d | Sheet behaviours: drag-to-dismiss, disabled-with-reason                | **IMPLEMENTED** | `trade-sheet.tsx` drag handlers; `closedReason()`                                                                                                                                                               |
| 7.2e | **Community FUNDING state: activation view replacing the chart**       | **PARTIAL**     | `components/seed-panel.tsx` shows seed composition and the deadline. **Missing: both-side progress meters (amount + backers), countdown, share-to-fill** — and it sits below the chart rather than replacing it |
| 7.2e | Activation moment permanently annotated                                | **IMPLEMENTED** | `activation` annotation type written by the lifecycle job                                                                                                                                                       |
| 7.2f | Take thread with position badges                                       | **IMPLEMENTED** | `components/take-thread.tsx`                                                                                                                                                                                    |
| 7.2f | Rules card (criteria, source, dates, freeze)                           | **IMPLEMENTED** | `components/rules-card.tsx`                                                                                                                                                                                     |
| 7.2f | **Resolution status: proposed outcome + evidence + dispute countdown** | **MISSING**     | Nothing on the ticket renders the proposed resolution or the 48h countdown                                                                                                                                      |
| 7.2f | Share button                                                           | **IMPLEMENTED** | `components/share-sheet.tsx`                                                                                                                                                                                    |
| 7.2f | **Challenge button on the ticket**                                     | **PARTIAL**     | The link works end-to-end (`/challenge/[token]`, `community-layer/challenge.service.ts`) but there is **no button on the ticket to mint one**                                                                   |
| 7.2g | **Resolved state: receipt panel with payout math**                     | **MISSING**     | Resolved markets show a state label. No pot/fee/per-share/your-result receipt — `@vercel/og` renders one for sharing (`app/api/result/[id]/route.tsx`) but the in-app panel does not exist                      |
| 7.2g | Chart freezes with a final ✓ annotation                                | **IMPLEMENTED** | `resolution` annotation type                                                                                                                                                                                    |
| 7.2g | Thread receipts light up at resolution                                 | **IMPLEMENTED** | `take-thread.tsx` keeps badges permanently                                                                                                                                                                      |

**Block A verdict:** the chart, the trade sheet and the thread are solid. The
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
| 7.5 | Transaction history in plain language                         | **PARTIAL**     | History renders from the ledger. **Missing: filtering**, which the spec names                                                                  |
| 7.5 | **Monthly statement download + per-transaction receipt view** | **MISSING**     | No statement endpoint, no receipt detail view                                                                                                  |
| 7.5 | Deposit/Withdraw actions                                      | **PARTIAL**     | Correctly absent in points mode; the fintech interfaces are stubbed (Block J). Wallet shows points, history and prize credits as the spec asks |

---

## Block C · Community shelf (§2.4, §2.5, §2.14a)

| §     | Feature                                                                                                 | Status          | Evidence / gap                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.4   | Lifecycle state machine                                                                                 | **IMPLEMENTED** | `apps/api/src/market/market-state.ts`                                                                                                                                                      |
| 2.4   | Path A organic activation + auto-void refund                                                            | **IMPLEMENTED** | `community/activation.ts` + `activation.test.ts`                                                                                                                                           |
| 2.4   | Path A multi-outcome amended rule (total pot + ≥2 funded)                                               | **IMPLEMENTED** | `community/activation.ts`                                                                                                                                                                  |
| 2.4   | Path B symmetric seed, server-enforced equal split                                                      | **IMPLEMENTED** | `community/` seed service                                                                                                                                                                  |
| 2.4   | Participation floor re-check at window close                                                            | **IMPLEMENTED** | `community/activation.ts`                                                                                                                                                                  |
| 2.4   | Syndicates: rounds, caps, fee-split locked at open                                                      | **IMPLEMENTED** | `community/`, Rulebook Part 3 §3 worked examples tested                                                                                                                                    |
| 2.5   | Template-only creation with server validation                                                           | **IMPLEMENTED** | `community/market-template.ts`                                                                                                                                                             |
| 2.5   | Conduct bond escrowed on creation                                                                       | **IMPLEMENTED** | `bonds` table, approvals-gated forfeit                                                                                                                                                     |
| 2.5   | Creator cannot take directional stakes in own market                                                    | **IMPLEMENTED** | Trade endpoint guard                                                                                                                                                                       |
| 2.14a | Creation wizard: natural input → AI restructure → balance meter → earnings preview → path choice → bond | **IMPLEMENTED** | `apps/web/src/app/create/page.tsx`, `components/balance-meter.tsx`                                                                                                                         |
| 2.14a | Ticket suggestion library                                                                               | **IMPLEMENTED** | `ticket_templates`, surfaced in the wizard                                                                                                                                                 |
| 2.14a | **Wizard restyled to the new design system**                                                            | **PARTIAL**     | It renders and works under the new tokens, but it predates the reference and has **no site header and its own layout register** — it is the clearest "second visual style" left in the app |
| 2.5   | **Banned-topic human review queue for first-time creators**                                             | **PARTIAL**     | Blocklist screen runs; the queue exists in admin. First-time-creator forced routing not verified                                                                                           |

---

## Block D · Resolution & disputes (§2.6)

| §   | Feature                                           | Status          | Evidence / gap                                                                                                       |
| --- | ------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| 2.6 | Propose resolution (creator/staff) with evidence  | **IMPLEMENTED** | `apps/api/src/resolution/resolution-flow.service.ts`                                                                 |
| 2.6 | 48h dispute window state + timer                  | **IMPLEMENTED** | `resolution-flow.service.ts`, `disputeClosesAt` column                                                               |
| 2.6 | Dispute filing with named-source evidence         | **IMPLEMENTED** | `disputes` table, admin decision flow                                                                                |
| 2.6 | Resolver review → final resolution → payout batch | **IMPLEMENTED** | `trade/resolution.service.ts`, chunked resumable payouts                                                             |
| 2.6 | Bonds refunded/forfeited on outcome               | **IMPLEMENTED** | Approvals-gated                                                                                                      |
| 2.6 | Void path at every state, full refund, zero fees  | **IMPLEMENTED** | `resolution-flow.integration.test.ts`                                                                                |
| 2.6 | Immutable resolution log                          | **IMPLEMENTED** | `admin_audit`, append-only                                                                                           |
| 2.6 | **User-facing dispute filing UI**                 | **PARTIAL**     | Endpoint exists; **no screen** lets a participant file one — admin can decide disputes nobody can raise from the app |
| 2.6 | **Dispute-window countdown on the ticket**        | **MISSING**     | See Block A §7.2f                                                                                                    |

---

## Block E · Admin platform (§6, nine screens, no-god-button)

| §    | Screen / rule                                                                       | Status          | Evidence / gap                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | Dashboard (reconciliation, escrow, volume, queues, SLAs)                            | **IMPLEMENTED** | `apps/web/src/app/admin/page.tsx`, `admin/solvency.service.ts`                                                                                                                                                             |
| 6.2  | Markets console: official create, AI drafts queue                                   | **IMPLEMENTED** | `app/admin/drafts/page.tsx`                                                                                                                                                                                                |
| 6.2  | Community review queue with AI scores                                               | **IMPLEMENTED** | `app/admin/drafts/`, `market_drafts`                                                                                                                                                                                       |
| 6.2  | **Lifecycle controls: funding checks, post-activation void, seed composition view** | **PARTIAL**     | Void-after-activation is four-eyes gated; **no dedicated console view** for funding windows or syndicate composition                                                                                                       |
| 6.3  | Resolution centre, side-by-side evidence                                            | **IMPLEMENTED** | `app/admin/resolution/page.tsx`                                                                                                                                                                                            |
| 6.4  | Money room: ledger explorer, reconciliation history, fund classes                   | **IMPLEMENTED** | `app/admin/money/page.tsx`                                                                                                                                                                                                 |
| 6.4  | Approvals inbox, first/second approver                                              | **IMPLEMENTED** | `app/admin/approvals/page.tsx`, `approvals/`                                                                                                                                                                               |
| 6.4  | **Proof-of-reserves export**                                                        | **MISSING**     | Named in §2.10 and §6.4; no export endpoint                                                                                                                                                                                |
| 6.4b | **Platform Config Console**                                                         | **PARTIAL**     | `platform-config/` service, keys and versioning exist. **Missing the console's security theatre that is the actual spec**: step-up re-auth on open, 24h effective-date delay, per-parameter rate limit. Four-eyes is there |
| 6.5  | Users & Trust/Safety, abuse queue, moderation queue                                 | **IMPLEMENTED** | `app/admin/moderation/page.tsx`, `hardening/abuse.service.ts`                                                                                                                                                              |
| 6.6  | **Creators desk**                                                                   | **PARTIAL**     | Creator data and levels exist (`creator/`); **no admin screen** for bond slash/refund, level management, template library curation                                                                                         |
| 6.7  | Support desk with SLA timers                                                        | **IMPLEMENTED** | `app/admin/support/page.tsx`, `support/support.service.ts`                                                                                                                                                                 |
| 6.8  | Content & growth: prize runs, analytics                                             | **IMPLEMENTED** | `app/admin/prizes/`, `app/admin/analytics/`                                                                                                                                                                                |
| 6.8  | **Top Calls curation, notification broadcasts, feature flags UI**                   | **MISSING**     | No screens                                                                                                                                                                                                                 |
| 6.9  | **System room (queues, deploys, alerts, restore drills)**                           | **MISSING**     | Status/incidents exist (`status/`); the engineering console does not                                                                                                                                                       |
| 6.10 | **Command palette, saved views, work-queue auto-advance**                           | **PARTIAL**     | Screens are functional tables; none of the operator-speed affordances are built                                                                                                                                            |
| 6.11 | Role → screen matrix in middleware                                                  | **IMPLEMENTED** | Roles guard + permission matrix, tested                                                                                                                                                                                    |
| 6    | **No-god-button**                                                                   | **IMPLEMENTED** | Balance mutation only via approvals; test asserts it                                                                                                                                                                       |

---

## Block F · Company layer (§2.11–§2.13)

| §    | Feature                                                 | Status          | Evidence / gap                                                                     |
| ---- | ------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| 2.11 | Least-privilege role matrix in middleware               | **IMPLEMENTED** | Roles guard                                                                        |
| 2.11 | `admin_audit` on every admin mutation                   | **IMPLEMENTED** | `audit/admin-audit.service.ts`                                                     |
| 2.11 | Staff TOTP 2FA + step-up on sensitive actions           | **IMPLEMENTED** | `auth/`, secrets encrypted at rest                                                 |
| 2.11 | Abuse detection: wash trading, stake floods, clusters   | **IMPLEMENTED** | `hardening/abuse.ts` + tests                                                       |
| 2.11 | **PII encryption at rest + field-level access logging** | **PARTIAL**     | TOTP secrets encrypted; **phone/email are not**, and there is no PII read log      |
| 2.11 | **Secrets manager with rotation**                       | **MISSING**     | Env vars only                                                                      |
| 2.12 | RG: limits, cool-off, self-exclusion                    | **IMPLEMENTED** | `rg/rg.service.ts`, self-exclusion blocks trading, permits withdrawal              |
| 2.12 | Session reality-check after 60 min                      | **IMPLEMENTED** | `components/reality-check.tsx`                                                     |
| 2.12 | Support ticketing with SLA escalation                   | **IMPLEMENTED** | `support/`                                                                         |
| 2.12 | Status page + incidents                                 | **IMPLEMENTED** | `status/`, `app/status/page.tsx`                                                   |
| 2.12 | Notifications: in-app, email, SMS, preferences          | **IMPLEMENTED** | `notifications/`, honest delivery reporting tested                                 |
| 2.13 | Test suite: property, integration, load, e2e            | **IMPLEMENTED** | `packages/engine` fast-check, k6 (`docs/loadtest.md`), Playwright                  |
| 2.13 | CI/CD with staging + canary                             | **PARTIAL**     | CI blocks on failure; deploy workflows exist. **No canary or feature-flag gating** |
| 2.13 | Observability: metrics, traces, alerts                  | **IMPLEMENTED** | `observability/`, prom-client                                                      |
| 2.13 | **Backups & restore drills**                            | **MISSING**     | Not configured in this repo                                                        |
| 2.13 | Localisation scaffolding                                | **IMPLEMENTED** | `next-intl`, `messages/en-NG.json`                                                 |

---

## Block G · Creator platform (§2.14)

| §     | Feature                                                        | Status          | Evidence / gap                                                                                         |
| ----- | -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| 2.14a | Creation wizard (see Block C)                                  | **IMPLEMENTED** | `app/create/page.tsx`                                                                                  |
| 2.14b | Opportunity feed: calendar + unmet-search-demand               | **IMPLEMENTED** | `creator/`, `opportunities` table                                                                      |
| 2.14c | Progression ladder as pure rules                               | **IMPLEMENTED** | `creator/` ladder module + tests                                                                       |
| 2.14c | Level privileges actually bind                                 | **IMPLEMENTED** | Enforced at creation                                                                                   |
| 2.14c | Public creator profiles                                        | **IMPLEMENTED** | `app/c/[handle]/page.tsx`                                                                              |
| 2.14c | Follow system + new-market notification                        | **IMPLEMENTED** | `followers` table, notification on open                                                                |
| 2.14d | Share kit (`@vercel/og` cards)                                 | **IMPLEMENTED** | `app/api/share/[id]/route.tsx`                                                                         |
| 2.14d | Creator analytics (views→stakes, sources)                      | **IMPLEMENTED** | `creator/analytics.service.ts`                                                                         |
| 2.14d | Nudge engine                                                   | **IMPLEMENTED** | `creator/` nudges                                                                                      |
| 2.14d | Market autopsies feeding §2.9                                  | **IMPLEMENTED** | `creator/autopsy.service.ts`                                                                           |
| 2.14e | Duplicate detection at creation                                | **IMPLEMENTED** | `community/` duplicate check                                                                           |
| 2.14e | **Conflict-of-interest attestation + auto-void risk warnings** | **PARTIAL**     | Attestation stored; **pre-post risk warnings not surfaced in the wizard**                              |
| 2.14d | **Creator studio restyled to the reference**                   | **PARTIAL**     | `app/studio/page.tsx` works but predates the redesign — same second-visual-style problem as the wizard |
| 2.14f | **Creator community channel**                                  | **MISSING**     | Out of scope for the app; spec says WhatsApp/Telegram initially                                        |

---

## Block H · Community threads (§2.15)

| §     | Feature                                                            | Status          | Evidence / gap                                                           |
| ----- | ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------ |
| 2.15a | Take threads on the market page                                    | **IMPLEMENTED** | `components/take-thread.tsx`, `http/threads.controller.ts`               |
| 2.15a | Position badges on comments                                        | **IMPLEMENTED** | `community-layer/badges.ts` + tests                                      |
| 2.15a | Prediction receipts persist at resolution                          | **IMPLEMENTED** | Badge snapshot stored on the comment                                     |
| 2.15a | Reason prompt at trade time feeding the thread                     | **IMPLEMENTED** | `trade-sheet.tsx`, `trade-panel.tsx`                                     |
| 2.15a | Tier 1 + eligibility gate on commenting                            | **IMPLEMENTED** | Threads controller guard                                                 |
| 2.15d | Challenge links                                                    | **IMPLEMENTED** | `community-layer/challenge.service.ts`, `app/challenge/[token]/page.tsx` |
| 2.15d | **Challenge mint button on the ticket**                            | **PARTIAL**     | See Block A                                                              |
| 2.15e | Moderation queue + tipster auto-flags                              | **IMPLEMENTED** | `app/admin/moderation/page.tsx`                                          |
| 2.15b | **Forecasting reputation: accuracy, calibration, category titles** | **MISSING**     | `reputation` table exists; nothing computes or displays it               |
| 2.15b | **Weekly Top Calls**                                               | **MISSING**     | `top_calls` table exists; no job, no screen                              |
| 2.15c | **Squads**                                                         | **MISSING**     | Tables exist; no code. Spec defers to post-launch                        |
| 2.15d | **Resolution-day recap cards**                                     | **MISSING**     | Result card renders (`app/api/result/[id]`); no recap distribution       |
| 2.15c | **Squad vs Squad challenges**                                      | **MISSING**     | Post-launch per §2.15f                                                   |

_§2.15f explicitly sequences titles, Top Calls and Squads as post-launch, so four
of these five MISSING rows are on-plan, not behind._

---

## Block I · Engagement (§2.8)

| §    | Feature                                           | Status          | Evidence / gap                                                               |
| ---- | ------------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| 2.8  | Weekly + all-time leaderboards (profit, accuracy) | **IMPLEMENTED** | `leaderboard/leaderboard.service.ts`, `app/leaderboard/page.tsx`             |
| 2.8  | Leaderboard snapshots                             | **IMPLEMENTED** | `leaderboard/snapshot` job                                                   |
| 2.8  | Shareable market cards                            | **IMPLEMENTED** | `app/api/share/[id]/route.tsx`                                               |
| 2.8  | Prize distribution tool with four-eyes            | **IMPLEMENTED** | `leaderboard/prize.service.ts`, `app/admin/prizes/`                          |
| 2.8  | Analytics events taxonomy                         | **IMPLEMENTED** | `analytics/events.ts`                                                        |
| 2.8  | **Streaks and "Top Forecaster" badges**           | **PARTIAL**     | Accuracy is computed for the board; **no streak counter and no badge award** |
| 2.17 | **Referral programme**                            | **MISSING**     | `referrals` table specified; no code                                         |

---

## Block J · Landing, routing, fintech (§7.6, §7.1, §2.16)

| §    | Feature                                                                        | Status          | Evidence / gap                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | Markets home, both shelves, filters                                            | **IMPLEMENTED** | `app/page.tsx`, `app/markets/page.tsx`                                                                                                                                                                                           |
| 7.1  | Market card: %, sparkline, pot, state badge                                    | **IMPLEMENTED** | `components/market/market-card.tsx`                                                                                                                                                                                              |
| 7.1  | Search                                                                         | **IMPLEMENTED** | Header search filters the catalogue server-side                                                                                                                                                                                  |
| 7.1  | **Search feeding unmet-demand capture (§2.14b)**                               | **PARTIAL**     | Opportunity feed reads search gaps; **the new header search does not log queries**, so the signal is thinner than specified                                                                                                      |
| 7.1  | My positions                                                                   | **IMPLEMENTED** | `components/position-panel.tsx` on the ticket                                                                                                                                                                                    |
| 7.1  | **A dedicated positions/portfolio screen**                                     | **MISSING**     | Positions are only visible per-market                                                                                                                                                                                            |
| 7.6  | **Public landing page**                                                        | **MISSING**     | The root is now the markets home. §7.6's marketing page — hero, how-it-works, trust block, community strip — **was deliberately replaced** in the redesign. This is a real, intentional divergence from spec and needs your call |
| 7.6  | SEO-complete server-rendered market pages                                      | **IMPLEMENTED** | `/market/[id]` SSR with OG cards, sitemap, robots                                                                                                                                                                                |
| 2.16 | PaymentProvider interface + adapters stubbed                                   | **IMPLEMENTED** | `apps/api/src/integrations/{paystack,flutterwave}.stub.ts`                                                                                                                                                                       |
| 2.16 | KYC provider stubbed                                                           | **IMPLEMENTED** | `integrations/smileid.stub.ts`                                                                                                                                                                                                   |
| 2.16 | SMS provider (Termii) with interface                                           | **IMPLEMENTED** | `integrations/termii.ts`                                                                                                                                                                                                         |
| 2.16 | Fintech endpoints (`/wallet/deposit-account`, withdrawals, statement, webhook) | **PARTIAL**     | Correctly not built in points mode; the interfaces exist. **The webhook idempotency path has no test** — worth having before the licence, not after                                                                              |
| 2.18 | Legal pages in-app                                                             | **IMPLEMENTED** | `/rules`, `/privacy`, `/faq`, `/support`                                                                                                                                                                                         |
| 2.18 | **Account recovery, SIM-swap freeze, session/device management**               | **MISSING**     | None built                                                                                                                                                                                                                       |
| 2.18 | Consent versioning                                                             | **PARTIAL**     | Age attestation logged at signup; **no `consents` table usage for ToS/privacy versions**                                                                                                                                         |

---

## The five things I would fix first

Not a plan — an opinion, so the ordering argument is on the table:

1. **The resolved-state receipt (§7.2g).** A prediction market whose whole pitch
   is "receipts" does not show one in-app when a market settles. It renders for
   sharing but not for the person who won.
2. **The funding-state activation view (§7.2e).** Community markets are half the
   product and their most fragile moment — the window where they either activate
   or void — has no screen telling anyone how close it is.
3. **Tier 0 and RG limits inline in the trade sheet (§7.2d, §2.12).** Both are
   enforced server-side, so today the user finds out by being refused after they
   commit. That is the wrong order.
4. **User-facing dispute filing (§2.6).** Staff can decide disputes that no
   participant has any way to raise.
5. **The §7.6 landing page.** Currently absent by my own redesign decision. Either
   restore it at a route and let `/` be the markets home, or decide the markets
   home _is_ the front door and update §7.6 to say so. Right now the doc and the
   code disagree, which is the one state that should never persist.

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
