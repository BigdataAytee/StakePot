'use client';

import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import { RulesCard } from '@/components/rules-card';
import { api, type Annotation, type MarketContext, type MarketDetail } from '@/lib/api';
import { ago, dateTime, money, percent } from '@/lib/format';

/**
 * Everything a reader needs to understand what they are trading into, under
 * one frame beneath the chart.
 *
 * Tabs rather than a stack, and specifically because of the phone. Rules,
 * news, statistics and an activity feed laid end to end is about four screens
 * of scrolling between the chart and the take thread, which on a phone means
 * the thread is never reached and none of the four is read. Tabbed, each one
 * is a tap and the page stays one screen tall.
 *
 * Rules leads. It is the tab that changes whether somebody should trade at
 * all — the others only colour how.
 */
const TABS = ['Rules', 'News', 'Stats', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export function ContextPanel({
  market,
  refreshKey,
}: {
  market: MarketDetail;
  /** Bumped after a fill, so the reader sees their own trade land in the feed. */
  refreshKey: number;
}) {
  const [tab, setTab] = useState<Tab>('Rules');
  const [context, setContext] = useState<MarketContext | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .context(market.id)
      .then((data) => {
        if (live) setContext(data);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [market.id, refreshKey]);

  const news = market.annotations.filter((a) => a.type === 'news');

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-border bg-surface-raised">
      <div role="tablist" aria-label="About this market" className="flex border-b border-border">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            type="button"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`flex-1 px-2 py-2.5 text-[13px] font-semibold transition-colors ${
              tab === name
                ? 'border-b-2 border-brand text-text'
                : 'border-b-2 border-transparent text-text-muted hover:text-text'
            }`}
          >
            {name}
            {/* A chip, not a bare number: "News 2" beside three plain words
                reads as a heading that lost its noun. */}
            {name === 'News' && news.length > 0 && (
              <span className="ml-1.5 rounded-full bg-chip px-1.5 py-0.5 font-mono text-[10px] font-bold text-text-muted">
                {news.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === 'Rules' && (
          <>
            <RulesCard market={market} bare />
            <SourceWatch market={market} />
          </>
        )}
        {tab === 'News' && <News items={news} sourceName={market.sourceName} />}
        {tab === 'Stats' && <Stats context={context} failed={failed} />}
        {tab === 'Activity' && <Activity context={context} failed={failed} />}
      </div>
    </section>
  );
}

/**
 * What is being watched, and — the part every other product leaves out — how
 * often.
 *
 * The reference shows a "source watch" with a last-checked timestamp, which
 * implies a poller. StakeAm has no feed reader: the named source is read by a
 * human at settlement. Printing a fake "checked 2 minutes ago" would be the
 * single most damaging sentence on the page, because it is the one a reader
 * would rely on. So the panel says exactly what happens instead.
 */
function SourceWatch({ market }: { market: MarketDetail }) {
  return (
    <div className="mt-4 rounded-md border border-border bg-surface p-3 text-sm">
      <h3 className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted">
        Source watch
      </h3>
      <p className="mt-1.5">
        <a
          href={market.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 font-semibold text-rise underline underline-offset-2"
        >
          {market.sourceName}
          <ExternalLink size={12} />
        </a>
      </p>
      <p className="mt-1.5 text-text-muted">
        Read once, at settlement — not continuously. The price above is what traders think this
        source will say on {dateTime(market.eventDate)}, not a live reading of it.
      </p>
    </div>
  );
}

/**
 * Pinned news, newest first.
 *
 * The same rows that drop marks on the chart, so a spike a reader can see has
 * an explanation they can read, in the one place they would look for it.
 */
function News({ items, sourceName }: { items: Annotation[]; sourceName: string }) {
  if (items.length === 0) {
    return (
      <Empty>
        Nothing pinned yet. When something moves this market, we pin it here with its source — and
        it appears on the chart at the moment it happened.
      </Empty>
    );
  }

  return (
    <ol className="space-y-3">
      {[...items]
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .map((item) => (
          <li
            key={item.id}
            className="border-b border-border pb-3 text-sm last:border-b-0 last:pb-0"
          >
            <p className="font-medium">{item.label}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span className="font-mono">{dateTime(item.ts)}</span>
              {item.url !== null && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-rise underline underline-offset-2"
                >
                  Source
                  <ExternalLink size={11} />
                </a>
              )}
              {/* Who pinned it. An unattributed news item on a money screen is
                  an anonymous claim, and this one moves a chart. */}
              {item.pinnedBy !== null && <span>Pinned by {item.pinnedBy}</span>}
            </p>
          </li>
        ))}
      <li className="pt-1 text-xs text-text-muted">
        Pinned items are context, not the ruling. This market settles against {sourceName}.
      </li>
    </ol>
  );
}

function Stats({ context, failed }: { context: MarketContext | null; failed: boolean }) {
  if (failed) return <Empty>Couldn&rsquo;t load the numbers. Reload the page to try again.</Empty>;
  if (context === null) return <Skeleton rows={3} />;

  const move = context.biggestMove;

  return (
    <>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-[.05em] text-text-muted">
              <th className="px-4 py-1.5 text-left font-semibold">Outcome</th>
              <th className="px-2 py-1.5 text-right font-semibold">Opened</th>
              <th className="px-2 py-1.5 text-right font-semibold">High</th>
              <th className="px-2 py-1.5 text-right font-semibold">Low</th>
              <th className="px-2 py-1.5 text-right font-semibold">Now</th>
              <th className="px-4 py-1.5 text-right font-semibold">Holders</th>
            </tr>
          </thead>
          <tbody>
            {context.stats.map((row) => (
              <tr key={row.outcomeId} className="border-t border-border">
                <td className="px-4 py-2 font-medium">{row.label}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(row.opened)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(row.high)}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums">{pct(row.low)}</td>
                <td className="px-2 py-2 text-right font-mono font-bold tabular-nums">
                  {pct(row.latest)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{row.holders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-text-muted">Opened</dt>
          <dd className="font-mono">{dateTime(context.openedAt)}</dd>
        </div>
        {/* The one line on the panel that tells a story rather than a number:
            the moment somebody's conviction actually showed up. */}
        {move !== null && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-text-muted">Biggest move</dt>
            <dd>
              <b>{move.label}</b>{' '}
              <span className="font-mono">
                {pct(move.from)} → {pct(move.to)}
              </span>{' '}
              <span className="text-text-muted">{ago(move.ts)}</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

function Activity({ context, failed }: { context: MarketContext | null; failed: boolean }) {
  if (failed)
    return <Empty>Couldn&rsquo;t load recent activity. Reload the page to try again.</Empty>;
  if (context === null) return <Skeleton rows={5} />;
  if (context.activity.length === 0) {
    return <Empty>No trades yet. The first one sets the price everybody else argues with.</Empty>;
  }

  return (
    <>
      <ol className="space-y-2.5 text-sm">
        {context.activity.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-mono text-xs text-text-muted">{entry.actor}</span>
            <span className={entry.side === 'buy' ? 'text-rise' : 'text-fall'}>
              {entry.side === 'buy' ? 'bought' : 'sold'}
            </span>
            <b>{entry.label}</b>
            <span className="text-text-muted">
              for <span className="font-mono text-text">{money(entry.cost)}</span>
            </span>
            <span className="ml-auto whitespace-nowrap text-xs text-text-muted">
              {ago(entry.ts)}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-2.5 text-xs text-text-muted">
        Traders are shown under a code, not a name — and a different code on every market.
      </p>
    </>
  );
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(percent(value))}%`;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-text-muted">{children}</p>;
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-4 rounded-sm bg-chip motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
