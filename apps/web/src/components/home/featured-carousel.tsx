'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { Annotation, MarketDetail } from '@/lib/api';
import { dateTime, kobo, money, percent } from '@/lib/format';
import { binaryPair, topicOf } from '@/lib/home';
import { MarketTile } from './market-tile';

const DWELL_MS = 9000;

/**
 * The front page's headline act: a handful of markets, one at a time, full size.
 *
 * A grid of cards answers "what is here". It does not answer "why should I
 * care", because every card is the same size and nothing on the page is
 * arguing. This is the argument — one market, its outcomes at the size of a
 * decision, its recent history scrolling beside them, and its chart.
 *
 * Every slide stays mounted so a screen reader and the browser's own find can
 * reach all of them, but the ones that are off-stage are `inert` and hidden
 * from assistive tech, so tab order never wanders into a slide nobody is
 * looking at.
 *
 * The rotation stops on hover and on focus, and it stops permanently the first
 * time somebody uses the controls: a page that keeps moving the thing you are
 * reading is a page you cannot read.
 */
export function FeaturedCarousel({ markets }: { markets: MarketDetail[] }) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [taken, setTaken] = useState(false);

  const count = markets.length;
  const go = useCallback(
    (next: number) => {
      setTaken(true);
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (count < 2 || held || taken) return undefined;
    const timer = setInterval(() => setIndex((current) => (current + 1) % count), DWELL_MS);
    return () => clearInterval(timer);
  }, [count, held, taken]);

  if (count === 0) return null;
  const current = markets[index] as MarketDetail;

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured markets"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <div className="relative overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lifted">
        {/*
          One track, translated. Height comes from the tallest slide rather
          than from a fixed value, so a two-outcome market and a six-outcome
          one both fit and neither leaves a hole.
        */}
        <div
          className="flex transition-transform duration-500 ease-bar"
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {markets.map((market, position) => (
            <div
              key={market.id}
              className="w-full shrink-0"
              // `inert` is what keeps the off-stage slides out of tab order
              // while leaving them in the document for find-in-page.
              inert={position !== index}
              aria-hidden={position === index ? undefined : true}
            >
              <Slide market={market} />
            </div>
          ))}
        </div>
      </div>

      {count > 1 && (
        <div className="mt-3 flex items-center gap-3">
          <NudgeButton
            direction="previous"
            market={markets[(index - 1 + count) % count] as MarketDetail}
            onClick={() => go(index - 1)}
          />

          <div className="flex flex-1 items-center justify-center gap-1.5">
            {markets.map((market, position) => (
              <button
                key={market.id}
                type="button"
                onClick={() => go(position)}
                aria-label={`Show ${market.question}`}
                aria-current={position === index ? 'true' : undefined}
                className={`rounded-full transition-all ${
                  position === index
                    ? 'h-1.5 w-8 bg-rise'
                    : 'size-1.5 bg-border hover:bg-text-muted'
                }`}
              />
            ))}
          </div>

          <NudgeButton
            direction="next"
            market={markets[(index + 1) % count] as MarketDetail}
            onClick={() => go(index + 1)}
          />
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        Showing {index + 1} of {count}: {current.question}
      </p>
    </section>
  );
}

