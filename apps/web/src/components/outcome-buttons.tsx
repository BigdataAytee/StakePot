'use client';

import type { OutcomeView } from '@/lib/api';
import { kobo } from '@/lib/format';

/**
 * §7.2d: "Outcome rows carry priced buttons... the button *is* the live price,
 * updating in place as the market moves."
 *
 * Binary markets get the green/red pair the argument bar uses, so the colour
 * means the same thing everywhere on the page.
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
  const binary = outcomes.length === 2;

  return (
    <div className={`grid gap-2 ${binary ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {outcomes.map((outcome, index) => {
        const price = livePrices[outcome.id] ?? outcome.price;
        const tone = binary
          ? index === 0
            ? 'border-rise text-rise hover:bg-rise hover:text-paper'
            : 'border-fall text-fall hover:bg-fall hover:text-paper'
          : 'border-border hover:border-rise';

        return (
          <button
            key={outcome.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(outcome)}
            className={`flex items-center justify-between gap-3 rounded-md border px-4 py-3.5 font-bold transition-all active:scale-press disabled:opacity-40 disabled:hover:bg-transparent ${tone}`}
          >
            <span>Buy {outcome.label}</span>
            <span className="font-mono tabular-nums">{kobo(price)}</span>
          </button>
        );
      })}
    </div>
  );
}
