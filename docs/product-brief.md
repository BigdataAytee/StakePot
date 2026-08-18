# StakePot

**Nigeria argues about everything — elections, the naira, the Super Eagles, BBNaija. StakePot is where those arguments get settled, with receipts.**

StakePot is a prediction market built for Nigeria. People trade on the outcomes of real events: buy shares in what you believe, watch the live percentage move as the crowd trades, sell out early to lock in profit, or hold to resolution and split the pot with everyone who called it right. Every market resolves against one named official source — INEC, CBN, NBS, CAF — so there is never an argument about the argument.

---

## What makes it different

**The platform never bets.** StakePot runs a hybrid market engine (LMSR-curve pricing with pot-share payouts): every stake goes into an escrowed pot, live prices move with every trade, and winners are paid *only* from that pot. Payouts can never exceed what was collected — a mathematical identity, verified by simulation, not a policy. The platform earns a small fee on resolved markets and nothing from anyone losing. No house. No house edge. No conflict of interest.

**Anyone can open a market.** Alongside the official shelf (naira/dollar, inflation, Super Eagles, elections, one trending slot), any user can create a community ticket through a guided wizard — an AI co-pilot turns "who go win the Surulere LGA chairmanship" into a clean, dated, sourced market, warns if the question is too one-sided to attract both sides, and previews what the creator earns. Markets activate when both sides fund up (or instantly via a creator's symmetric seed, or a sponsor syndicate that shares the rewards). Creators earn 4% of losing pools and climb a ladder: New → Verified → Pro.

**Every ticket tells its story.** Tap any market and the first thing you see is its chart — the crowd's probability over time, annotated with everything that moved it: activation, big trades, news pins, freeze, resolution. Under it, the live argument bar, the pot, your position with real-time P&L, and the take thread — where every comment carries the commenter's position badge, and being right becomes a permanent, screenshot-able receipt.

**Balanced questions by design.** An AI question engine drafts official markets pitched at genuine 50/50 disagreement (backtested against real Nigerian events: 83% of engine-drafted markets land in the 35–65% band vs 50% for naive drafting, earning ~24% more per market) and screens every community submission. Humans approve everything; the AI never publishes alone.

**Community with skin in the game.** Forecasting reputation scores, seasonal titles ("Football Prophet," "Oracle of Naira"), weekly Top Calls, squads with private leaderboards and squad-vs-squad challenges, and challenge links — *"I'm YES at 60%. Prove me wrong."*

## How the money works

- Users win by being right, or by selling early at a better price.
- Creators earn 4% of losing pools on their markets, plus status.
- The platform earns 3% of resolved-market losing pools (official and its share of community markets) plus a 1% early-exit fee — whichever outcome wins. Money movement is pass-through: deposits at processor cost (1% capped ₦300 — we add nothing), withdrawals ₦100 flat; the platform bears no payment costs.
- Every stake is escrowed from the moment it's placed; voided markets refund in full; an append-only ledger, daily reconciliation, fund tagging, and four-eyes approvals mean no one — including staff — can move user money silently.

## Current phase

**Points mode.** The full product runs on platform points (no cash value), which requires no gaming licence and carries no financial risk while the product and community are proven. The wallet is currency-agnostic: after licensing (state pool-betting route, with Nigerian gaming counsel), points flip to naira by configuration — Paystack/Flutterwave deposits, NIN/BVN verification at withdrawal, and responsible-play limits activate on the same engines, unchanged.

## Repository contents

| File | What it is |
|---|---|
| `platform-architecture.md` | Complete full-platform specification (v1.1): hybrid engine with exact pricing math, tiered auth, AI question engine, creator platform, community layer, financial controls, admin cockpit, client app & ticket-view spec, scale design to millions |
| `market-rulebook.md` | The rules every market runs on: resolution, disputes, voids, community activation paths, syndicates, prohibited markets |
| `pricing_sim.py` | Pricing-engine simulation & regression test — proves pot ≥ 0 and platform cost = ₦0.00 under stress; must pass before any engine change ships |
| `ai_backtest.py` | Question-engine backtest harness against historical Nigerian events; reruns as real resolved-market data accumulates |
| `prediction-market-demo.html` | Clickable demo: binary market, multi-outcome election, community pool with activation — every button runs the real v1.1 formula |

## The one-line version

**Say what will happen. Put your stake in the pot. The result will show who talked true — and the winners share the pot.**

---
*Tech: Next.js PWA · Node/Python API · PostgreSQL (partitioned, replicated) · Redis · per-market ordered queues (Redis Streams → Kafka) · full spec in `platform-architecture.md`.*
