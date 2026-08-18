'use client';

import { motion } from 'framer-motion';

/**
 * §2.14a's balance meter, and the wizard's one opinionated moment.
 *
 * §2.9's prime directive is genuine disagreement — "obvious-answer questions
 * are rejected at generation time, because lopsided pools produce negligible
 * fees and dead markets". This is that rule made visible while someone types,
 * rather than a rejection they receive afterwards.
 *
 * The band is drawn, not just described: a creator can see how far outside
 * they are, which is the difference between a rule and a nag.
 */
export function BalanceMeter({
  estimate,
  low,
  high,
}: {
  /** Estimated probability of the leading outcome, 0–1. Null before it is known. */
  estimate: number | null;
  low: number;
  high: number;
}) {
  const inBand = estimate !== null && estimate >= low && estimate <= high;
  const position = estimate === null ? 0.5 : Math.min(1, Math.max(0, estimate));

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">How split is it?</span>
        <span className="font-mono text-sm tabular-nums">
          {estimate === null ? '—' : `${Math.round(estimate * 100)}%`}
        </span>
      </div>

      <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-sm bg-border">
        {/* The band a market has to land in to be worth trading. */}
        <div
          className="absolute inset-y-0 bg-rise/25"
          style={{ left: `${low * 100}%`, width: `${(high - low) * 100}%` }}
        />
        {estimate !== null && (
          <motion.div
            className={`absolute inset-y-0 w-1 rounded-sm ${inBand ? 'bg-rise' : 'bg-fall'}`}
            initial={false}
            animate={{ left: `calc(${position * 100}% - 2px)` }}
            transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          />
        )}
      </div>

      <p className="mt-2 text-sm text-text-muted">
        {estimate === null
          ? 'Fill in the question and outcomes, then check the balance.'
          : inBand
            ? 'Good — people will argue about this one.'
            : 'This one has an obvious answer. Move the threshold or pick a closer call.'}
      </p>
    </div>
  );
}
