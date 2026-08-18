'use client';

import { motion } from 'framer-motion';

import { outcomeColour } from '@stakeam/tokens';

import { percent } from '@/lib/format';

export interface BarSegment {
  id: string;
  label: string;
  price: string;
  ordinal: number;
  isOther: boolean;
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
  showLabels = true,
}: {
  segments: BarSegment[];
  size?: 'full' | 'mini';
  /**
   * Off when something above already names and prices the outcomes — on a
   * multi-outcome ticket the chart legend does, and repeating it forty pixels
   * later is noise, not reinforcement.
   */
  showLabels?: boolean;
}) {
  const binary = segments.length === 2;
  const height = size === 'full' ? 'h-3' : 'h-1.5';
  const ease = [0.2, 0.8, 0.2, 1] as const;

  // One shared ramp for the bar, the chart legend and the outcome rows, so a
  // candidate is the same colour everywhere on the page. Binary markets keep
  // the semantic rise/fall pair, which flips with the theme.
  const colourFor = (index: number): string => {
    const segment = segments[index];
    return segment === undefined
      ? outcomeColour(index)
      : outcomeColour(segment.ordinal, segment.isOther);
  };
  const classFor = (index: number): string => (binary ? (index === 0 ? 'bg-rise' : 'bg-fall') : '');
  // Binary markets take their colour from the theme-aware rise/fall tokens; the
  // ramp is only for markets the semantic pair cannot describe.
  const styleFor = (index: number) => (binary ? {} : { backgroundColor: colourFor(index) });

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
            className={classFor(index)}
            style={styleFor(index)}
            initial={false}
            animate={{ width: `${percent(segment.price)}%` }}
            transition={{ duration: 0.25, ease }}
          />
        ))}
      </div>

      {size === 'full' && showLabels && (
        <div className="mt-2 flex justify-between text-sm">
          {segments.map((segment, index) => (
            <span key={segment.id} className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-sm ${classFor(index)}`}
                style={styleFor(index)}
              />
              <span className="text-text-muted">{segment.label}</span>
              <span className="font-mono tabular-nums">{Math.round(percent(segment.price))}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
