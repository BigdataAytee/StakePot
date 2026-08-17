# Market Rulebook
### [Platform Name] — Prediction Market Rules (Points Mode)
**Version 1.0 — Draft**

---

## Part 1: Platform-Wide Rules
*(These apply to every market on the platform, official and community.)*

### 1. What a market is
A market is a question about a future event with a defined set of outcomes. Users stake points on the outcome they believe will happen. When the event concludes, the market resolves according to the rules written on its page, and winning positions are paid out.

**The rules written on a market's page at the time it opens are final.** They cannot be changed after trading begins, except to fix an obvious typographical error that does not alter meaning.

### 2. Currency
All markets currently operate in platform points. Points have no cash value, cannot be purchased, sold, or transferred between users, and cannot be redeemed for money or goods except through official platform promotions (e.g., leaderboard prizes).

### 3. Eligibility
Users must be 18 or older and verify a Nigerian phone number. One account per person. Duplicate accounts will be closed and balances voided.

### 4. Resolution — the golden rule
Every market names exactly **one Resolution Source** before it opens. The market resolves according to what that source says — not what other media report, not what "everyone knows," not what seems fair. If the named source and reality appear to differ, the named source still governs.

### 5. Resolution process
1. After the event concludes, the platform (or, for community markets, the creator) posts a **Proposed Resolution** with a link or reference to the Resolution Source.
2. A **48-hour Dispute Window** opens. Any participant in the market may file a dispute with evidence from the Resolution Source.
3. After the window closes (or after a dispute is decided), the platform posts the **Final Resolution** and payouts are made automatically.
4. Final Resolutions are final. The platform's decision on a dispute is binding within the app.

### 6. Void markets (full refund)
A market is **voided** and all stakes refunded in full if any of the following occurs:
- The event does not take place by the market's **Void Date**.
- The Resolution Source ceases to exist or does not publish a result by the Void Date.
- The outcome cannot be determined under the market's written rules (genuine ambiguity).
- The market is found to have violated platform rules (see §8).
- For community markets: the activation threshold is not met (see Part 3, §2).

Voided stakes are returned from escrow at exactly the amount staked. No fees are charged on voided markets.

### 7. Escrow
All staked points are held in escrow from the moment of staking until resolution or void. Staked points cannot be spent elsewhere while a market is open.

### 8. Prohibited markets
No market may be created about:
- The death, injury, illness, or harm of any person
- Crimes, violence, or security incidents
- Any event a participant or creator can influence or has inside knowledge of
- Private individuals or private matters (markets must concern public events)
- Outcomes with no checkable official source

The platform may remove any market at its discretion; removed markets are voided and refunded.

### 9. Market manipulation
Coordinated trading to distort prices, trading on inside knowledge, creating markets about events you can influence, and false resolution proposals are prohibited. Penalties: void of positions, forfeiture of creator bonds, account suspension or ban.

### 10. Fees
- **Official markets:** [1.5]% fee per trade.
- **Community markets:** [3]% of the losing pool at payout — [2]% to the platform, [1]% to the market creator.
- Fees are displayed before any trade or stake is confirmed. No fees on voided markets.

---

## Part 2: Official Market Template
*(Every official market page must complete every field before opening.)*

| Field | Rule |
|---|---|
| **Question** | One sentence, binary or multi-outcome, no ambiguity. |
| **Outcomes** | Yes/No, or a complete list of outcomes including a final "Any other outcome" option so the list covers all possibilities. |
| **Resolution Source** | Exactly one named official source (e.g., "INEC's official declared result as published at inecnigeria.org"). |
| **Resolution Criteria** | The precise condition for each outcome (e.g., "Resolves YES if the CBN official closing rate on 31 March 2027 is above ₦1,500/$1"). |
| **Event Date** | When the event is scheduled to occur. |
| **Void Date** | The date after which, if unresolved, the market voids and refunds. Must be a specific calendar date. |
| **Edge Cases** | What happens if postponed, abandoned, replayed, or partially completed. Every foreseeable edge case must map to an outcome or to VOID. |

### Worked example — binary

> **Question:** Will Nigeria's headline inflation rate for September 2026 be below 20%?
> **Outcomes:** Yes / No
> **Resolution Source:** National Bureau of Statistics (NBS) CPI report for September 2026, as first published at nigerianstat.gov.ng.
> **Resolution Criteria:** Resolves YES if the year-on-year headline inflation figure in that report is strictly below 20.00%. Resolves NO if 20.00% or above. Later revisions to the figure are ignored; the first published figure governs.
> **Event Date:** NBS publication, expected mid-October 2026.
> **Void Date:** 30 November 2026. If NBS has not published the September figure by this date, the market voids.
> **Edge Cases:** If NBS changes its methodology before publication, the market resolves on the headline figure NBS itself labels as the September 2026 year-on-year rate. If NBS publishes no such figure by the Void Date, VOID.

### Worked example — multi-outcome

> **Question:** Which team will win AFCON 2027?
> **Outcomes:** Nigeria / Senegal / Morocco / Egypt / Côte d'Ivoire / Any other team
> **Resolution Source:** CAF's official declaration of the tournament winner (cafonline.com).
> **Resolution Criteria:** The outcome matching the team CAF declares champion resolves YES; all others resolve NO. "Any other team" resolves YES if the champion is not individually listed.
> **Event Date:** Final scheduled [date].
> **Void Date:** [Date ~60 days after scheduled final]. If the tournament is cancelled or no champion is declared by then, VOID.
> **Edge Cases:** Postponement within the Void Date window: market stays open and resolves on the actual final. Awarded/forfeited title: whatever team CAF declares champion counts.

---

