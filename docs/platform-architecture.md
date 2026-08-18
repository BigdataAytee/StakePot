# Platform Architecture
### Nigerian Prediction Market — Technical Architecture v1.1
*(Complete full-platform specification — not an MVP cut. Points mode first; real-money hooks designed in, activated only after licensing.)*

---

## 1. System Overview

One product, built to scale in two stages: a **modular monolith** at launch (fast to build, cheap to run) whose internal boundaries are drawn so it splits into horizontally scaled services at millions of users **without rewriting the engines**. The scale design is in §12.

```
            ┌───────────────────────────────────────────────┐
            │        Mobile-first Web App (Next.js PWA)      │
            │            via CDN (static assets)             │
            └──────────────────────┬────────────────────────┘
                                   │ HTTPS / JSON API + WebSocket
            ┌──────────────────────┴────────────────────────┐
            │                Load Balancer                   │
            └──────┬────────────────┬────────────────┬──────┘
                   │                │                │
        ┌──────────┴───┐  ┌────────┴───────┐  ┌────┴─────────────┐
        │  API Nodes   │  │ Trade Workers   │  │ Realtime Gateway │
        │ (stateless,  │  │ (per-market     │  │ (WebSocket fan-  │
        │  N replicas) │  │  ordered queue) │  │  out, N replicas)│
        └──────┬───────┘  └────────┬───────┘  └────┬─────────────┘
               │                   │               │
        ┌──────┴───────────────────┴───────────────┴──────┐
        │   PostgreSQL (primary + read replicas,           │
        │   partitioned ledger)  ·  Redis cluster (prices, │
        │   sessions, pub/sub)   ·  Message queue (Kafka/  │
        │   Redis Streams: trades, payouts, notifications) │
        └──────────────────────────────────────────────────┘

  Async workers: resolution/payout batches, AI question engine, audit jobs,
  leaderboards, SMS/email. Licensed phase adds: payments module, KYC provider.
```

Design principles, from our decisions:
1. **Platform never bets.** Revenue = fees. The hybrid (dynamic pari-mutuel) engine pays winners only from each market's escrowed pot — structural zero cost.
2. **All stakes escrowed** from the moment of trade until resolution or void.
3. **One named Resolution Source per market**; platform confirms every resolution; 48-hour dispute window.
4. **Points mode first.** The wallet is currency-agnostic so naira can replace points after licensing without re-architecture.
5. **Scale by design, not rewrite.** Stateless API, per-market ordered trade processing, append-only ledger, and event-driven internals — the launch monolith and the million-user cluster run the same code with different deployment shapes.

---

## 2. Components

### 2.1 Auth & Accounts — Tiered Verification
Friction-free entry; identity checks deferred to the moment money leaves.

- **Tier 0 — Enter:** signup with email **or** phone + password (or one-tap OTP / magic link). Instant access to browse all markets and trade with a limited starter balance. Age attestation (18+) checkbox.
- **Tier 1 — Verified contact:** confirm ownership of the signup email/phone (OTP or link). Unlocks full signup bonus, market creation, leaderboards, and prize eligibility. One account per verified contact — this is the anti-farming/anti-multi-account gate. Unverified Tier 0 accounts expire after [14] days.
- **Tier 2 — Withdraw (licensed phase only):** NIN/BVN KYC via provider (Smile ID / Prembly), triggered on first withdrawal request (and on deposits above a configurable threshold). One-time, in-app, ~2 minutes. No withdrawals ever leave the platform without Tier 2.
- **Deposit gating is a config switch, not code:** default gates deposits at Tier 1 and withdrawals at Tier 2, but the licence may require KYC at deposit — flip `kyc_required_at: deposit|withdrawal` per counsel's advice without redeployment.
- Login: password or OTP; JWT sessions. Roles: `user`, `creator`, `resolver` (staff), `admin`.
- Fraud controls tied to tiers: starter-balance trading capped at Tier 0; device fingerprinting flags clusters of Tier 0 accounts; prizes and creator fees pay out only to Tier 1+.

### 2.2 Wallet & Escrow (the money core)
- Double-entry ledger. Every point movement is a transaction row with a type: `signup_bonus`, `trade_buy`, `trade_sell`, `stake`, `seed`, `payout`, `refund`, `fee_platform`, `fee_creator`, `bond_post`, `bond_refund`, `bond_forfeit`, `prize`.
- Each user has `available_balance` and `escrowed_balance`. Staking/buying moves points available → escrow; resolution/void moves escrow → available (winner payout or refund).
- **Invariant enforced in code and by nightly audit job:** for every market, sum of escrowed amounts = total collected; payouts + fees can never exceed the market's pot.
- Currency field on every row (`SPC` — SPcoin — now, `NGN` later) — the licensed-phase switch is a config change plus payment rails, not a rebuild.

### 2.3 Hybrid Market Engine (dynamic pari-mutuel — one engine, both shelves)
The single trading engine for official and community markets. Combines LMSR-style live pricing and early exit with pool-style pot-only payouts, so the platform bears zero market cost by construction.

- **Pot:** every stake flows into the market's escrowed pot. Winners are paid only from the pot — nothing fixed is ever promised per share.
- **Exact pricing specification (v1.1 — validated by simulation):**
  - State per market: shares outstanding `q_i` per outcome, liquidity constant `L` (fixed at creation).
  - **Displayed price:** `p_i = e^(q_i/L) / Σ_j e^(q_j/L)` — always sums to 100%.
  - **Buying:** a user spending money `m` on outcome `i` receives shares `Δ = L·ln((e^(m/L) − 1 + p_i)/p_i)` — closed form, O(1), no iteration. `m` goes into the pot; `q_i += Δ`.
  - **Early exit:** selling `Δ` shares refunds `r = C(q) − C(q − Δe_i)` where `C(q) = L·ln Σ_j e^(q_j/L)`, paid from the pot.
  - **Solvency is automatic, not enforced:** because every buy and sell moves along the same cost curve, the pot always equals `C(q_current) − C(q_open) ≥ 0`. No refund can ever exceed the pot — a mathematical identity, not a cap check. (The runtime still asserts it as a §9-invariant tripwire.)
  - **Resolution:** pot − fee distributed per share among the winning outcome's holders. Fee basis: the losing pool — official markets [3]%; community markets [7]% ([4]% creator / [3]% platform). Displayed payout figures are estimates (final value = pot/q_win at close) and are labelled as such.
  - **Tuning `L`:** a stake of size `m` moves the price by ≈ `m·p(1−p)/L`. Rule of thumb: `L ≈ 25× the typical stake` gives ~1-point moves per typical trade (e.g., ₦2,000 stakes → L=50,000); size `L` to [50–100%] of expected market volume. Small L = lively/jumpy (fine for small community markets); large L = smooth/deep (flagship markets). `L` is fixed for a market's lifetime (changing it mid-market breaks the pot identity).
  - **Trading freeze at event start:** markets freeze when the underlying event begins (kickoff, polls close) — standard practice, and it prevents near-certain-outcome exit drains on other holders.
  - **Early-exit fee [1]% of sale proceeds — ON by default** (config 0–2%): deducted only when selling before resolution; buying is always free and holding to resolution incurs no exit fee. The deduction is credited to `platform_fees`. This is the platform's spread-equivalent — visible, stated, and charged only on early exits.
  - **Simulation results (5 / 50 / 500 traders, 2,000-trade stress runs):** platform cost exactly ₦0.00 in every scenario (payouts + fee = pot to the kobo); pot never negative including full-whale-exit stress; tuned-L markets tracked injected sentiment within ~2 points with sub-1-point average moves at scale, while a fixed small L produced 8-point average swings — confirming the per-market L sizing rule above. Simulation script to be kept in the repo as a regression test.
- **Resolution payout:** remaining pot − fee (community [7]%: [4]% creator-or-syndicate / [3]% platform; official [3]% platform) is distributed **per share** among the winning outcome's holders.
- **Displayed payout estimates** are clearly labelled as estimates (final per-share value depends on the pot at close).
- Every trade executes atomically in one DB transaction: read pot state → price via formula → fee → ledger entries → new pot state → price snapshot → `price_changed` event.
- Price snapshots per trade + per minute → price history charts. Redis caches current prices; the Realtime Gateway pushes live updates (the moving-percentage Polymarket experience).
- Admin panel: create/pause/resolve/void markets, set liquidity/seed params, pot & solvency dashboard per market.

### 2.4 Market Lifecycle & Activation (community shelf)
- **State machine:**
  `draft → seeding (Path B syndicate only) → funding → active → pending_resolution → dispute_window → resolved | voided`
- **Activation logic (Rulebook Part 3 §2):**
  - Path A (organic): at funding-window close, every outcome pool ≥ [20,000] pts AND ≥ [10] distinct users → `active`, else `voided` + auto-refund.
  - Path B (seeded): creator (or syndicate) posts a Symmetric Seed — split equally across all outcomes → instantly `active`. Participation floor re-checked at window close: < [10] non-creator stakers → void, full refund including seed.
- **Syndicates (Part 3 §3):** seeding-round table tracks contributions (min [2,000], max [20] sponsors, [3]-day round); every contribution auto-split symmetrically; fee-split table stores pro-rata or creator-defined custom percentages, locked at round open.
- Official markets skip funding: platform seeds them and they open `active`.

