---
name: stakepot-market-rules
description: >
  The 43 rules in docs/ticket-creation-checklist.md, and where each one is
  already enforced in code. Load this before writing, reviewing or changing
  anything that opens a market on StakeAm — the Market Studio wizard, the AI
  question engine, the community creation path, market templates and recurring
  series, the draft review endpoint, or packages/rules itself. Also load it
  when asked to draft or critique an actual market question, to change what a
  market may be about, to touch event dates, void dates, freeze times,
  outcomes, thresholds or resolution sources, or when a change would let a
  market publish that could not publish before. If a task involves the word
  market, ticket, draft, question, outcome, threshold, resolution source or
  void, assume this applies until you have checked that it does not.
---

# Opening a market on StakeAm

There are 43 numbered rules plus Part 6's six red flags — 49 entries in the
registry. They are not advice — a ticket that fails one of the first
five is a ticket that can trap somebody's money, and a ticket that fails the
commercial ones is a market that sits at 95/5 and settles into an argument.

The important thing to understand before you change anything: **most of these
rules are already code.** `packages/rules` is the single copy, read by all
three creation paths — the AI question engine, the admin wizard, and the
community wizard. Your job is almost never to re-implement a rule. It is to
find the one that already exists, and to make sure your change still runs it.

## Start here, always

```bash
sed -n '1,120p' docs/ticket-creation-checklist.md   # the rules, in prose
grep -n "id:" packages/rules/src/registry.ts        # the rules, as code
```

`packages/rules/src/registry.ts` carries all 49 with an `id`, the `part` they
belong to, an `enforcement` level and the `surface`s they apply to.
`validators.ts` turns a draft into a `RuleReport`. There is a CI gate
(`checklist-sync.test.ts`) asserting the doc and the registry have not drifted
apart — if you add a rule to one, the build tells you about the other.

Read `references/rules.md` for all 49 in a table with their enforcement level
and where they bind. Read it when you need a specific rule; you do not need it
in context to understand what follows.

## The four levels, and why the distinction is the whole design

Every rule carries an `enforcement`:

- **block** — the draft cannot publish. The five non-negotiables, the forbidden
  list, no checkable source.
- **warn** — it can publish, and somebody has to look at it first. Balance,
  duplicate markets, thin liquidity.
- **confirm** — it can publish once a human says out loud that they have
  considered it. This exists for the rules software genuinely cannot judge.
- **monitor** — nothing at publish time; a Part 5 sweep watches the market
  after it opens.
- **practice** — an operating habit with no code behind it at all.

The distinction matters because the commonest way to get this wrong is to make
a judgement call into a `block`. Rule 6 asks for genuine disagreement at 35–65%.
A validator that _refuses_ a market outside that band would refuse a good
market about an event where consensus really is lopsided, and would be trivially
satisfied by a creator typing a different threshold. It warns, and a person
decides. When you are tempted to harden a `warn` into a `block`, ask what a
determined creator does next — if the answer is "types something else", the
block buys nothing and costs a real market.

## The five that must never publish

1. **One named official source**, fixed before opening. The exact body and page.
   Never "widely reported".
2. **An event date and a separate void date.** The void date is the refund
   deadline. A market without one can hold money for ever.
3. **Complete, mutually exclusive outcomes.** Binary truly binary; multi-outcome
   carries an "Any other" so no result falls outside the list.
4. **Edge cases mapped in advance** — postponed, cancelled, abandoned, replayed,
   source publishes nothing, result disputed, methodology changed. Each maps to
   an outcome or to VOID, on the page, before trading opens.
5. **Nobody trading can influence the outcome.**

If you are changing validation and one of these five stops being checked, you
have removed the thing that stands between a trader and a market that cannot be
settled. Say so explicitly rather than letting it pass in a diff.

## Where the rules already bind

| Surface            | File                                                | What it does                                                                                                                                             |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI question engine | `apps/api/src/community/question-engine.service.ts` | Generates official drafts; the prompt is built from the registry (`packages/rules/src/prompt.ts`) so the model is told the rules rather than guessed at. |
| Admin wizard       | `apps/api/src/market/studio.service.ts`             | `reviewDraft` runs the full report; publish runs it again.                                                                                               |
| Community wizard   | `apps/api/src/community/community.service.ts`       | The same rules, stricter — a community creator has a conduct bond at stake.                                                                              |
| Post-publish       | `apps/api/src/market/health.service.ts`             | Part 5's monitoring: split, whale entry, coverage, settlement lateness.                                                                                  |
| Freeze             | `packages/rules/src/freeze.ts`                      | Rule 22 specifically — see the `stakepot-money-safety` skill, because a freeze that fails is a money problem.                                            |

**The review screen must never compute its own verdict.** The wizard calls
`reviewDraft` on every step and the publish endpoint calls it again before
opening anything. A reviewer shown a verdict computed by a different code path
from the one that decides is a reviewer who can be wrong in the reassuring
direction.

## When you are asked to write or judge an actual market question

Run the checklist as a person, not as a validator — the software has already
done the mechanical half.

Rule 25, **the stranger test**, is the one that catches most bad questions:
could somebody with no context settle this correctly using only the page and
the named source? If two reasonable people could settle it differently, it is
not ready, however well it scores on everything else.

Then the specificity rules, which are where real markets go wrong:

- **26 — timezone and hour.** "By 30 September" means nothing. "23:59 WAT,
  30 September 2026" means something.
- **27 — first published figure.** Inflation and GDP get revised. Say that the
  first published figure governs and revisions are ignored, or you have written
  a market that can be re-settled a month later.
- **28 — the exact metric.** Not "inflation" but "year-on-year headline CPI as
  published by NBS". Not "fuel price" but "NNPC retail price in Lagos".
- **29 — currency, unit and rate window.** Which naira rate? Official window,
  closing, or average?

And Part 6's red flags, which are permission to stop:

- Explaining the question twice before a friend understood it → rewrite.
- Cannot name the exact webpage that settles it → do not publish.
- Hoping a particular side wins → conflict; hand it to somebody else.
- The interesting part is _how_ it happens, not _whether_ → wrong question.
- Unsure whether it is on the forbidden list → treat the uncertainty as a no.

## Changing the rules themselves

The doc and the registry are kept in step by a test, so:

1. Edit `docs/ticket-creation-checklist.md`.
2. Edit `packages/rules/src/registry.ts` to match — id, part, enforcement,
   surfaces.
3. Add or extend the validator in `packages/rules/src/validators.ts`.
4. Run `pnpm --filter @stakeam/rules test`. The sync suite fails loudly if the
   two copies disagree.

Never add a rule to only one of them. The reason the registry exists at all is
that three creation paths were drifting apart, and the first symptom of drift
was a market that should never have opened, published by whichever path had the
stale copy.
