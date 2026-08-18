'use client';

import { outcomeColour } from '@stakeam/tokens';

import type { OutcomeView } from '@/lib/api';
import { kobo, percent } from '@/lib/format';

/**
 * §7.2d: "Outcome rows carry priced buttons... the button *is* the live price,
 * updating in place as the market moves."
 *
 * Binary keeps the side-by-side green/red pair, so the colour means the same
 * thing as the argument bar directly above it. A candidate list is a different
 * reading problem: a voter scanning eight names wants rank first and price
 * second, so rows stack, sort by price, and carry a proportional fill — the
 * argument bar's shape, one row at a time.
 */
export function OutcomeButtons({
  outcomes,
  livePrices,
  disabled,
  onPick,
}: {
  outcomes: OutcomeView[];
  livePrices: Record<string, string>;
  disabled: boolean;
  onPick: (outcome: OutcomeView) => void;
}) {
  const priceOf = (outcome: OutcomeView): string => livePrices[outcome.id] ?? outcome.price;

  if (outcomes.length === 2) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {outcomes.map((outcome, index) => (
          <button
            key={outcome.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(outcome)}
            className={`flex items-center justify-between gap-3 rounded-md border px-4 py-3.5 font-bold transition-all active:scale-press disabled:opacity-40 disabled:hover:bg-transparent ${
              index === 0
                ? 'border-rise text-rise hover:bg-rise hover:text-paper'
                : 'border-fall text-fall hover:bg-fall hover:text-paper'
            }`}
          >
            <span>Buy {outcome.label}</span>
            <span className="font-mono tabular-nums">{kobo(priceOf(outcome))}</span>
          </button>
        ))}
      </div>
    );
  }

  // "Any other" is the catch-all (§2.5) and always sits last, whatever it is
  // trading at — it is the bucket, not a candidate, and ranking it among them
  // would misread the field.
  const ranked = [...outcomes].sort((a, b) => {
    if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
    return percent(priceOf(b)) - percent(priceOf(a));
  });

  return (
    <ul className="space-y-2">
      {ranked.map((outcome) => {
        const price = priceOf(outcome);
        const share = percent(price);
        const colour = outcomeColour(outcome.ordinal, outcome.isOther);

        return (
          <li key={outcome.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(outcome)}
              className="relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-md border border-border px-4 py-3 text-left transition-all hover:border-rise active:scale-press disabled:opacity-40"
            >
              {/* The row's own share of the argument, filled behind the label. */}
              <span
                className="absolute inset-y-0 left-0 opacity-[0.14] transition-[width] duration-tick ease-bar"
                style={{ width: `${share}%`, backgroundColor: colour }}
                aria-hidden
              />
              <span className="relative flex items-center gap-2 font-bold">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: colour }}
                />
                {outcome.label}
              </span>
              <span className="relative font-mono tabular-nums">{kobo(price)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