### 2.5 Market Creation & Templates
- Community markets created **only** through structured template: question, complete outcome list (+ "Any other"), Resolution Source (name + URL), resolution criteria per outcome, event date, void date, edge-case mappings.
- Server-side validation: void date required and future; source URL required; outcome list marked complete; banned-topic keyword screen + human review queue for first-time creators.
- Conduct Bond ([2,000] pts) escrowed on creation.
- Creator cannot place directional stakes in own market (enforced at trade endpoint), except symmetric seed.

### 2.6 Resolution & Disputes
- Resolution flow (both engines):
  1. Event concludes → creator (community) or staff (official) posts **Proposed Resolution** + source link/reference.
  2. `dispute_window` state, 48h timer. Participants may file disputes with evidence; only named-source evidence admissible.
  3. Resolver role reviews → **Final Resolution** → payout batch runs, bonds refunded/forfeited.
- Void path available at every state per Rulebook Part 1 §6 → full refunds from escrow, zero fees.
- All resolution actions logged immutably (who, when, evidence link) — this audit trail is also a future licensing exhibit.

### 2.7 Anti-fraud & Integrity
- One account per phone number; device fingerprint flagging for farm detection.
- Creators blocked from own-market directional trades; staff blocked from trading entirely.
- Banned-topic screen (Rulebook Part 1 §8) at creation + report button on every market.
- Rate limits on trades and market creation.
- Nightly ledger audit job (invariant checks); alert on any escrow mismatch.

### 2.8 Engagement Layer (points-phase growth engine)
- Weekly + all-time leaderboards (profit, accuracy %).
- Streaks, "Top Forecaster" badges.
- Public shareable market cards (image render of question + live prices) for X/WhatsApp.
- Airtime/data prize distribution tool for weekly winners (promotional competition, points phase).

### 2.9 AI Market Question Engine (question suggestion & quality control)
An LLM-powered assistant that drafts official-market questions and screens community submissions. It **suggests; humans approve** — no market ever goes live without staff sign-off (and community markets additionally follow the full Part 3 rules).

**Prime directive: maximise genuine disagreement.** The engine's core objective is a question the audience splits close to 50/50 on. Obvious-answer questions are rejected at generation time, because lopsided pools produce negligible fees and dead markets.

**Generation rules (encoded in the system prompt / fine-tune):**
1. **Template-only output.** Every suggestion must emit the full market template: question, complete outcome list (+ "Any other" where applicable), one named official Resolution Source with URL, per-outcome resolution criteria, event date, void date, edge-case mappings. Free-text questions are invalid output.
2. **Threshold tuning.** For numeric questions (inflation, FX, fuel price), the engine must set the threshold at the current consensus/market forecast — never at a level with an obvious answer. It retrieves the latest figure/forecast before proposing (e.g., ask "above/below the analyst consensus," not "above 50%").
3. **Balance pre-check.** The engine estimates the likely Yes probability and rejects its own draft if outside [35%–65%] (configurable). For multi-outcome, no single outcome should be estimated above [60%].
4. **Structural checklist — all mandatory:** definite conclusion by a stated date; binary or complete-list outcomes; verifiable by exactly one named official source; no participant can influence the outcome; expected news flow between open and resolution (news-driven trading is fee volume).
5. **Emotional-stakes scoring.** Prefer topics with mass Nigerian engagement: naira/economy, football (Super Eagles, AFCON, EPL), elections, BBNaija/entertainment, fuel/cost-of-living. Score and rank suggestions by predicted engagement.
6. **Multi-outcome preference.** Where the story allows ("who wins X?"), emit a multi-outcome list rather than Yes/No — naturally closer to balanced and engages multiple fanbases.
7. **Hard blocklist (mirrors Rulebook Part 1 §8):** never generate questions about deaths, harm, crimes, security incidents, private individuals, influenceable events, or unsourceable outcomes. Blocklist check runs on both generation and community-submission screening.
8. **Catalogue discipline.** Respect the shelf plan: [6] official slots (2 economic bankers, 1 recurring sport, 1 seasonal blockbuster, 1 cost-of-living, 1 rotating trending). Suggest replacements per cycle, not additions.

**Feedback loop (what "well trained" means over time):**
- After each market resolves, log `initial_pool_split`, `final_pool_split`, `volume`, `dispute_count` against the question's features.
- Questions that ran lopsided (>[75/25]) are flagged; the engine is instructed to retune that series' threshold next cycle.
- High-volume, low-dispute, near-balanced questions become few-shot exemplars in the generation prompt — the engine learns the house style from its own hits.

**Community-shelf screening mode:** the same engine scores user-submitted templates (structure validity, blocklist, balance estimate, duplicate detection vs live markets) and routes: auto-flag → human review queue → approve/reject with reason shown to the creator. First-time creators always route to human review.

**Backtest validation (v1 harness — `ai_backtest.py`, kept in repo as a regression test):**
The engine's drafting rules were backtested against 18 real past Nigerian events (2023 presidential and governorship races, AFCON 2023, naira/inflation/fuel thresholds, BBNaija-style finales, award shows), simulating crowd trading with the v1.1 pricing engine against pre-event consensus, then resolving with actual historical outcomes. Engine rules vs naive drafting (round-number thresholds, favourite-framing):
- **Balance:** average dominant-side share 55% (engine) vs 68% (naive); markets landing in the 35–65% band: 83% vs 50%.
- **Revenue:** +24% fee per market (₦1,560 vs ₦1,254 per ₦100k volume) — balance is directly worth money.
- **Activation:** 72% vs 67% would-activate rate.
- **Finding fed back into the spec:** strict "every outcome pool must hit the minimum" activation for 4–5-outcome community markets fails even well-balanced markets on tail outcomes. Recommended rulebook amendment: multi-outcome community pools activate on **total pot threshold + at least [2] funded outcomes**, with the "Any other" bucket absorbing tails.
- Honest limits: pre-event consensus figures are approximations and the crowd is simulated — results are directionally valid (rule comparison), not precise forecasts. The harness reruns automatically as resolved-market data replaces simulated data (see feedback loop above).

**Implementation:** Anthropic API (or comparable LLM) with retrieval of current rates/forecasts; suggestions written to a `market_drafts` table with scores; admin panel shows ranked drafts with one-click "open market" (pre-filled template). Never autonomous publication.

### 2.10 Financial Controls (coded into the money path)
Company-grade money handling, built in from day one — these are code, not policy documents:

