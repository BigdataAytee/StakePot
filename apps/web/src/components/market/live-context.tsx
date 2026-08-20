'use client';

import { useEffect, useState } from 'react';

import { palette } from '@stakeam/tokens';

import type { MarketContext, MarketDetail } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { elapsed } from '@/lib/liveness';

/**
 * The reality the market is about, streaming underneath the price.
 *
 * A prediction market is two things moving at once: what traders think, and
 * what is actually happening. The chart is the first. Without the second, a
 * ticket on a naira market is a probability with nothing to be a probability
 * *of* — and the reader has to leave to find out whether the rate is anywhere
 * near the line.
 *
 * Everything here is context, and it is labelled as context. Every figure
 * carries who published it and when, in the same breath as the number, because
 * the one failure this strip could cause is somebody reading an official
 * figure as a price or a stale figure as a fresh one. Nothing on this strip is
 * inferred, smoothed, or filled in: if the pipeline has not read something,
 * the row is absent rather than empty.
 */
export function LiveContext({
  market,
  context,
}: {
  market: MarketDetail;
  /** Null while the first fetch is in flight; refetched on its own cadence. */
  context: MarketContext | null;
}) {
  const watch = context?.sourceWatch;
  const headline = [...(context?.news ?? [])].sort((left, right) =>
    right.publishedAt.localeCompare(left.publishedAt),
  )[0];

  const hasFigure = watch?.latest != null;
  const hasThreshold = watch?.threshold != null;
  // Nothing read, nothing published, no line to draw. A strip that renders as
  // a row of dashes is worse than one that is not there: it says the pipeline
  // is watching this market when it is not.
  if (!hasFigure && !hasThreshold && headline === undefined) return null;

  return (
    <section
      aria-label="What is happening"
      className="mt-3 overflow-hidden rounded-xl border border-border bg-surface-raised"
    >
      <header className="flex items-baseline gap-2 border-b border-border px-3.5 py-2">
        <h2 className="text-fine font-semibold uppercase tracking-[.05em] text-text-muted">
          On the ground
        </h2>
        {/* Said once, at the top of the strip, so no row below has to carry a
            disclaimer of its own. */}
        <p className="text-fine text-text-muted">Context, not the price</p>
      </header>

      <div className="divide-y divide-border">
        {(hasFigure || hasThreshold) && <Reading market={market} watch={watch} />}

        {/*
          The remaining time, with the date behind it rather than in front.

          The quote strip above already prints the settlement date, so
          repeating it as the headline of this row would be the same fact
          twice. What this row adds is the part that moves — and inside the
          last hour, that is the only number on the screen that matters.
        */}
        <Row label="Settles">
          <Until at={market.eventDate} />
          <span className="font-mono text-fine text-text-muted">{dateTime(market.eventDate)}</span>
        </Row>

        {headline !== undefined && (
          <Row label="Latest">
            <a
              href={headline.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline decoration-border underline-offset-2 hover:decoration-text"
            >
              {headline.headline}
            </a>
            {/* Outlet and time, every time. An unattributed line on a money
                screen is a rumour with good typography. */}
            <span className="whitespace-nowrap text-fine text-text-muted">
              {headline.outlet} · {ago(headline.publishedAt)}
            </span>
          </Row>
        )}
      </div>
    </section>
  );
}

/**
 * The published figure against the market's own line.
 *
 * Two numbers and, where there is a series, the shape of one approaching the
 * other. This is the only chart in the app whose axis is not probability, so
 * it is deliberately small, deliberately separate from the price chart, and
 * deliberately labelled with its units — putting a naira rate on the price
 * chart's percentage scale would be a number in the place a reader's eye
 * expects a price.
 */
function Reading({
  market,
  watch,
}: {
  market: MarketDetail;
  watch: MarketContext['sourceWatch'] | undefined;
}) {
  if (watch === undefined) return null;
  const threshold = watch.threshold;

  return (
    <Row label={watch.sourceName || market.sourceName}>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {watch.latest !== null && (
          <span className="flex items-baseline gap-1.5">
            <span className="text-fine text-text-muted">latest</span>
            <b className="font-mono tabular-nums">{watch.latest}</b>
          </span>
        )}
        {threshold !== null && (
          <span className="flex items-baseline gap-1.5">
            <span className="text-fine text-text-muted">settles {threshold.direction}</span>
            <b className="font-mono tabular-nums">{threshold.label}</b>
          </span>
        )}
        {/*
          Which side of the line the published figure is on — the fact both
          numbers exist to produce, said in a word so nobody has to do the
          comparison in their head on a screen they are about to spend money
          from. Null whenever either half is missing, which is most markets.
        */}
        {watch.meetsThreshold !== null && (
          <span
            className={`rounded-sm px-1.5 py-0.5 font-mono text-fine font-bold ${
              watch.meetsThreshold ? 'bg-rise/15 text-rise' : 'bg-fall/15 text-fall'
            }`}
          >
            {watch.meetsThreshold ? 'above the line today' : 'short of the line today'}
          </span>
        )}
      </span>

      <span className="flex items-center gap-2">
        <UnderlyingTrack series={watch.series} threshold={threshold?.value ?? null} />
        {watch.checkedAt !== null && (
          <span className="whitespace-nowrap text-fine text-text-muted">
            published {ago(watch.checkedAt)}
          </span>
        )}
      </span>
    </Row>
  );
}

/**
 * The underlying value against the target line.
 *
 * Two points minimum. A single reading is a reading, and drawing a line
 * through it would be inventing a trend out of one observation — the strip
 * already prints that number beside the threshold, which is the whole of what
 * is known.
 *
 * The vertical scale includes the threshold whether or not the readings reach
 * it: a track scaled to the data alone would put the line off the top of a
 * 60px box on exactly the markets where the distance to it is the story.
 */
function UnderlyingTrack({
  series,
  threshold,
}: {
  series: { value: number; at: string; outlet: string }[];
  threshold: number | null;
}) {
  if (series.length < 2) return null;

  const width = 84;
  const height = 26;
  const values = series.map((point) => point.value);
  const bounds = threshold === null ? values : [...values, threshold];
  const min = Math.min(...bounds);
  const span = Math.max(...bounds) - min || 1;
  const y = (value: number): number => height - ((value - min) / span) * (height - 4) - 2;

  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y(value).toFixed(1)}`;
    })
    .join(' ');

  const first = series[0];
  const last = series[series.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      role="img"
      aria-label={
        first === undefined || last === undefined
          ? 'Published readings'
          : `Published readings from ${first.value} on ${dateTime(first.at)} to ${last.value} on ${dateTime(last.at)}${
              threshold === null ? '' : `, against a threshold of ${threshold}`
            }`
      }
    >
      {threshold !== null && (
        <line
          x1={0}
          x2={width}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="currentColor"
          className="text-text-muted"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <path
        d={path}
        fill="none"
        stroke={palette.blue}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-note">
      <span className="w-full shrink-0 text-fine uppercase tracking-[.05em] text-text-muted sm:w-28">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        {children}
      </span>
    </div>
  );
}

/**
 * How long until the event, counting down.
 *
 * Its own clock, and null until mounted — the server has no business rendering
 * a duration it computed when the page was built. Ticks every second inside
 * the last hour and every half minute before that, which is the same cadence
 * the freeze countdown uses and for the same reason: a second hand matters
 * when the seconds do.
 */
function Until({ at }: { at: string }) {
  const [now, setNow] = useState<number | null>(null);
  const target = new Date(at).getTime();

  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    tick();
    const fast = target - Date.now() < 3_600_000;
    const timer = window.setInterval(tick, fast ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (now === null) return null;
  const remaining = target - now;
  if (remaining <= 0) {
    return <b className="text-text-muted">the event has started</b>;
  }

  return <b className="whitespace-nowrap font-mono tabular-nums">in {elapsed(remaining)}</b>;
}
