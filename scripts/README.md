# scripts

## Reference simulations

`pricing_sim.py` and `ai_backtest.py` are the reference originals, kept unchanged
— §2.3 asks for the simulation to live in the repo as a regression test, and
these are what the TypeScript is checked _against_, not a second implementation
to maintain. Do not edit them to match the TS; if they disagree, one of them is
wrong and that is the finding.

`pricing_sim.py` is ported in
[`packages/engine/src/__tests__/pricing-sim.test.ts`](../packages/engine/src/__tests__/pricing-sim.test.ts).
Its multi-trader runs use a numpy PRNG that cannot be reproduced in TypeScript,
so the port covers the deterministic scenarios exactly (SIM 3's whale stress
case) and asserts the claims the simulation makes about the rest: platform cost
of exactly zero, a pot that never goes negative, an exact round trip.

`ai_backtest.py` is ported when step 6 brings in `@anthropic-ai/sdk` for the
§2.9 question engine.

## Load testing

`load/smoke.js` is a k6 script; `pnpm test:load` runs it. k6 is installed at the
system level rather than through npm — see the script header.