- **Daily reconciliation job.** Extends the nightly audit: every day, recompute all balances from the append-only ledger and compare to stored wallet totals AND (licensed phase) to actual bank balances via processor APIs. Any mismatch — even ₦1 — pages on-call and freezes withdrawals until a human clears it. Exceptions logged to a `reconciliation_runs` table reviewed each morning.
- **Fund tagging.** Every ledger row carries `fund_class: user_escrow | user_available | platform_fees | prize_pool`. Platform revenue is only ever spendable from `platform_fees`; the system physically cannot pay company costs from user funds. This tagging is what makes real bank-account segregation enforceable and auditable later.
- **Four-eyes approvals.** Withdrawals above [threshold], manual ledger adjustments, market voids after activation, and bond forfeitures require two distinct staff approvals, enforced by an `approvals` workflow table — a single admin credential can never move significant user money.
- **Proof-of-reserves export.** One-click signed export: total user liabilities (from ledger) vs held funds, timestamped — feeds external attestations and regulator reports.
- **No delete, no update on money.** Ledger rows are insert-only at the database-permission level (the app's DB role has no UPDATE/DELETE grant on `ledger`). Corrections are reversing entries, visible forever.

### 2.11 Security Engineering (coded in)
- **Secrets management:** all credentials/keys in a secrets manager (never in code or env-files in repos); automatic rotation for DB and API keys.
- **Least-privilege roles:** permission matrix enforced in middleware — support staff can read tickets but not the ledger; resolvers can resolve but not adjust balances; marketing can read analytics only. Every admin action writes to an immutable `admin_audit` table (who, what, before/after, IP, timestamp).
- **Staff 2FA mandatory** for all admin/resolver/support roles (TOTP or hardware key); session timeout + re-auth for sensitive actions.
- **Data protection (NDPA-ready):** PII encrypted at rest (phone, email, KYC refs); field-level access logging on PII reads; retention schedules with automated anonymisation of closed accounts after [statutory period]; user data-export and deletion-request endpoints.
- **Application hardening:** input validation everywhere, parameterised queries only, CSRF/XSS protections, dependency vulnerability scanning in CI, security headers, TLS-only.
- **Abuse detection:** trade-pattern anomaly flags (wash-trading between related accounts, last-second stake floods before resolution), auto-freeze + review queue.

### 2.12 Responsible Gambling & Support (coded in, hooks live from day one)
- **RG module:** per-user deposit/stake/loss limits (user-set and platform caps), cool-off periods, permanent self-exclusion (blocks login to trading, allows withdrawal), session reality-check prompts after [60] min continuous use, visible helpline info. In points mode the limits exist but sit dormant/high — the flows are tested long before the licence requires them, and self-exclusion works even for points.
- **Support system:** in-app ticketing tied to user + market context; categories (payout query, dispute, account, RG request); SLA timers with escalation; canned-response library; support role sees tickets + read-only market state, nothing else. Public help centre pages served from the app.
- **Status page:** public uptime/incident page fed by the monitoring stack; incidents posted with timestamps — transparency as a feature.
- **Notifications service:** transactional messages (trade confirmed, market resolved, payout made, dispute update) via in-app + SMS/email through the queue; per-user notification preferences.

### 2.13 Delivery & Operations Machinery (built alongside the app)
- **Test suite as a deliverable:** unit tests on the pricing/payout math (property-based: random trade sequences must never break pot ≥ 0 or invariants in §10), integration tests on trade→escrow→exit→resolve→payout, load tests scripted for 10× peak. CI blocks merge on any failure; money-path code requires a second reviewer (enforced in repo settings).
- **CI/CD:** every merge auto-deploys to a production-mirroring staging environment; production deploys are gradual (canary %) behind feature flags with one-click rollback; DB migrations forward-compatible and rehearsed on staging.
- **Observability:** metrics (trade latency, queue lag, reconciliation status, invariant checks), structured logs, distributed tracing on the trade path; alert rules page on-call for invariant violations, reconciliation failure, queue stall, error spikes.
- **Backups & recovery:** continuous WAL archiving + daily snapshots; restore drills scheduled and logged; documented RPO minutes / RTO < 1 hour.
- **Analytics & experimentation:** event tracking (funnel: signup → first trade → return), A/B testing via the feature-flag system, dashboards for the two health metrics (pool balance distribution, weekly returning traders).
- **Localisation scaffolding:** all user-facing strings in language files from day one (English at launch; Pidgin/Hausa/Yoruba/Igbo addable without code changes). Accessibility: semantic markup, contrast, screen-reader labels on trading controls.

### 2.14 Creator Platform (the community growth engine)
The creator side assumes most creators are ordinary people with a hot question, not market designers — **the system does the market-design thinking for them.** Every feature serves one loop: *creator posts good ticket → shares it → brings their audience → market activates → clean resolution → status + earnings → posts again, better.*

**a) Creation Wizard (guided, AI co-piloted — not a raw form)**
1. **Natural input:** creator types their question as they'd say it ("who go win the Surulere LGA chairmanship").
2. **AI restructure (live):** the Question Engine (§2.9) in co-pilot mode drafts the clean question, proposes the complete outcome list (+ "Any other"), suggests the Resolution Source (e.g., INEC declaration URL), sets event/void dates, and flags problems inline ("deadline is before the election date — fix").
3. **Balance meter:** live gauge of the AI's estimated split — green [35–65%], amber outside, red for obvious answers, with the explanation shown: "one-sided markets don't activate, and unactivated markets earn nothing."
4. **Earnings preview:** honest projection — "if this market attracts ₦100K in stakes, you earn ~₦500–1,000 as creator fee."
5. **Path choice:** organic vs symmetric seed vs syndicate, each explained in plain language with costs/caps; then Conduct Bond; then submit → AI screening → review queue (per §2.9 / §6.2).
- **Ticket suggestion library inside the wizard:** pre-filled, one-tap templates for the proven categories — *BBNaija winner & weekly evictions (multi-outcome, official show announcement as source), Super Eagles / AFCON / EPL fixtures (Win-Draw-Lose), state & LGA elections (candidate list + INEC), naira/fuel/inflation thresholds (pitched at consensus), transfer-window sagas, award shows.* Creator picks a template, the wizard localises it (their state, their LGA, this week's fixture) — a professional market in under three minutes.

**b) Opportunity Feed (demand-led creation)**
- "Trending now" panel: upcoming fixtures, election dates, entertainment finales (BBNaija season calendar), award nights — each with a pre-filled template one tap away.
- **Unmet-demand signals:** platform search queries with no matching live market surface here ("47 users searched 'BBNaija eviction' this week — no market exists. Create it?"). First creator to claim an opportunity captures its volume.
- Seasonal push: "AFCON starts in 3 weeks — 6 ready templates."

**c) Progression Ladder (status is the points-phase currency)**
| Level | Unlock criteria | Privileges |
|---|---|---|
| 1 New | signup (Tier 1) | Template/wizard creation only, human review on all, standard bond, max [2] live markets |
| 2 Verified | [5] clean resolutions | Badge, reduced bond, auto-approval on template-standard markets, max [10] live |
| 3 Pro | sustained volume + clean record | Featured placement, custom syndicate splits, fee bump ([4%→4.5%]), early access to new market types, share of a monthly top-creator bonus pool |
- **Public creator profiles:** live markets, resolution accuracy, total volume hosted, followers. **Follow system:** followers are notified when a creator opens a market — creators become distribution channels with audiences.

**d) Post-launch tools (volume = creator earnings, so help them grow it)**
- **Share kit:** auto-generated market card (question + live percentages + creator handle) sized for WhatsApp status and X; one-tap share.
- **Creator analytics:** views→stakes conversion, pool balance over time, traffic sources, activation progress bar per side.
- **Nudge engine:** actionable prompts — "YES side full, NO at 40%, market voids in 2 days — share with groups holding the opposite view."
- **Resolution flow:** event-date ping with the pre-named source link ready; one-tap propose; clean resolution = bond back + streak credit.
- **Market autopsy:** after each close, a short automated review (what worked, why it voided, one improvement tip). Autopsy data feeds the AI engine's training loop (§2.9) — creators and the AI improve from the same signals.

**e) Guardrails that feel like help**
- Duplicate detection at creation: "similar market live — stake in it or differentiate" (prevents liquidity splitting).
- Conflict-of-interest check before submission (influence/inside-knowledge attestation, per Rulebook Part 3).
- Auto-void risk warnings *before* posting (deadline too far, topic too niche for organic activation → suggest seed path).

**f) Creator community**
In-app creators' channel (or WhatsApp/Telegram initially): announcements, tips, monthly "best market" spotlight, direct line to the team — social quality-policing before the review queue.

### 2.15 Community Layer (arguments with receipts — the growth flywheel)
Design principle: prediction markets are arguments with money attached, so the community is built **around the argument, not beside it**. No separate forum — conversation attaches to markets.

**a) Take threads (the market page is the community space)**
- Every market has a discussion feed. Each comment displays the commenter's **position badge** ("YES @ 62%" / "no position") — arguments become accountable; talking your book is visible.
- **Prediction receipts:** at resolution, every comment keeps its badge permanently. Provably-right calls become screenshot-able artifacts — free viral content.
- **Reason prompts:** optional one-line "why?" at trade time, feeding the thread — the best forecasting education new users can get.
- Commenting requires Tier 1 + eligibility to trade the market (kills drive-by spam).

**b) Forecasting reputation (status built on being right, not loud)**
- Accuracy score + calibration on every user profile (extends creator_profiles to all users).
- **Category titles, earned and seasonal:** "Oracle of Naira" (economic markets), "Football Prophet," "Election Sage" — resettable per season so newcomers can always climb.
- **Weekly Top Calls:** platform-curated showcase of the boldest correct predictions (e.g., bought at 15%, resolved YES) — the platform's best recurring marketing asset.
- Strategic value: a verifiable public forecasting record is real social capital (vs unverifiable WhatsApp tipsters) — it attracts confident, audience-carrying users.

**c) Squads (the Nigerian group dynamic, formalised)**
- Small groups (office, course mates, viewing centre) with private leaderboard + squad feed of members' takes.
- **Squad vs Squad challenges:** two squads compete on the same market set for bragging rights and leaderboard points ("Accounting vs Marketing on this week's EPL slate").
- Squads are a natural container for Sponsor Syndicates (§2.4) — a squad seeds its own local market together.
- Growth math: every squad invite is a warm referral; one 10-person squad = 9 recruits no ad buys.

**d) Argument-to-acquisition pipeline**
- Share cards show the live split as provocation: "Nigeria 54% to beat Ghana — 3,000 people disagree with you."
- **Challenge links:** personal link from any market — "I'm YES at 60%. Prove me wrong." — recipient lands on the market with the challenger's position shown. Registering-to-disagree is the strongest signup motivator.
- Resolution-day recap cards ("The 18% longshot landed — here's who called it") market the next market.

**e) Moderation & integrity (Nigerian internet is spicy)**
- Rate limits, report buttons, banned-topic rules identical to markets; AI-assisted moderation queue feeding the Trust & Safety desk (§6.5).
- **Hard bans:** tips-for-sale, external betting links, "DM me for sure odds" — parasite-tipster patterns auto-flagged.
- Position badges double as anti-manipulation: pump-talk from no-position or opposite-position accounts is self-exposing.
- Squad names/content pass the same screening as market questions.

**f) Rollout sequencing**
- **Launch:** take threads with position badges + share/challenge links (80% of value, 20% of build).
- **Month 2–3:** accuracy titles, weekly Top Calls, follow feeds.
- **Season moment (AFCON/election/BBNaija):** launch Squads into peak group-rivalry energy — features launched into a season adopt several times faster.

The flywheel: arguments recruit users → receipts build reputations → reputations become creators → creators make markets → markets start new arguments.

