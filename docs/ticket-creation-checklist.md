# Ticket Creation Checklist

### Every rule and judgement call for opening a market on StakeAm

_Companion to `market-rulebook.md`. The wizard enforces the mechanical rules; this document covers those plus the editorial judgement no software can make for you._

---

## PART 1 — THE FIVE NON-NEGOTIABLES

_A ticket failing any of these must never publish._

1. **One named official source, fixed before opening.** Name the exact body and page — "CBN official closing rate at cbn.gov.ng", "INEC declared result", "NBS CPI report", "CAF official declaration". Never "widely reported", "the news", or "confirmed sources".
2. **A specific event date AND a separate void date.** Event date = when it should happen. Void date = when you refund everyone if it hasn't. A market without a void date can trap money indefinitely.
3. **Complete, mutually exclusive outcomes.** Binary must be truly binary. Multi-outcome must include "Any other" so no result falls outside the list. Outcomes must not overlap.
4. **Edge cases mapped in advance.** Postponed / cancelled / abandoned / replayed / source publishes nothing / result disputed / methodology changed — each maps to an outcome or to VOID, written on the page before trading opens.
5. **Nobody trading can influence the outcome.** Public, national-scale events only. Never something the creator, staff, or participants could affect.

---

## PART 2 — COMMERCIAL RULES

_Fail these and the ticket is legal but worthless._

6. **Genuine disagreement — target 35–65%.** Obvious answers produce one-sided pools, pennies in fees, and often fail to activate. Test: _would two friends actually stake against each other on this?_
7. **Set thresholds at consensus, not round numbers.** "Inflation below 20%" when the trend is 30% is dead on arrival; "below [the published forecast]" splits the room.
8. **Expect news flow before settlement.** A question nobody hears about again until the result earns once; one in the news daily earns all week.
9. **Emotional stakes.** Football, elections, naira, fuel, entertainment — things people already argue about unprompted.
10. **Deadline close enough to hold attention.** Days to weeks normally; months only for blockbusters (elections, tournaments).
11. **Prefer multi-outcome where the story allows.** "Who wins?" splits money across several outcomes — naturally more balanced, and every fanbase gets a reason to stake.
12. **Round, memorable thresholds where they don't hurt balance.** ₦1,500/$ is easier to argue about than ₦1,487/$ — pick the memorable number _near_ consensus.

---

## PART 3 — THE FORBIDDEN LIST

_Never publish, no exceptions._

13. Death, injury, illness, or harm to any person.
14. Crimes, violence, terrorism, security incidents.
15. Private individuals or private matters — public events and public figures acting publicly only.
16. Anything a participant can influence or has inside knowledge of.
17. Outcomes with no checkable official source.
18. Anything that would embarrass the platform if screenshotted — the "front page test". Legal but tasteless markets cost more in brand than they earn in fees.
19. Markets on the platform's own operations, staff, or finances (conflict of interest).
20. Politically inflammatory framings — the _event_ may be political; the _wording_ must be neutral. Never phrase a market so one side reads as an insult.

---

## PART 4 — CRAFT & OPERATIONS

21. **Duplicate check before publishing.** Two similar markets split liquidity and both die. Merge or differentiate clearly.
22. **Freeze at event start.** Trading stops at kickoff / polls closing / publication time, so nobody trades on a known result.
23. **Wording is final once open.** Typos may be fixed; meaning never. Read it twice as the losing side hunting for a loophole.
24. **Size L to expected volume (≈25× typical stake).** Too small = wild swings; too large = a frozen-looking market.
25. **The stranger test.** Could someone with no context resolve it correctly using only the page and the named source? If two reasonable people could settle it differently, rewrite it.
26. **Timezone stated explicitly.** "By 30 September" means nothing without a zone and time — use WAT and give an hour ("23:59 WAT, 30 September 2026").
27. **First-published-figure rule.** For statistics that get revised (inflation, GDP), state that the _first_ published figure governs, revisions ignored.
28. **Name the exact metric.** "Inflation" is ambiguous — say "year-on-year headline CPI as published by NBS". "Fuel price" — say "NNPC retail price in Lagos".
29. **Currency, unit, and rate window stated.** Which naira rate — official window, closing, or average? Say which.
30. **Icon, category, and tags set** so the market is findable and looks finished on the card.
31. **Launch timing.** Open early enough to accumulate liquidity, late enough that interest exists. For fixtures: 3–7 days ahead. For elections: weeks to months.
32. **Recurring markets: refresh thresholds each cycle.** Last month's consensus is not this month's — retune or the series drifts lopsided.
33. **Check the calendar for collisions.** Don't launch five markets settling the same day; stagger settlements so the app always has something live.
34. **Don't over-list.** A few busy markets beat many empty ones. Concentrate liquidity.

---

## PART 5 — AFTER PUBLISHING

35. **Watch the split for 48 hours.** Anything running past 75/25 was probably a bad question — note it for the next cycle's retune.
36. **Watch for one-sided whale entry.** A single large early position on a thin market distorts price; flag it, and consider seeding the other side or lowering L next time.
37. **Pin news to the market as the story develops** — it feeds the chart annotations and the context panel, and it keeps traders returning.
38. **Prepare the resolution before the event ends.** Have the source page open and know exactly which figure/statement you'll cite.
39. **Resolve promptly.** Slow settlement is the fastest way to lose trust; propose within hours of the result, not days.
40. **Never resolve alone.** Four-eyes: one staff member proposes, a second confirms. This protects you as much as the users.
41. **Honour the dispute window even when the result is obvious.** Skipping process on easy cases teaches you to skip it on hard ones.
42. **Void cleanly and loudly.** If it must void, refund immediately and explain why in-app — a well-handled void builds more trust than a smooth settlement.
43. **Log the post-mortem.** Volume, final split, disputes, what you'd change. This is the data that trains the AI question engine and sharpens the next batch.

---

## PART 6 — RED FLAGS TO STOP AND RETHINK

- You had to explain the question twice to a friend before they understood it → rewrite.
- You cannot name the exact webpage that will settle it → don't publish.
- You find yourself hoping a particular side wins → conflict; hand it to someone else.
- The interesting part of the event is _how_ it happens, not _whether_ → the question is wrong.
- You are unsure whether it's in the forbidden list → treat that uncertainty as a no.
- The market's appeal depends on a rumour rather than a scheduled event → wait for a date.

---

_Mechanical rules (1–5, 13–17, 21–22, 26) are enforced by the Market Studio wizard. Rules 6, 25, 18, and Part 6 are editorial judgement — they are what separates a market that hums from one that sits empty or ends in an argument._
