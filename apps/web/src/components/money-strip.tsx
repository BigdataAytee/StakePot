'use client';

import { LivingNumber } from './living-number';
import { money } from '@/lib/format';

/**
 * §7.2c — the money strip: "pot size, 24h volume, number of traders, fee rate —
 * the market's liquidity health at a glance."
 *
 * The pot is gold because §7.4 reserves gold for money and nothing else. The
 * rest stay in text colours: they are counts and rates, not money.
 */
export function MoneyStrip({
  pot,
  volume24h,
  traders,
  feeBps,
}: {
  pot: string;
  volume24h: string;
  traders: number;
  feeBps: number;
}) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
      <Cell label="Pot">
        <span className="text-money">{money(pot)}</span>
      </Cell>
      <Cell label="24h volume">{money(volume24h)}</Cell>
      <Cell label="Traders">
        <LivingNumber value={traders} />
      </Cell>
      <Cell label="Fee">
        <span className="font-mono tabular-nums">{(feeBps / 100).toFixed(1)}%</span>
      </Cell>
    </dl>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-raised px-4 py-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-md tabular-nums">{children}</dd>
    </div>
  );
}