### 2.16 Fintech Module — Money In / Money Out (designed now, activated at licensing)
The full customer-money machinery. Built as a stubbed module in points mode (interfaces + tests against fakes), switched on with the licence — no re-architecture.

**a) Deposits — per-customer virtual accounts (the Nigerian-native pattern):**
- On reaching the deposit-eligible tier, each user is issued a **dedicated virtual NUBAN account number** in their name (via Paystack/Monnify/Flutterwave virtual accounts). Depositing = a normal bank transfer from any Nigerian bank app to *their own* StakePot account number — no cards required, instant recognition of sender.
- Processor **webhook** receives the credit → idempotency check (processor reference stored, duplicates ignored) → ledger credit to the user's `user_available` fund class → in-app + SMS receipt. Unmatched/ambiguous credits land in a manual-review queue, never silently kept.
- **Dynamic (temporary) virtual accounts** as a parallel rail: for exact-amount funding ("Deposit ₦5,000 for this stake"), the app generates a one-time account number valid [60] minutes expecting that exact amount — auto-matched on arrival, expired unused numbers cleaned up. Also the first fallback when a user's permanent-account provider is degraded (generated from the healthy provider on demand, per §2.16e).
- Card and USSD deposits as secondary rails through the same processor, same webhook path; pay-with-bank-app intents where the provider supports them.
- Deposit UI order (Wallet screen §7.5): permanent account first (saved-beneficiary convenience), "Deposit exact amount" (dynamic account) second, card/USSD behind a "more options" expander.

**b) Withdrawals — verified, queued, controlled:**
- User links a payout bank account once; **name-match verification** (account name vs KYC name via bank-resolve API) — mismatches blocked. Tier 2 KYC required before first withdrawal (§2.1).
- Withdrawal request → balance check (only `user_available`; escrowed funds never withdrawable) → ledger debit + hold → payout via processor transfer API → confirm webhook → receipt. Failures auto-reverse the hold.
- Controls: per-day limits (config), withdrawal fee (config), **four-eyes approval above [threshold]** (§2.10 approvals workflow), fraud checks (new device + max withdrawal = review), RG self-excluded users can still withdraw (§2.12).

**c) Platform account separation:**
- Fees sweep from `platform_fees` fund class to the company's operating account on a schedule; user funds live in **segregated client accounts** the operating side cannot touch (§2.10 fund tagging is the in-system enforcement; the bank mandate is the external one).
- **Three-way daily reconciliation** once live: ledger totals vs wallet totals vs *actual processor/bank balances* via API — extending the §2.10 job's bank leg. Any gap freezes withdrawals pending human clearance.

**d) Statements & transparency (built in points mode already):**
- Every user's Wallet screen (§7.5) shows available vs escrowed ("in open markets"), full transaction history (stakes, wins, exits, fees, deposits, withdrawals — from the ledger, so it's complete by construction), and downloadable monthly statements. Receipts for every money event.

**e) The One-Funnel Principle — every rail ends in the user's wallet:**
All deposit methods terminate in the same pipe; the method differs, the destination never does:

```
Permanent account transfer -+
Dynamic 1-hour account -----+
Card payment ---------------+--> Processor webhook --> Ledger credit --> User's
USSD -----------------------+     (signed, verified,    (user_available   wallet
Pay-with-bank-app ----------+      idempotent)           fund class)      balance
Manual ref transfer --------+                                             rises
```

- Same webhook path, same ledger service, same fund class, same receipt, same history line — a deposit is indistinguishable to the user regardless of rail.
- **"User account" = their wallet in the ledger.** Physical naira pools in StakePot's segregated client bank account; the ledger records whose is whose to the kobo, and daily reconciliation (§2.16c) proves pool = sum of all wallets. Fund tagging (§2.10) makes user balances unspendable by the platform.
- **Nothing credits silently; nothing is silently kept.** Credits require a verified, idempotent webhook (the same payment can never credit twice). Unmatched money (wrong amount, expired dynamic account, missing reference) goes to the manual-review queue for matching or refund — held as a liability, never booked as revenue. There is no third place for money to go.

**f) Processor redundancy — never one point of failure for money:**
- **Open pipe by design — no provider is chosen in this architecture.** All payment operations go through a **PaymentProvider interface** (issueVirtualAccount, issueDynamicAccount, resolveBankAccount, transfer, webhookVerify, reconcile). Adapters for Monnify, Paystack, Flutterwave, Squad, Korapay (or any future processor) are thin plug-ins implementing this interface, selected and weighted purely by config (`providers: [{name, enabled, priority, rails}]`). At licensing, connecting a processor = writing/enabling one adapter + credentials — zero changes to wallet, ledger, or app code. Run one, two, or five providers; the routing layer (below) treats them identically. The app never calls a processor directly, only the interface.
- **Health-checked routing:** a monitor pings each provider's API; withdrawals automatically route to the healthy provider, and new virtual accounts are issued from the healthy one. A provider outage degrades nothing but that provider.
- **Deposits during an outage:** each user can hold virtual account numbers from two providers (primary + backup shown in the Wallet screen when primary is degraded); as a final fallback, a manual bank-transfer flow (pay to the client account with a reference code, matched in the review queue) keeps deposits possible even if all processor APIs are down.
- **Withdrawal queue is durable:** payout jobs persist and retry with backoff across providers; users see "processing" honestly rather than errors. No payout is ever lost to an outage — only delayed, visibly.
- Reconciliation (§2.16c) runs per provider; a provider that cannot be reconciled is auto-suspended from routing.

**API additions (§4):** `GET /wallet/deposit-account` · `POST /wallet/bank-accounts` (+resolve/verify) · `POST /wallet/withdrawals` · `GET /wallet/statement?month=` · `POST /webhooks/processor` (signed, idempotent).

---

### 2.17 Growth & Retention Layer
- **Referral program:** every Tier 1 user gets a code/link; when an invitee reaches Tier 1 and places their first trade, both sides earn a points bonus (config). Referral counts on profiles; anti-abuse: device-fingerprint + contact-verification gates (§2.1), bonuses void on farm detection. Table: `referrals(code, referrer_id, invitee_id, state, rewarded_at)`.
- **First-session onboarding tour:** a 90-second guided flow on first login — pick a side on a live market, place one bonus-funded practice stake, watch the price move, see the position. Converts signups into traders; completion tracked in `events` for funnel analytics. Skippable, never repeated.
- **Transactional receipts:** every money event (stake, win, early exit, deposit, withdrawal, fee, refund) emits a receipt through the notifications service (§2.12) — in-app always; SMS/email for deposits, withdrawals and wins above [threshold] in the licensed phase. Receipt content sourced from the ledger row, so receipts can never disagree with the books.
- **App-store presence (post-launch):** the PWA wraps as an Android Trusted Web Activity for Play Store distribution (pure packaging — same app, no rebuild); iOS via PWA install until volume justifies a wrapper.
- **SEO/content layer (post-launch):** public server-rendered market pages (§7.6) extended with a lightweight editorial layer — "Who wins X? Live odds" pages per big event, auto-fed by market data, indexable, each linking into signup.

---

