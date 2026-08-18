'use client';

import { motion } from 'framer-motion';

import { percent } from '@/lib/format';

export interface BarSegment {
  id: string;
  label: string;
  price: string;
}

/**
 * §7.4's first signature element, and the brand: the argument bar.
 *
 * "The green/red split that physically shifts with every trade, eased with
 * cubic-bezier(.2,.8,.2,1). It appears everywhere a market does: full-width in
 * ticket view, miniature on cards, tiny in share images."
 *
 * Binary markets get the green/red split. Multi-outcome markets stack 100%
 * bars, so the same object answers "who is winning the argument" either way.
 */
export function ArgumentBar({
  segments,
  size = 'full',
}: {
  segments: BarSegment[];
  size?: 'full' | 'mini';
}) {
  const binary = segments.length === 2;
  const height = size === 'full' ? 'h-3' : 'h-1.5';
  const ease = [0.2, 0.8, 0.2, 1] as const;

  // Multi-outcome shades step down from green through muted so the leader still
  // reads instantly without inventing colours the palette does not have.
  const colourFor = (index: number): string => {
    if (binary) return index === 0 ? 'bg-rise' : 'bg-fall';
    const ramp = ['bg-rise', 'bg-rise-deep', 'bg-money', 'bg-fall', 'bg-text-muted'];
    return ramp[index % ramp.length] ?? 'bg-text-muted';
  };

  return (
    <div>
      <div
        className={`flex ${height} w-full overflow-hidden rounded-sm bg-border`}
        role="img"
        aria-label={segments
          .map((s) => `${s.label} ${Math.round(percent(s.price))} percent`)
          .join(', ')}
      >
        {segments.map((segment, index) => (
          <motion.div
            key={segment.id}
            className={colourFor(index)}
            initial={false}
            animate={{ width: `${percent(segment.price)}%` }}
            transition={{ duration: 0.25, ease }}
          />
        ))}
      </div>

      {size === 'full' && (
        <div className="mt-2 flex justify-between text-sm">
          {segments.map((segment, index) => (
            <span key={segment.id} className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-sm ${colourFor(index)}`} />
              <span className="text-text-muted">{segment.label}</span>
              <span className="font-mono tabular-nums">{Math.round(percent(segment.price))}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