/** One featured market, laid out as a decision rather than as a card. */
function Slide({ market }: { market: MarketDetail }) {
  // Yes/No keeps its own order so green stays Yes; everything else is ranked.
  const binary = binaryPair(market);
  const rows =
    binary ??
    [...market.outcomes].sort((left, right) => {
      if (left.isOther !== right.isOther) return left.isOther ? 1 : -1;
      return Number.parseFloat(right.price) - Number.parseFloat(left.price);
    });
  const topic = topicOf(market);
  const tradeable = market.state === 'active';

  return (
    <article className="relative isolate flex flex-col gap-5 p-4 sm:p-5 lg:flex-row lg:gap-8 lg:p-6">
      <div className="flex flex-col lg:w-[42%]">
        <header className="flex items-start gap-3">
          <MarketTile
            id={market.id}
            question={market.question}
            size={56}
            className="hidden rounded-md sm:grid"
          />
          <div className="min-w-0">
            <h2 className="text-lg font-black leading-tight sm:text-xl">
              <Link
                href={`/market/${market.id}`}
                className="after:absolute after:inset-0 after:content-['']"
              >
                {market.question}
              </Link>
            </h2>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
              <span className="relative z-10 rounded-sm bg-text/5 px-1.5 py-0.5">
                {topic.label}
              </span>
              <span aria-hidden>·</span>
              <span>{market.shelf === 'official' ? 'Official' : 'Community'}</span>
              <span aria-hidden>·</span>
              <span>
                {market.traderCount} {market.traderCount === 1 ? 'trader' : 'traders'}
              </span>
            </p>
          </div>
        </header>

        <ul className="mt-5 flex flex-col">
          {rows.slice(0, 4).map((outcome, position) => {
            // On a Yes/No market the second row is the No, and it wears the
            // red — the same pair the ticket and the argument bar use.
            const down = binary !== null && position === 1;
            return (
              <li
                key={outcome.id}
                className="flex min-h-11 items-center gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span className="flex-1 truncate text-sm font-medium">{outcome.label}</span>
                <span className="font-mono text-lg font-black tabular-nums">
                  {Math.round(percent(outcome.price))}%
                </span>
                {tradeable && (
                  <Link
                    href={`/market/${market.id}`}
                    aria-label={`Back ${outcome.label} on ${market.question} at ${kobo(outcome.price)}`}
                    className={`group/side relative z-10 grid h-8 w-16 place-items-center rounded-sm text-xs font-black transition-colors ${
                      down
                        ? 'bg-fall/15 text-fall hover:bg-fall hover:text-paper'
                        : 'bg-rise/15 text-rise hover:bg-rise hover:text-paper'
                    }`}
                  >
                    <span className="transition-opacity group-hover/side:opacity-0">
                      {binary === null ? 'Back' : outcome.label}
                    </span>
                    <span className="absolute font-mono tabular-nums opacity-0 transition-opacity group-hover/side:opacity-100">
                      {kobo(outcome.price)}
                    </span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>

        <ActivityColumn annotations={market.annotations} />
      </div>

      <div className="flex flex-1 flex-col">
        <SlideChart points={market.sparkline ?? []} />
        <footer className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4 text-xs text-text-muted">
          <span className="font-mono tabular-nums">
            <span className="text-money">{money(market.pot)}</span> pot
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono tabular-nums">{money(market.volume24h)} in 24h</span>
          <span className="ml-auto">Closes {dateTime(market.eventDate)}</span>
        </footer>
      </div>
    </article>
  );
}

/**
 * What has happened on this market lately, scrolling.
 *
 * These are the market's own annotations — the ones the ticket's chart hangs
 * its flags on: it opened, it activated, somebody took a big position, a
 * source published. Nothing here is invented for the front page; if a market
 * has no history yet the column is simply absent, which is the honest thing
 * for a market where nothing has happened.
 */
function ActivityColumn({ annotations }: { annotations: Annotation[] }) {
  const recent = annotations.slice(-6);
  if (recent.length < 3) return null;

  return (
    <div
      className="relative mt-4 h-[104px] overflow-hidden"
      style={{
        maskImage:
          'linear-gradient(to bottom, transparent 0, black 24px, black 72px, transparent 100%)',
        WebkitMaskImage:
          'linear-gradient(to bottom, transparent 0, black 24px, black 72px, transparent 100%)',
      }}
    >
      {/* Rendered twice so the loop has no seam. The copy is hidden from
          assistive tech — one reading of the same six lines is enough. */}
      <ul className="animate-marquee-y [animation-play-state:running] hover:[animation-play-state:paused]">
        {[0, 1].map((pass) => (
          <li key={pass} aria-hidden={pass === 1 ? true : undefined}>
            <ul>
              {recent.map((annotation) => (
                <li
                  key={`${pass}-${annotation.id}`}
                  className="flex items-baseline gap-2 py-1.5 text-xs"
                >
                  <span
                    className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${dotFor(annotation.type)}`}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-text-muted">{annotation.label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-muted opacity-70">
                    {ago(annotation.ts)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function dotFor(type: Annotation['type']): string {
  switch (type) {
    case 'big_trade':
      return 'bg-money';
    case 'resolution':
      return 'bg-rise';
    case 'freeze':
      return 'bg-fall';
    default:
      return 'bg-border';
  }
}

/** "4h", "2d" — a length, not a timestamp, because the column is glanced at. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The slide's chart — the same 24h series the cards carry as a sparkline, at
 * the size where its shape means something.
 */
function SlideChart({ points }: { points: string[] }) {
  if (points.length < 2) {
    return (
      <div className="grid h-40 place-items-center rounded-md border border-dashed border-border text-xs text-text-muted lg:h-56">
        No price history yet — this market is still finding its level.
      </div>
    );
  }

  const width = 600;
  const height = 200;
  const values = points.map((point) => Number.parseFloat(point) * 100);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const rising = (values[values.length - 1] as number) >= (values[0] as number);

  const coords = values.map((value, position) => {
    const x = (position / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${coords.join(' L')}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Price over the last day, ${Math.round(values[0] as number)}% to ${Math.round(
        values[values.length - 1] as number,
      )}%`}
      className="h-40 w-full lg:h-56"
    >
      <defs>
        <linearGradient id="slide-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className={rising ? 'text-rise' : 'text-fall'}>
        <path d={`${line} L${width},${height} L0,${height} Z`} fill="url(#slide-chart-fill)" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** The prev/next control, which names where it goes rather than pointing. */
function NudgeButton({
  direction,
  market,
  onClick,
}: {
  direction: 'previous' | 'next';
  market: MarketDetail;
  onClick: () => void;
}) {
  const short = market.question.length > 34 ? `${market.question.slice(0, 33)}…` : market.question;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${direction === 'previous' ? 'Previous' : 'Next'} market: ${market.question}`}
      className="flex h-9 max-w-[42%] shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-bold text-text-muted transition-colors hover:border-rise hover:text-text"
    >
      {direction === 'previous' && <Arrow className="size-3 rotate-180" />}
      <span className="hidden truncate sm:block">{short}</span>
      {direction === 'next' && <Arrow className="size-3" />}
    </button>
  );
}

function Arrow({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="m6 3 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