### 2.18 Account Security & Housekeeping (the unglamorous essentials)
- **Account recovery:** forgot-password via verified contact; recovery of a lost email/phone requires the *other* verified channel plus a cooling period — never instant, never via support chat alone (social-engineering defence).
- **SIM-swap / contact-change protection:** changing the registered phone or email triggers a **[48h] withdrawal freeze** on the account and a notification to the *old* contact with a one-tap "this wasn't me" lock. This single rule blocks Nigeria's most common wallet-theft pattern.
- **Sessions & devices:** users see active sessions/devices and can log out others; new-device login notifies existing devices; optional **user-facing 2FA** (TOTP) for those who want it — required for accounts above a balance threshold in the licensed phase.
- **Consent & terms versioning:** ToS/privacy/rulebook acceptance recorded per version per user (`consents` table); re-acceptance prompted on material changes; marketing consent separate (NDPA). Age attestation already logged at signup (§2.1).
- **Account closure:** self-service close flow — open positions must resolve or be sold, balance withdrawn (or forfeited-to-prize-pool for sub-minimum dust with explicit consent), data anonymised per retention schedule (§2.11). Closed ≠ deleted from the ledger: financial history is immutable, identity is detached.
- **Canonical time:** all market deadlines, freezes, and void dates are defined in **Africa/Lagos** and evaluated against NTP-synced server time — displayed with timezone on every rules card. Resolution disputes about "what time it closed" are settled by spec, not argument.
- **SMS/OTP redundancy:** same open-pipe pattern as payments — an `SmsProvider` interface with Termii primary and a second adapter (e.g., Africa's Talking) health-check routed, so login OTPs never depend on one vendor.
- **Legal pages in-app:** ToS, privacy policy, rulebook, and responsible-play pages served as versioned in-app/web pages (content from counsel), linked from signup, footer, and every market's rules card.

Data model additions: `sessions(user_id, device, ip, last_seen, revoked)` · `consents(user_id, doc, version, accepted_at)` · `contact_changes(user_id, old, new, freeze_until, disputed)`.

---

## 3. Data Model (PostgreSQL — core tables)

```
users            id, email?, phone?, contact_verified, tier (0|1|2), kyc_ref?,
                 pw_hash, role, created_at, status
wallets          user_id, currency, available, escrowed
ledger           id, user_id, market_id?, type, amount, currency, ref, created_at   [append-only]

markets          id, shelf ('official'|'community'), question, source_name, source_url,
                 criteria_json, edge_cases_json, event_date, void_date, state,
                 creator_id?, liquidity_param, pot_total, fee_bps,
                 created_at, resolved_outcome_id?, resolution_evidence?

outcomes         id, market_id, label, shares_outstanding, price_current, is_other
trades           id, market_id, outcome_id, user_id, side ('buy'|'sell'),
                 shares, cost, fee, price_after, request_id, created_at
positions        user_id, market_id, outcome_id, shares, avg_price, realized_pnl

syndicates       id, market_id, creator_id, round_ends_at, min_total, state
syndicate_members id, syndicate_id, user_id, contribution, fee_share_pct
bonds            id, market_id, creator_id, amount, state ('held'|'refunded'|'forfeited')

resolutions      id, market_id, proposed_by, proposed_outcome_id, evidence_url,
                 proposed_at, finalized_by?, finalized_at?, final_outcome_id?
market_drafts    id, source ('ai'|'community'), template_json, balance_estimate,
                 engagement_score, blocklist_flags, state ('suggested'|'approved'|'rejected'),
                 reviewed_by?, created_at
market_outcomes_log  market_id, initial_split, final_split, volume, dispute_count   [AI feedback loop]

approvals        id, action_type, payload_json, requested_by, approver_1?, approver_2?,
                 state ('pending'|'approved'|'rejected'), created_at
admin_audit      id, staff_id, action, target_ref, before_json, after_json, ip, ts   [append-only]
reconciliation_runs  id, run_date, ledger_total, wallet_total, bank_total?, status, diff, cleared_by?
platform_config  key, value_json, effective_at, version, state ('active'|'pending'|'superseded')
config_versions  id, key, old_value, new_value, reason, proposed_by, approved_by, proposed_at, activated_at?
support_tickets  id, user_id, market_id?, category, state, sla_due, assigned_to?, created_at
rg_settings      user_id, deposit_limit?, stake_limit?, loss_limit?, cooloff_until?,
                 self_excluded, updated_at
notifications    id, user_id, type, payload_json, channel, sent_at, read_at?
events           id, user_id?, name, properties_json, ts                              [analytics]

creator_profiles user_id, level (1|2|3), clean_resolutions, total_volume_hosted,
                 accuracy_pct, badge_flags, follower_count
followers        follower_id, creator_id, notify, created_at
ticket_templates id, category ('bbnaija'|'football'|'election'|'economic'|'awards'|'transfer'|...),
                 template_json, localisable_fields, season_window?, active
opportunities    id, source ('calendar'|'search_gap'|'seasonal'), title, template_id?,
                 demand_score, claimed_by?, expires_at
market_autopsies market_id, creator_id, outcome_summary, tips_json, created_at

comments         id, market_id, user_id, text, position_snapshot ('YES@62'|'none'),
                 parent_id?, state ('live'|'flagged'|'removed'), created_at
reputation       user_id, category, accuracy_pct, calibration, title?, season, sample_size
squads           id, name, owner_id, member_count, screening_state, created_at
squad_members    squad_id, user_id, joined_at
squad_challenges id, squad_a, squad_b, market_set_json, period, score_a, score_b, state
challenges       id, market_id, challenger_id, position_snapshot, link_token,
                 accepted_by?, created_at
top_calls        id, week, user_id, market_id, entry_price, resolved_outcome, featured
disputes         id, market_id, user_id, evidence_url, text, state, decided_by?, decision?

price_history    market_id, outcome_id, price, pot, ts                    [ticket-view charts]
market_annotations id, market_id, type ('open'|'activation'|'big_trade'|'news'|'freeze'|'resolution'),
                 label, ts                                               [chart event pins]
leaderboard_snapshots  period, user_id, profit, accuracy, rank
```

---

## 4. API Surface (indicative)

```
POST /auth/signup, /auth/otp/verify, /auth/login
GET  /markets?shelf=&state=            GET /markets/:id (+prices, +my position)
GET  /markets/:id/history?tf=1h|6h|1d|1w|all   price/pot series + annotations
POST /markets/:id/trade                {outcome_id, side, shares, request_id}
POST /markets                          community creation via template
POST /markets/:id/seed                 Path B symmetric seed
POST /syndicates/:id/join              {amount}
POST /markets/:id/resolution           propose (creator/staff)
POST /markets/:id/dispute              {evidence_url, text}
GET  /wallet, /ledger, /leaderboard
GET  /wallet/deposit-account          POST /wallet/bank-accounts (+verify)
POST /wallet/withdrawals              GET  /wallet/statement?month=
POST /webhooks/processor              signed + idempotent (fintech, §2.16)
WS   /live                             price ticks, market state changes
Admin: create official market, set liquidity/seed params, confirm/void resolutions,
       decide disputes, pot & solvency dashboard per market, AI drafts queue
```

---

## 5. Tech Stack Recommendation

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js PWA, Tailwind | Mobile-first, installable, one codebase; native apps later |
| Backend | Node.js (NestJS) or Python (FastAPI) | Either fine; pick your team's strength |
| DB | PostgreSQL (primary + replicas, partitioned ledger) | Transactions are non-negotiable for a ledger; partitioning + replicas carry it to millions of users |
| Queue | Redis Streams at launch → Kafka at scale | Per-market ordered trade processing; burst absorption |
| Cache/RT | Redis (cluster at scale) + WebSocket gateway | Live prices are the product's heartbeat; pub/sub fan-out |
| SMS OTP | Termii or Africa's Talking | Nigerian delivery rates matter |
| Hosting | Managed cloud (Render/Railway/AWS Lagos region) | Boring and reliable |
| Charts | Lightweight-charts or Recharts | Price history per market |
| Future payments | Paystack / Flutterwave | Licensed phase only; module stubbed now |
| Future KYC | Smile ID / Prembly (NIN/BVN) | Licensed phase only |

---

## 6. Admin Platform Specification

One web app (same Next.js stack, `/admin` routes), gated by staff 2FA (§2.11), with every screen scoped by the role matrix and every action written to `admin_audit`. **Design signature: no god button** — no screen exists where one person can silently edit a balance, resolve a market without a trail, or spend escrow.

### 6.1 Dashboard (the morning screen)
Reconciliation status (green/red from `reconciliation_runs`), total escrow vs user liabilities, live market count, 24h volume & fees, queue health (trade latency, lag), open disputes & tickets vs SLA timers, and the two health metrics: pool-balance distribution and weekly returning traders.

### 6.2 Markets console
- **Official markets:** create from template — fed by the AI drafts queue (§2.9: ranked, scored, one-click open pre-filled); set liquidity/seed params; pause. Per-market view: live prices, pot total, solvency status, trade feed, participant count.
- **Community review queue:** user-submitted templates with AI screening scores (structure, blocklist, balance estimate, duplicates) → approve / reject-with-reason (reason shown to creator). First-time creators always flagged for human review.
- **Lifecycle controls:** funding-window checks, void after activation (four-eyes), seed/syndicate composition view.

### 6.3 Resolution centre
Markets in `pending_resolution`: proposed outcome, evidence link, the market's written rules, and the named source side-by-side. Confirm → dispute-window countdown. Disputes render challenger evidence vs proposal; decisions recorded with reasoning. Everything lands in the immutable resolution log — this screen's history is the future licensing exhibit.

### 6.4 Money room
- Ledger explorer: search any user/market/transaction; drill from any balance to every entry behind it.
- Reconciliation history + exception clearing (who, when, why).
- Fund-class view: `user_escrow | user_available | platform_fees | prize_pool` — segregation, visible (§2.10).
- **Approvals inbox:** pending four-eyes actions (large withdrawals, manual adjustments via reversing entries, bond forfeitures, post-activation voids) with first/second approver flow.
- Proof-of-reserves export; regulator report exports (licensed phase).

### 6.4b Platform Config Console (editable settings — maximum-security zone)
Every tunable value in this document lives here as an editable setting — never in code. Editable parameters include: resolution fees (official %, community % and creator/platform split), early-exit fee %, deposit pass-through rate/min/cap, withdrawal flat fee, minimum deposit/withdrawal, activation thresholds (points + backers), funding/seeding window lengths, syndicate caps, conduct bond size, per-market default `liquidity_param` guidance, Tier limits and starter balance, RG default limits, dispute-window length, and the `kyc_required_at` switch.

**Serious authentication — no single person can change platform economics:**
1. **Step-up re-auth:** opening the console requires a fresh TOTP 2FA challenge (§2.11) regardless of session age; the session elevation expires after [10] minutes.
2. **Four-eyes, mandatory:** every change is a proposal into the approvals workflow (§2.10) — a second, different admin must re-authenticate with their own 2FA and approve. The proposer can never self-approve. Money-affecting configs (all fees, caps, limits) additionally require the approver to hold the Finance or Admin role.
3. **Effective-date delay:** approved changes take effect after a visible delay (default [24]h, config) and **never retroactively** — markets already open resolve under the values in force when they opened (mirrors Rulebook Part 4).
4. **Versioned + immutable history:** every value change writes a `config_versions` row (old value, new value, proposer, approver, timestamps, reason text — reason is mandatory) and the `admin_audit` log; one-click rollback creates a new proposal, never an edit of history.
5. **Change notifications:** all admins are notified on every proposal and every activation; user-facing fee changes trigger an in-app notice per the Rulebook's amendment-notice rule.
6. **Rate limit:** max [3] config changes per parameter per [30] days without super-admin override — economics should move deliberately, not twitchily.

### 6.5 Users & Trust/Safety
User search: tier, balances, positions, history, device fingerprints, linked-account flags. Actions: freeze, ban, tier review — balance changes only via the approvals workflow (no direct edit exists). Abuse queue: wash-trading flags, stake-flood alerts, multi-account clusters, each with evidence + freeze/clear. **Community moderation queue (§2.15e):** flagged comments, tipster-pattern auto-flags, squad-name screening. RG view: self-exclusions, limits, RG requests (§2.12).

### 6.6 Creators desk
Creator leaderboard, bond statuses, resolution track records, level/badge management (progression ladder §2.14c), bond slash/refund (four-eyes), ban list. Plus: ticket-template library management (add/retire seasonal templates — BBNaija season, AFCON, election cycles), opportunity-feed curation, monthly top-creator bonus pool approval, and featured-market placement.

### 6.7 Support desk
Ticket queues by category with SLA amber/red timers; ticket view shows the user's **read-only** context (their market, their trade — never ledger internals); canned responses; escalation to resolver/admin.

### 6.8 Content & growth
Weekly prize runs (approve airtime payouts), **weekly Top Calls curation**, shareable-card and challenge-link previews, notification broadcasts, squad-challenge scheduling (season events), feature flags & A/B toggles, analytics dashboards.

### 6.9 System room (engineering)
Queue/worker status, deploy & canary controls, alert history, backup/restore drill logs, status-page incident posting.

### 6.10 Admin Frontend Design (built for speed of operation, not decoration)
The cockpit is a **desktop-first** web app (same Next.js codebase, `/admin` routes, same tokens as §7.4 but in a denser, calmer register — ink-green dark theme by default, gold strictly for money figures, red strictly for alarms). Its design goal is operational efficiency: an operator resolves a market, clears a reconciliation exception, or approves a config change in seconds, with zero ambiguity.

- **Layout:** persistent left rail (the nine screens, alarm badges on each), top bar with global status strip (reconciliation ✓/✗ · queue lag · open disputes · pending approvals), main content area. Nothing more than two clicks deep.
- **Command palette (Ctrl/Cmd-K):** jump to any user, market, ticket, transaction, or setting by typing — the fastest path to everything; power operators never touch the mouse. Full keyboard shortcuts on high-frequency actions (approve, next item, open evidence).
- **Live tiles, not static reports:** dashboard numbers stream over the same WebSocket as user prices — an operator watches trade latency or a funding meter move in real time.
- **Table ergonomics everywhere:** dense virtualized tables (smooth at 100k rows), sticky headers, per-column filters, saved views ("disputes > 24h", "withdrawals awaiting 2nd eye"), bulk select with bulk actions where safe (never on money), CSV export on every table.
- **Work-queue pattern for the four inboxes** (resolution centre, disputes, approvals, community review): items presented one-at-a-time with full context on a single screen — the market's rules, the evidence, the AI score, the history — decision buttons fixed bottom-right, auto-advance to the next item. Clearing a queue should feel like a rhythm.
- **Approvals UX:** every four-eyes item shows *what changes, old → new, who proposed, their written reason* in a diff-style card; the approve button triggers the step-up 2FA inline (§6.4b) without leaving the screen.
- **Inline audit visibility:** every entity page (user, market, config key) carries a chronological "history" side panel fed from admin_audit and config_versions — the trail is ambient, not buried in a separate log viewer.
- **Alarm discipline:** exactly three severities — red (money invariant / reconciliation / queue stall: pages on-call, banner across every admin screen), amber (SLA breach, abuse flag), neutral (informational). No decorative notifications; an admin who sees red knows it's real.
- **Safe-guarded destructive actions:** void, ban, forfeit, freeze all require typed confirmation of the entity name (GitHub-style) plus the four-eyes flow where mandated — muscle-memory clicks cannot destroy anything.
- **Mobile fallback (read + approve only):** a phone layout exposing the status strip, the four inboxes, and approve/deny with 2FA — so a second approver can unblock a withdrawal from anywhere; creation and editing remain desktop-only by design.
- **Performance budget:** every admin screen interactive < 1s on a mid-range laptop; queues paginate server-side; charts downsample. An admin tool that lags gets worked around, and workarounds are where money incidents start.

### 6.11 Role → screen matrix

| Role | Sees / does |
|---|---|
| Support | Support desk + read-only user context. No money, no markets. |
| Resolver | Resolution centre + disputes. No balances. |
| Trust & Safety | Users, abuse queue, creators desk. |
| Finance | Money room, approvals (as one of the two eyes). |
| Admin | Everything — but still no solo money moves (four-eyes), no trading (staff block), and every click audited, including the admin's own. |

---

## 7. Client Application Specification (user app — full build)

This document specifies the **complete platform, not an MVP** — the build order in §8 sequences the full scope. The user app is a mobile-first Next.js PWA (native wrappers later), naira-green identity, all live data over WebSocket.

### 7.1 App structure
- **Markets home:** two shelves (Official / Community) as scrollable card lists with filters (category, state, ending soon, trending). Search with unmet-demand capture (feeds the opportunity feed, §2.14b).
- **Market card (list view):** question, live headline % with a **mini sparkline** of the last 24h, pot size, time-to-freeze, state badge (FUNDING / LIVE / FROZEN / DISPUTE / RESOLVED), creator handle on community cards. The card breathes — price ticks animate in place.
- **My positions:** open positions with live P&L, closed history, pending payouts.
- **Leaderboards & profile:** accuracy, titles, receipts, followed creators, squad standings.
- **Create (wizard):** per §2.14a.

### 7.2 Market Detail — the Ticket View (tap any card)
Every ticket opens a full-screen detail view whose centrepiece is **the story of the market told visually**:

**a) Price chart (the hero).**
- Smooth **area chart** of probability over time (0–100%) for the selected outcome — default view; candlestick toggle for power users. Timeframes: 1H · 6H · 1D · 1W · ALL.
- Rendered from `price_history` (per-trade + per-minute snapshots) via read replicas/Redis; live points appended over WebSocket so the line moves while you watch.
- **Event annotations pinned on the chart:** market opened, activation reached, large trades (> [x]% of pot), admin news pins ("CBN statement 14:02"), freeze, resolution. The chart doubles as the market's timeline — a newcomer reads the whole drama at a glance.
- Binary markets: one line (YES). Multi-outcome: multi-line overlay with the outcome legend; tapping a candidate isolates their line.