## Part 3: Community Market Rules
*(Additional rules for user-created markets.)*

### 1. Creation
- Community markets are created only through the platform template (same fields as Part 2). Free-text questions are not permitted.
- The creator posts a refundable **Conduct Bond** of [2,000] points on creation.
- The creator may not stake in their own market, **except** through the symmetric Instant Activation seed in §2 Path B.
- Creators must not create markets about events they can influence or have inside knowledge of.

### 2. Activation — two paths
A community market goes live by **either** of the following paths. The creator chooses at creation.

**Path A — Organic activation (free)**
The market opens for staking in a **Funding Window** of [7] days. It activates only if, by the end of the window:
- The YES pool holds at least [20,000] points from at least [10] distinct users, **and**
- The NO pool holds at least [20,000] points from at least [10] distinct users.

If either side falls short, the market auto-voids and all stakes are refunded in full from escrow.

**Path B — Instant activation (creator-seeded)**
At creation, the creator stakes a **Symmetric Seed** of at least [20,000] points into **each** pool (equal amounts on every side — for multi-outcome markets, equal amounts into every listed outcome). The market opens for staking immediately.
- The seed must always be symmetric. A creator can never hold an unequal position in their own market.
- The seed is escrowed like any other stake and is treated as an ordinary stake at payout: the winning-side portion returns with its pro-rata share of the losing pool(s); the losing-side portion is lost into the pool.
- The creator's maximum possible loss is therefore one side's seed (in a balanced market the net cost is usually only a small fraction of that), and the platform bears no cost in any scenario.
- **Participation floor:** if fewer than [10] distinct users other than the creator have staked by the end of the Funding Window, the market voids and all stakes — including the full seed — are refunded.

*(For multi-outcome community pools under Path A: the market activates on the **total pot threshold** ([total ≥ 40,000] points from [≥ 20] distinct users) with **at least [2] outcomes funded** — tail outcomes may be lightly funded, with the "Any other" option absorbing residual interest. A strict per-outcome minimum is not required, as it unfairly voids well-balanced multi-outcome markets.)*

**Seed payout example (Path B):** Creator seeds 20,000 YES + 20,000 NO. Other users stake 30,000 more YES and 25,000 more NO. Final pools: YES 50,000, NO 45,000. YES wins. Losing pool 45,000 − [3]% fee (1,350) = 43,650 shared pro-rata among YES stakers. The creator held 20,000 of 50,000 YES (40%) → receives 20,000 + 17,460 = 37,460, having staked 40,000 total. Net cost: 2,540 — plus he earns the 1% creator fee (450) on the losing pool, so his true cost of instant launch was ~2,090 points.

### 3. Sponsor Syndicates (group-seeded activation)
A creator choosing Path B may open a **Seeding Round** instead of funding the Symmetric Seed alone.

- **Contributions:** Any user may join as a sponsor during the Seeding Round of [3] days, contributing any amount of at least [2,000] points. Every contribution is automatically split **equally across all sides/outcomes** of the market — sponsors can never hold a directional position through the seed.
- **Activation:** When total contributions reach the Symmetric Seed minimum ([20,000] points per side), the market opens for staking immediately.
- **Failure to fill:** If the Seeding Round ends below the minimum, the market voids and all contributions are refunded in full.
- **Syndicate size:** Maximum [20] sponsors per market.
- **Fee split:** The [1]% creator fee becomes the **syndicate fee**. Default split: pro-rata to each sponsor's share of the total seed. Alternatively, the creator may set a custom split at creation (e.g., [40]% to the creator as organiser, remainder pro-rata among co-sponsors). The split is displayed on the market page before any sponsor joins and is locked once the Seeding Round opens.
- **Seed payout:** Each sponsor's seed behaves exactly as in Path B — the winning-side portion returns with its pro-rata share of the losing pool(s); the losing-side portion is lost into the pool. Each sponsor's maximum loss is capped at their own contribution.
- **Governance:** Only the creator proposes resolution and posts the Conduct Bond. Sponsors have no resolution or dispute powers beyond those of ordinary participants. Sponsors may also stake directionally in the market as ordinary users; those stakes are separate from and unrelated to their seed.

### 4. Staking and payout
- Stakes are accepted only during the Funding Window. After activation, no new stakes and no early exit — positions are held to resolution.
- At resolution, the losing pool(s), minus the [3]% fee, are distributed to winning stakers **in proportion to their stakes**.
- Example: YES pool 50,000, NO pool 30,000. YES wins. Fee: 3% of 30,000 = 900 (600 platform, 300 creator). Remaining 29,100 is shared among YES stakers pro-rata — a user who staked 5,000 of the 50,000 YES pool (10%) receives their 5,000 back plus 2,910.

### 5. Creator duties and bond
- The creator must post the Proposed Resolution within [48] hours of the event concluding, with reference to the Resolution Source.
- The platform confirms every community resolution before payout.
- The Conduct Bond is refunded after clean resolution. It is **forfeited** if the creator: proposes a resolution contradicted by the named source, abandons resolution, is found to have inside influence, or breaks Part 1 §8–9. Forfeited bonds fund the platform's dispute-handling.
- Repeat violations: permanent loss of creation rights.

### 6. Disputes
Same 48-hour Dispute Window as Part 1 §5. Only evidence from the market's named Resolution Source is admissible. The platform's decision is final.

---

## Part 4: Amendments
The platform may amend this Rulebook with [14] days' notice. Amendments never apply retroactively to markets already open — those resolve under the rules in force when they opened.

---

*Bracketed values [like this] are settings for you to finalise. This document is a product-design draft, not legal advice — have a Nigerian gaming lawyer review it before any real-money launch.*
