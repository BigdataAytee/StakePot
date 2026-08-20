# Skills

Instructions Claude loads on demand. Two kinds live here, and the difference
matters when you edit them.

## Vendored from Anthropic — do not edit

Copied verbatim from [anthropics/skills](https://github.com/anthropics/skills)
at commit `0a64e398ec6bb34a494f0c347e8ccae53a862f8e` (18 Aug 2026), each with
its `LICENSE.txt` alongside as Apache 2.0 §4 requires. **Unmodified.** If one
needs changing, write a project skill that overrides the part you disagree with
rather than editing the copy — a locally patched vendored skill silently
diverges from upstream and nobody can tell which parts are ours.

| Skill             | Licence    | Why it is here                                                                                                                                                                                                   |
| ----------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend-design` | Apache 2.0 | UI quality is this project's known weak spot. Load it before building or reshaping any screen.                                                                                                                   |
| `skill-creator`   | Apache 2.0 | The format the two project skills below are written in, and the tooling to add more.                                                                                                                             |
| `claude-api`      | Apache 2.0 | `apps/api` runs `@anthropic-ai/sdk` in three places — the question engine, the wizard co-pilot and the resolution analyst. Model ids, pricing and tool-use shapes should come from here rather than from memory. |

### Deliberately not vendored

- `docx`, `pdf`, `pptx`, `xlsx` — document generation, nothing to do with this
  product, and **source-available rather than open source**: their licence is
  the Anthropic customer agreement, not Apache 2.0. Copying them into a
  repository is a different act from copying the Apache-licensed ones.
- `brand-guidelines` — applies _Anthropic's_ colours and typography. StakeAm
  has its own design reference (`docs/design-reference.html`) and token system
  (`packages/tokens`); a second brand voice in the same repo is how a product
  ends up looking like two products.
- `webapp-testing` — Python and its own Playwright harness. This repo already
  drives a browser through `apps/web/e2e` in TypeScript, with fixtures, a
  walkthrough and CI wiring. Adding a parallel testing idiom would split the
  practice rather than improve it.
- `mcp-builder` — we consume MCP servers, we do not build them.
- `algorithmic-art`, `canvas-design`, `theme-factory`, `slack-gif-creator`,
  `web-artifacts-builder`, `internal-comms`, `doc-coauthoring`,
  `academy-guide`, `discernment-nudge` — no bearing on a Next.js/NestJS money
  platform.

## Ours

Written in skill-creator's format, and they encode rules this codebase already
enforces in code — so they are a way of _finding_ the enforcement, not a second
copy of it that can drift.

| Skill                   | Load it when                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `stakepot-market-rules` | Anything that creates, drafts, reviews, repeats or publishes a market.              |
| `stakepot-money-safety` | Anything touching balances, the ledger, escrow, settlement, payouts or withdrawals. |

## Updating a vendored skill

```bash
git clone --depth 1 https://github.com/anthropics/skills.git /tmp/anthropic-skills
cp -r /tmp/anthropic-skills/skills/<name> .claude/skills/
```

Then update the commit SHA at the top of this file, so the next person can tell
what they have.