**b) The argument bar.** Directly under the chart: the live YES/NO split bar (binary) or stacked 100% outcome bars (multi) — the "who's winning the argument right now" visual, always in sync with the chart's last point.

**c) Money strip.** Pot size with a small pot-growth sparkline, 24h volume, number of traders, fee rate — the market's liquidity health at a glance.

**d) Trade flow — the bottom-sheet Trade Ticket (Polymarket-pattern, not a betslip).**
Prices live on the buttons, and buying happens in a slide-up sheet — never a bookmaker-style betslip page.
- **Outcome rows carry priced buttons:** each outcome on the ticket view (and on multi-outcome lists) shows `Buy YES 62k` / `Buy NO 38k` — the button *is* the live price (kobo per ₦1-share equivalent in points), updating in place as the market moves.
- **Tapping a priced button slides up the Trade Ticket** (bottom sheet, one-hand reach): market thumbnail + question + chosen outcome/side at top (with a one-tap side-flip arrow), then:
  - **Amount-first entry** (default — simpler for our audience than shares-first): naira/points amount field with quick chips `₦500 · ₦1k · ₦2k · ₦5k` and `+/-` steppers; an advanced toggle switches to shares-entry with `−100 · −10 · +10 · +100` chips for power users.
  - **Live figures beneath, updating as they type:** current price per share · shares they'll receive · **Total** (what leaves their wallet) · **Est. to win** (pot-share estimate, labelled "estimate" per §2.3) · slippage note when the amount would move the price ("this trade moves YES to 64%").
  - **One primary `Trade` button** — full-width, instant AMM execution (no limit-order/expiry controls; the formula always fills — advanced limit-style orders are a possible far-future addition, not launch scope). Success = haptic + the living number ticking + position panel appearing in place.
- **Selling uses the same sheet** opened from the position panel: side pre-set to Sell, slider or chips for partial/full exit, exact refund quoted (`You receive ₦X`) before confirm.
- **Community tickets in FUNDING state** reuse the sheet for staking: side buttons show pool totals instead of prices; the sheet shows contribution → new pool total → activation progress.
- Sheet behaviours: drag-to-dismiss, keyboard-safe, Tier 0 starter-balance cap surfaced inline, RG limit warnings surfaced inline (§2.12), disabled state with reason when frozen/resolved.

