import Link from 'next/link';

import type { MarketSummary, OutcomeView } from '@/lib/api';
import { STATE_LABEL, kobo, money, percent, untilFreeze } from '@/lib/format';
import { binaryPair, topicOf } from '@/lib/home';
import { MarketTile } from './market-tile';

/**
 * One market, as it appears in the front-page grid.
 *
 * The card is dense on purpose: at four columns a reader is scanning forty
 * questions, and what they need from each is the question, where the crowd
 * currently stands, and a way in — in that order and in one glance. Everything
 * else (the source, the criteria, the chart, the thread) lives one tap away on
 * the ticket, which is what the whole card links to.
 *
 * Two body shapes, because two kinds of question read differently:
 *
 *   Yes/No     a single number is the whole story, so it gets the gauge and
 *              two full-width buttons.
 *   Multi      no single number tells it, so the top outcomes are listed with
 *              their own prices and their own way in.
 *
 * The card is an `<article>` rather than a giant `<a>`: a link cannot legally
 * contain the outcome buttons, and a div with an onClick is not a link at all.
 * The question's link stretches over the card with `after:inset-0`, and the
 * buttons sit above it on `z-10` — so the whole card is clickable, the buttons
 * still work, and the keyboard gets exactly one tab stop per destination.
 */
export function HomeMarketCard({ market }: { market: MarketSummary }) {
  const tradeable = market.state === 'active';
  // Yes/No keeps its own order; everything else is ranked. See `binaryPair`.
  const binary = binaryPair(market);
  const ranked = [...market.outcomes].sort((left, right) => {
    if (left.isOther !== right.isOther) return left.isOther ? 1 : -1;
    return Number.parseFloat(right.price) - Number.parseFloat(left.price);
  });
  const topic = topicOf(market);

  return (
    <article className="group relative isolate flex min-h-[184px] flex-col rounded-lg border border-border bg-surface-raised pt-3 shadow-soft transition-all duration-150 hover:-translate-y-px hover:border-rise/40 hover:shadow-lifted">
      <div className="flex items-start gap-2.5 px-3">
        <MarketTile id={market.id} question={market.question} size={38} />

        <h3 className="line-clamp-3 flex-1 text-sm font-bold leading-snug">
          <Link
            href={`/market/${market.id}`}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-rise"
          >
            {market.question}
          </Link>
        </h3>

        {/* The gauge reads the Yes side, because "62% chance" of a question
            means the chance it happens — not the chance of whichever side is
            currently ahead. */}
        {binary !== null && <Gauge value={percent(binary[0].price)} />}
      </div>

      <div className="mt-3 flex-1 px-3">
        {!tradeable ? (
          <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
            {STATE_LABEL[market.state] ?? market.state}
          </p>
        ) : binary !== null ? (
          <div className="flex gap-1.5">
            <SideButton market={market} outcome={binary[0]} tone="rise" />
            <SideButton market={market} outcome={binary[1]} tone="fall" />
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ranked.slice(0, 3).map((outcome) => (
              <OutcomeRow key={outcome.id} market={market} outcome={outcome} />
            ))}
            {ranked.length > 3 && (
              <li className="pl-0.5 text-xs text-text-muted">
                +{ranked.length - 3} more {ranked.length - 3 === 1 ? 'side' : 'sides'}
              </li>
            )}
          </ul>
        )}
      </div>

      <footer className="mt-3 flex items-center gap-2 px-3 pb-2.5 text-xs text-text-muted">
        <span className="font-mono tabular-nums">
          <span className="text-money">{money(market.pot)}</span> pot
        </span>
        {tradeable && (
          <>
            <span aria-hidden>·</span>
            <span className="font-mono tabular-nums">{untilFreeze(market.eventDate)}</span>
          </>
        )}
        <Link
          href={`/?topic=${topic.key}`}
          className="relative z-10 ml-auto rounded-sm px-1.5 py-0.5 hover:bg-text/5 hover:text-text"
        >
          {topic.label}
        </Link>
      </footer>
    </article>
  );
}

/**
 * The button is the price (§7.2d), and the price only appears when the pointer
 * is on it.
 *
 * Resting, the button says which side it is — which is what a reader scanning a
 * grid needs. Under the pointer it says what that side costs, which is what
 * somebody about to press it needs. Both live in the same box so nothing moves
 * when the answer changes, and it is a plain CSS cross-fade so a grid of forty
 * cards costs no JavaScript at all.
 */
function SideButton({
  market,
  outcome,
  tone,
}: {
  market: MarketSummary;
  outcome: OutcomeView;
  tone: 'rise' | 'fall';
}) {
  const skin =
    tone === 'rise'
      ? 'bg-rise/15 text-rise hover:bg-rise hover:text-paper'
      : 'bg-fall/15 text-fall hover:bg-fall hover:text-paper';

  return (
    <Link
      // The side travels with the click, so the ticket opens on it rather
      // than asking for the same decision a second time.
      href={`/market/${market.id}?side=${outcome.id}`}
      aria-label={`${outcome.label} on ${market.question} at ${kobo(outcome.price)}`}
      className={`group/side relative z-10 grid h-10 flex-1 place-items-center rounded-sm text-sm font-black transition-colors ${skin}`}
    >
      <span className="transition-opacity group-hover/side:opacity-0">{outcome.label}</span>
      <span className="absolute font-mono tabular-nums opacity-0 transition-opacity group-hover/side:opacity-100">
        {kobo(outcome.price)}
      </span>
    </Link>
  );
}

/** One side of a multi-outcome market: name, where it stands, and a way in. */
function OutcomeRow({ market, outcome }: { market: MarketSummary; outcome: OutcomeView }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex-1 truncate text-xs font-medium">{outcome.label}</span>
      <span className="font-mono text-sm font-black tabular-nums">
        {Math.round(percent(outcome.price))}%
      </span>
      <Link
        href={`/market/${market.id}?side=${outcome.id}`}
        aria-label={`Back ${outcome.label} on ${market.question}`}
        className="group/side relative z-10 grid h-[27px] w-11 place-items-center rounded-sm bg-rise/15 text-xs font-black text-rise transition-colors hover:bg-rise hover:text-paper"
      >
        <span className="transition-opacity group-hover/side:opacity-0">Back</span>
        <span className="absolute font-mono tabular-nums opacity-0 transition-opacity group-hover/side:opacity-100">
          {kobo(outcome.price)}
        </span>
      </Link>
    </li>
  );
}

/**
 * The semicircle a binary market wears next to its question.
 *
 * A number and the word "chance" would say the same thing in less space; the
 * arc is here because the grid is scanned rather than read, and an eye picks a
 * 78% arc out of a wall of cards faster than it picks the digits.
 */
function Gauge({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  // Half of a 22px-radius circle, drawn from the left horn to the right.
  const arc = Math.PI * 22;

  return (
    <span className="relative mt-0.5 block w-[58px] shrink-0" aria-hidden>
      <svg viewBox="0 0 52 30" className="w-full overflow-visible">
        <path
          d="M4 26 A22 22 0 0 1 48 26"
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
          className="stroke-border"
        />
        <path
          d="M4 26 A22 22 0 0 1 48 26"
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${((clamped / 100) * arc).toFixed(2)} ${arc.toFixed(2)}`}
          className="stroke-rise"
        />
      </svg>
      <span className="absolute inset-x-0 bottom-0 text-center leading-none">
        <span className="block font-mono text-sm font-black tabular-nums">
          {Math.round(clamped)}%
        </span>
        <span className="block text-[10px] text-text-muted">chance</span>
      </span>
    </span>
  );
}
