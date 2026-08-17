# scripts

## Reference simulations (pending)

`pricing_sim.py` and `ai_backtest.py` belong here as the reference originals.
They were not in the repository when Phase 0 was scaffolded — drop them in
unchanged, and keep them unchanged: they are the thing the TypeScript is checked
against, not a second implementation to maintain.

The port lands as tests, not as a rewrite:

- `pricing_sim.py` → cases in `packages/engine/src/__tests__/`, asserting the TS
  engine reproduces the Python's numbers for the same inputs. The fast-check
  suite already proves the invariants hold; this proves the two implementations
  agree on specific values.
- `ai_backtest.py` → a scored fixture run for the §2.9 question engine, once
  step 6 brings in `@anthropic-ai/sdk`.

## Load testing

`load/smoke.js` is a k6 script; `pnpm test:load` runs it. k6 is installed at the
system level rather than through npm — see the script header.