**e) Community-market extras.** In FUNDING state the chart area is replaced by the **activation view**: both-side progress meters (amount + backers), countdown, seed/syndicate composition, share-to-fill buttons. On activation it flips to the live chart, with the activation moment permanently annotated.

**f) Below the fold:** the take thread with position badges (§2.15a), the rules card (question criteria, named source with link, event/void dates, freeze time), resolution status (proposed outcome + evidence + dispute-window countdown when applicable), and the share/challenge buttons.

**g) Resolved state.** The chart freezes with a final annotation (✓ outcome), the receipt panel shows the payout math (pot, fee, per-share value, your result), and the thread's prediction receipts light up.

### 7.3 Display rationale
The area-probability chart with event annotations is the chosen primary display because it answers the three questions every visitor has in one glance — *what does the crowd think now, how did we get here, and what moved it* — which a number alone or an odds table cannot. Sparklines on cards create the pull into detail views; the argument bar gives the instant emotional read; candlesticks stay optional to avoid intimidating casual users. All charts respect reduced-motion settings and render server-side snapshots for shared links (a shared ticket link unfurls with its chart image).

### 7.4 Design System — the "Naija Green" identity (captivating by craft, not by tricks)
The UI's job is to make numbers feel alive and being right feel glorious — while §2.12's responsible-play stance forbids dark patterns. Excitement comes from craft: motion, colour, and celebration tied to *real events*, never manufactured urgency.

**Tokens (single source of truth, `tokens.ts` consumed by Tailwind config):**
- Colour: `paper #FAFDF7` · `ink #10241B` · `green #0E7A3D` (rise/YES) · `green-deep #0A5A2D` · `red #C93A2E` (fall/NO) · `gold #E3A81C` (money: pots, fees, payouts — gold is *only* ever money) · `muted #5E7267` · `line #DCE7DC`. Dark mode: ink-green surfaces (`#0B1A13` base) with the same semantic roles — shipped day one, defaulting to system preference.
- Type: **Archivo** (variable; 900 for headline numbers and market questions — sports-ticker confidence; 400–600 body) + **Space Mono** for every live figure (prices, pots, P&L) with tabular numerals so digits never jitter as they change. Type scale 12/13.5/15/17/21/28/34.
- Radii 8–14px, 1px `line` borders, soft single-layer shadows only. Spacing on a 4px grid.

