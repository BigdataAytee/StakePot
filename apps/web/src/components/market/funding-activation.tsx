'use client';

import { useEffect, useState } from 'react';

import type { MarketDetail, SeedComposition } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { usePublicConfig } from '@/lib/public-config';

/**
 * §7.2e — what a market looks like before it is a market.
 *
 * "In FUNDING state the chart area is replaced by the activation view:
 * both-side progress meters (amount + backers), countdown, seed/syndicate
 * composition, share-to-fill buttons."
 *
 * This replaces the chart rather than sitting under it, which is the part that
 * matters. A funding market has no price history worth reading — its whole
 * story is whether it will make the threshold before the window shuts, and
 * that is the only question anyone visiting it has. Until now the page showed
 * an empty chart and said nothing about the deadline it was racing.
 *
 * The thresholds are read from config, not hardcoded: §6.4b makes them a
 * four-eyes proposal, and a meter with a baked-in target would quietly start
 * lying the day one is changed.
 */
export function FundingActivation({
  market,
  composition,
}: {
  market: MarketDetail;
  composition: SeedComposition | null;
}) {
  const config = usePublicConfig();
  const left = useCountdown(market.fundingClosesAt);

  const target = Number.parseFloat(config?.activationPoolSpc ?? '0');
  const backersNeeded = config?.activationBackers ?? 0;
  // §2.9's amendment: wide fields activate on the total pot with at least two
  // funded outcomes, because a strict per-outcome floor voids well-balanced
  // multi-outcome markets on their tail.
  const byTotal = config?.activationMode === 'total_pot' || market.outcomes.length > 2;

  const staked = market.outcomes.map((outcome) => Number.parseFloat(outcome.staked));
  const total = staked.reduce((sum, value) => sum + value, 0);
  const funded = staked.filter((value) => value > 0).length;

  return (
    <section className="rounded-xl border border-border p-4">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-md font-bold">Still gathering backers</h2>
        {left !== null && (
          <span className="text-sm text-text-muted">
            <span className="font-semibold text-text">{left}</span> left
          </span>
        )}
      </header>

      <p className="mt-1 text-sm text-text-muted">
        {byTotal ? (
          <>
            This market opens when the pot reaches {money(target)} across at least two outcomes,
            with {backersNeeded} or more backers. If it doesn&rsquo;t, every stake is refunded in
            full — no fees.
          </>
        ) : (
          <>
            Both sides need {money(target)} from {backersNeeded} or more backers before{' '}
            {market.fundingClosesAt === null
              ? 'the window shuts'
              : dateTime(market.fundingClosesAt)}
            . If either falls short, every stake is refunded in full — no fees.
          </>
        )}
      </p>

      {/* The meters. On the total-pot rule there is one; on the per-side rule
          there is one per outcome, because either can be the one that fails. */}
      <div className="mt-4 flex flex-col gap-3">
        {byTotal ? (
          <Meter label="Pot" value={total} target={target} />
        ) : (
          market.outcomes.map((outcome, index) => (
            <Meter
              key={outcome.id}
              label={outcome.label}
              value={staked[index] ?? 0}
              target={target}
            />
          ))
        )}

        <Meter label="Backers" value={market.traderCount} target={backersNeeded} unit="people" />

        {byTotal && (
          <p className="text-sm text-text-muted">
            <span className="font-semibold text-text">{funded}</span> of {market.outcomes.length}{' '}
            outcomes funded — needs at least 2.
          </p>
        )}
      </div>

      {composition !== null && composition.seeded.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-[.05em] text-text-muted">Seed</h3>
          <p className="mt-1 text-sm text-text-muted">
            {composition.seeded.length}{' '}
            {composition.seeded.length === 1 ? 'sponsor has' : 'sponsors have'} put in{' '}
            <span className="font-mono text-text">
              {money(
                composition.seeded.reduce((sum, row) => sum + Number.parseFloat(row.amount), 0),
              )}
            </span>
            , split equally across every outcome — a seed can never hold a side.
          </p>
        </div>
      )}

      <ShareToFill question={market.question} />
    </section>
  );
}

function Meter({
  label,
  value,
  target,
  unit,
}: {
  label: string;
  value: number;
  target: number;
  unit?: string;
}) {
  const done = target <= 0 ? 1 : Math.min(1, value / target);
  const full = done >= 1;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="font-mono tabular-nums text-text-muted">
          {unit === undefined ? money(value) : `${value} ${unit}`}
          <span className="opacity-60">
            {' / '}
            {unit === undefined ? money(target) : target}
          </span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-chip">
        <div
          className={`h-full rounded-full transition-[width] duration-tick ${full ? 'bg-rise' : 'bg-brand'}`}
          style={{ width: `${Math.round(done * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** §7.2e's share-to-fill: the creator's one lever while the clock runs. */
function ShareToFill({ question }: { question: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = typeof window === 'undefined' ? '' : window.location.href;
    const text = `${question} — needs backers before it opens. ${url}`;

    // The share sheet where there is one (every phone this is built for), the
    // clipboard where there is not. Held in a local so narrowing `share` off
    // the global does not also narrow `clipboard` away.
    const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
    if (nav === undefined) return;

    if (typeof nav.share === 'function') {
      await nav.share({ text }).catch(() => undefined);
      return;
    }
    await nav.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      className="mt-4 w-full rounded-lg bg-brand py-3 text-md font-bold text-paper transition-transform active:scale-press"
    >
      {copied ? 'Copied — go fill it' : 'Share it to fill it'}
    </button>
  );
}

/** "2d 4h" — how long is left, not when it ends. */
function useCountdown(iso: string | null): string | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (iso === null || now === null) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