**Signature elements (the memorable three):**
1. **The argument bar** — the green/red split that physically shifts with every trade, eased with `cubic-bezier(.2,.8,.2,1)`. It appears everywhere a market does: full-width in ticket view, miniature on cards, tiny in share images. It is the brand.
2. **The living number** — every price/percentage animates by counting between values (never snapping), flashes a brief green/red tint on change, and ticks in real time from the WebSocket feed. A screen of StakePot is visibly *alive* within two seconds.
3. **The receipt** — resolution and payout screens rendered as a monospace "market receipt" (the demo's receipt panel, productised): pot, fee, your line — instantly screenshot-able, deliberately designed to be shared.
4. **SPcoin (the test-run currency, asset: `spcoin.svg`)** — the platform's points currency, designed as a beautiful object, not a number with a label. Visual spec: a gold coin (radial gradient `#F6C453 → #E3A81C → #B8860B`) with a deep-green (`#0A5A2D`) inner face carrying an embossed **pot silhouette** and the **SP monogram** in Archivo Black, ringed by a milled edge of dots; subtle top-left specular highlight; flat "small" variant (16–20px) for inline balances, full variant (48px+) for the Wallet header and win moments. Behaviour: balances render as `⟨coin⟩ 12,400 SP`; wins trigger the coin in the confetti burst (§ celebration); the deposit/win receipt stamps a small coin watermark. When NGN activates, SPcoin remains the loyalty/points identity (prizes, streak rewards) rather than disappearing — users keep the object they've grown attached to. Rule: gold stays money-only (§ tokens), and SPcoin is the only *object* rendered in gold.

**Motion & celebration (event-driven, respecting `prefers-reduced-motion`):**
- Price ticks: 250ms count-up + tint. Chart line draws in on ticket-view open (600ms, once).
- **Win moment:** resolution in your favour → confetti burst (green/gold), receipt slides up, haptic (native wrappers). Losses get quiet dignity — result shown plainly, no shame animations, one-tap to the market's thread.
- Activation moment on community tickets: both meters filling triggers a "LIVE" stamp animation — the creator's payoff moment, built to be screen-recorded.
- Micro-interactions: buttons depress (scale .97), chips snap, pull-to-refresh spins the brand mark. Nothing loops idly; motion always means something happened.

**Feel & polish standards:**
- Skeleton loaders shaped like the real content (card + sparkline ghosts) — no spinners on primary surfaces; data streams in progressively.
- Empty states are invitations with one clear action ("No positions yet — the naira market closes Friday. What do you say?").
- Copy in confident Nigerian register, sentence case, Pidgin where it lands ("Stake am", "Talk your own"); full localisation via string files (§2.13).
- One-hand reach: primary actions in the bottom half; trade panel as a bottom sheet; 44px minimum touch targets; visible keyboard focus; WCAG AA contrast throughout.
- Share images (market cards, receipts, Top Calls) generated server-side with the same tokens — the brand looks identical inside the app and on a WhatsApp status.
- **Anti-dark-pattern rules (enforced in review):** no countdown pressure except real freeze times, no near-miss theatrics, no autoplay reels of others' wins, session reality-checks styled as first-class UI rather than buried modals.

### 7.5 My Wallet (each customer's own money view)
The user's personal account screen — their money, fully visible, always reconcilable:
- **Balance header:** Available (spendable now) and **In Open Markets** (escrowed) shown separately with a one-line explainer — gold typography per §7.4 (gold = money).
- **Transaction history:** every ledger event in plain language ("Staked ₦2,000 — Naira market", "Won ₦3,410 — Eagles vs Ghana", "Sold early +₦450", "Withdrawal to GTB ••1234"), filterable, complete history because the ledger is append-only.
- **Actions:** Deposit (shows *their own* virtual account number with one-tap copy + "transfer from any bank app" guidance) and Withdraw (linked bank account, amount, fee shown, confirmation) — both licensed-phase; in points mode this screen shows points balance, history, and prize credits identically, so users learn the surface before real money arrives.
- Monthly statement download; receipt view per transaction.

### 7.6 Public Landing Page (the front door — logged-out visitors)
A marketing-grade page at the root domain, built on the same tokens (§7.4) but louder — its job: a stranger understands and signs up in under 30 seconds:
- **Hero:** the brand promise in Nigerian voice — "Nigeria argues about everything. StakePot is where arguments get settled — with receipts." Behind it, a **live animated market card** (real prices from the API — the argument bar shifting on the actual naira market) so the product demos itself before signup.
- **How-it-works strip:** three steps with §7.4 visuals — *Pick a question → Stake your side → Winners share the pot* — illustrated with the argument bar, the living number, and the receipt.
- **Live markets teaser:** 3–4 real trending cards (read-only), tappable → sign-up sheet. Social proof: total staked this week, top forecaster of the week, biggest correct call.
- **Trust block:** how resolution works (one named source, dispute window), escrow explainer ("your stake sits in the pot until the result — winners are paid only from the pot"), responsible-play links, licence details when live.
- **Community strip:** Top Calls receipts and creator spotlights — real screenshots of being right.
- **Signup CTA repeated** (email or phone, 10 seconds — §2.1 Tier 0) + PWA install prompt.
- SEO-complete: server-rendered public market pages at /market/[slug] (read-only with chart snapshot) so every ticket is a Google-indexable, shareable landing page — each market markets the platform.


---

## 8. Build Order (sequencing of the full scope — nothing here is optional)

1. Auth (tiered) + wallet/ledger with fund tagging + reconciliation job + admin audit — the foundation everything trusts *(installs: Step-1 manifest — Next/Nest, Prisma, decimal.js, argon2, JWT, zod, ioredis, pino, helmet)*
2. Hybrid engine + one binary official market end-to-end (trade → escrow → early exit → resolve → per-share payout), with its test suite written alongside *(installs: vitest, supertest, fast-check, husky/eslint)*
3. CI/CD + staging + feature flags + monitoring/alerting (before more features, not after) *(installs: Sentry, prom-client, Docker, GitHub Actions)*
4. Live prices (Redis + Realtime Gateway) + the full Ticket View per §7.2 — including the bottom-sheet Trade Ticket with priced outcome buttons (§7.2d) — and design system per §7.4 *(installs: socket.io, lightweight-charts, tailwind, framer-motion, zustand, lucide, date-fns; sheet via framer-motion or vaul)*
5. Multi-outcome markets (election-style candidate lists, multi-line charts)
6. Community shelf: creation wizard (AI co-pilot + balance meter + ticket-template library), Path A funding window, activation checks, voids *(installs: react-hook-form, @anthropic-ai/sdk, bullmq)*
7. Path B seeds + Sponsor Syndicates + conduct bonds
8. Resolution/dispute flows + four-eyes approvals + admin panel + pot/solvency dashboard
9. Support ticketing + notifications + status page + RG module (dormant limits) *(installs: Termii client, web-push, otplib)*
10. AI Market Question Engine (drafts queue + community screening + wizard co-pilot mode)
11. Creator platform: profiles, follow system, progression levels, opportunity feed, share kit, analytics, nudges, autopsies *(installs: @vercel/og for share cards)*
12. Community layer phase 1: take threads with position badges + challenge links (per §2.15f; titles, Top Calls, and Squads ship post-launch per the sequencing) *(installs: canvas-confetti, next-intl, @serwist/next)*
13. Leaderboards, sharing cards, prize tool, analytics events
14. Hardening: per-market queue, idempotency, rate limits, abuse detection, security review, load test at 10× peak *(installs: rate-limiter-flexible, k6, playwright; kafkajs when §12 scale triggers)*

Team estimate revised: 2–3 developers, 10–14 weeks to a company-grade points-mode launch (vs 6–10 weeks for the bare product — the difference is the controls, tests, and operations machinery, which is exactly the difference between a platform and a company).

### 5.1 Dependency Manifest (the plugins, mapped to when the build picks them up)
Install-by-step: each build-order step (§8) lists its packages here, so the project never carries unused dependencies and every install has a reason.

**Step 1 — Foundation (auth, wallet, ledger):**
`next` `react` `typescript` · `@nestjs/core` (or `fastapi`) · `prisma` + `@prisma/client` (Postgres ORM + migrations) · `decimal.js` (**all money math — never floats**) · `argon2` (password hashing) · `@nestjs/jwt` + `passport-jwt` (sessions) · `zod` + `class-validator` (input validation) · `ioredis` (Redis client) · `pino` (structured logging) · `helmet` (security headers)

**Step 2 — Engine + tests:**
`vitest`/`jest` + `supertest` (unit/integration) · **`fast-check`** (property-based testing — the "pot ≥ 0 under random trade storms" proofs from §2.3) · `husky` + `lint-staged` + `eslint` + `prettier` (money-path review discipline)

**Step 3 — CI/CD & observability:**
`@sentry/nextjs` + `@sentry/node` (error tracking) · `prom-client` (metrics for trade latency/queue lag/invariants) · GitHub Actions (pipeline) · `docker` (parity across dev/staging/prod)

**Step 4 — Live prices & the Ticket View:**
`socket.io` + `socket.io-client` (realtime gateway/fan-out) · **`lightweight-charts`** (TradingView's chart library — the §7.2 area chart with annotations) · `tailwindcss` (tokens → utility classes) · **`framer-motion`** (argument bar, living numbers, all §7.4 motion) · `@formkit/auto-animate` (list transitions) · `lucide-react` (icons) · `zustand` (client state: positions, prices) · `date-fns` (freeze/void countdowns)

**Step 6 — Community shelf & wizard:**
`react-hook-form` + `@hookform/resolvers` (wizard forms with zod schemas) · **`@anthropic-ai/sdk`** (the AI co-pilot & question engine, §2.9/§2.14a) · `bullmq` (Redis-based job queues: funding-window checks, payout batches, autopsies)

**Step 9 — Support, notifications, RG:**
Termii REST API (SMS OTP — thin client, no heavy SDK) · `nodemailer` or Resend (email) · `web-push` (PWA push notifications) · `otplib` + `qrcode` (staff TOTP 2FA, §2.11)

**Step 11–13 — Creator tools, community, sharing:**
`@vercel/og` or `satori` (server-rendered share cards & receipts — §7.4's WhatsApp-identical brand images) · `canvas-confetti` (win moments) · `next-intl` (localisation scaffolding) · `@serwist/next` (PWA service worker: installable app, offline shell)

**Step 14 — Hardening & scale:**
`rate-limiter-flexible` (per-user/IP limits) · `k6` (scripted 10× peak load tests) · `playwright` (end-to-end user journeys) · `kafkajs` (queue migration at scale, §12) · PgBouncer (connection pooling, infra-level)

**Licensed phase (stubbed now, installed then):** Paystack Node SDK + Flutterwave SDK (payments) · Smile ID / Prembly SDK (NIN/BVN KYC).

Rule of the manifest: **no package outside this list enters the repo without a written reason in the PR** — dependency sprawl is how money platforms grow silent vulnerabilities.

---

## 9. Licensed-Phase Switch (designed in, not built yet)

When licensed (state licence via gaming counsel — pool-betting category, Oyo/Ogun/Lagos route):
- Flip wallet currency SPC (SPcoin) → NGN; enable deposit/withdraw endpoints wired to Paystack/Flutterwave
- Activate Tier 2 KYC (NIN/BVN) at first withdrawal — or at deposit if the licence requires it (config switch); withdrawal fee config
- Activate RG limits at licence-mandated levels (module already built and tested in points mode — §2.12)
- Open segregated bank accounts; point the reconciliation job's bank leg at them (fund tagging already enforces the split — §2.10)
- Regulator reporting + proof-of-reserves exports from the ledger (already built — §2.10)
- Community real-money markets last — points-mode community tier continues meanwhile

Nothing in the core engines changes. That is the payoff of the currency-agnostic ledger.

---

## 10. Key Invariants (the platform's safety, in five lines)

1. Hybrid engine: winners are paid only from the market's escrowed pot — `total_payouts + fees ≤ total_collected`, every market, always.
2. Early-exit buybacks are priced off actual pot contents — the pot can never go negative.
3. Every stake/trade is escrowed atomically with the ledger entry — no orphaned money.
4. No resolution pays out before platform confirmation + dispute window elapsed.
5. Ledger is append-only; balances are derivable from it; nightly audit proves it.

---

## 11. Throughput Design — how trades stay correct under load

The one hard concurrency problem in this system: **two simultaneous trades on the same market must not both price off the same pot state.** The solution is per-market serialization, which also happens to be the key to horizontal scale:

- **Per-market ordered queues.** Every trade/stake/exit request is published to a message queue partitioned by `market_id` (Kafka partitions or Redis Streams consumer groups). All events for one market land in one partition, consumed in order by exactly one Trade Worker at a time. Within a market: strict sequence, no race conditions, no locks fighting. Across markets: unlimited parallelism — 1,000 markets can process trades simultaneously on separate workers.
- **Atomic execution.** Each consumed trade runs as a single DB transaction: read pot state → price via formula → write ledger entries + new pot state + price snapshot → publish `price_changed` event. Target: <10ms per trade; a single worker sustains thousands of trades/minute per hot market, and hot markets can be pinned to dedicated workers.
- **Idempotency.** Every trade request carries a client-generated `request_id`; the worker skips duplicates. Retries, double-taps, and network flaps can never double-charge.
- **Backpressure, not failure.** Under spikes (election night, match kickoff), the queue absorbs the burst; users see "order placed" instantly (accepted into queue) and confirmation when executed — the same pattern real exchanges use.
- **Read path never touches the write path.** Prices, charts, market lists, and leaderboards are served from Redis and read replicas. Only trades hit the primary. A million viewers watching prices costs the trading engine nothing.

---

## 12. Scale Architecture — millions of users

The launch monolith and the scaled cluster are the same codebase; scaling is a deployment change per layer:

| Layer | Launch (→ ~100K users) | Scale (millions) |
|---|---|---|
| API | 2–3 stateless nodes behind LB | Auto-scaled N replicas; JWT-only state |
| Trade processing | Queue + 2 workers | Kafka, partitions by market_id, worker fleet; hot-market pinning |
| WebSocket / live prices | 1–2 gateway nodes | Dedicated realtime gateway fleet; Redis pub/sub fan-out; clients subscribe per-market; delta updates + 250ms coalescing on hot markets |
| PostgreSQL | Primary + 1 read replica | Primary (writes) + N read replicas; ledger & trades tables time-partitioned; archive closed markets to cold storage; connection pooling (PgBouncer) |
| Redis | Single instance | Cluster: sessions, price cache, pub/sub, rate-limit counters |
| Async work | Cron jobs in-process | Worker fleet off the queue: payout batches (chunked, resumable), leaderboards (streaming updates), AI drafts, audits, SMS/email |
| Static/app shell | CDN from day one | Same (CDN absorbs traffic spikes before they reach you) |

**Payout batches at scale:** resolving a market with 500K participants runs as a chunked, resumable queue job (e.g., 10K ledger transactions per chunk, checkpointed) — a crash resumes, never double-pays (idempotent per position).

**Reliability & operations:**
- Multi-AZ deployment; DB automated failover; queue replication.
- Backups: continuous WAL archiving + daily snapshots; tested restores; RPO minutes, RTO < 1 hour.
- Observability from day one: metrics (trade latency, queue lag, pot-invariant checks), structured logs, alerting on invariant violations, error budgets.
- Rate limiting per user/IP at the LB and per-endpoint; bot/abuse detection on trade patterns.
- Feature flags + gradual rollouts; load tests simulating election-night spikes (target: 10× normal peak) before every major event.
- Security: TLS everywhere, secrets management, least-privilege DB roles, audit trail on all admin actions.

**Why this handles "millions at once":** users mostly *read* (prices, lists, charts) — served by CDN, Redis, and replicas at near-zero marginal cost. Writes (trades) are partitioned per market and serialized only where correctness demands it, so capacity grows linearly with workers and partitions. The ledger is append-only and partitioned, which is the write pattern Postgres scales best at. Nothing in the money path depends on a single machine being big — only on each market's events being ordered, which the queue guarantees at any size.
