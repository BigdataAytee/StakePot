'use client';

import { AlertTriangle, ArrowUpRight, Eye, Share2, TrendingUp, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { PageShell } from '@/components/market/page-shell';
import { creator, type Nudge, type Standing, type StudioMarket } from '@/lib/creator-api';

/**
 * §2.14's creator studio.
 *
 * The loop this screen serves is *post → share → activate → resolve → status*,
 * so it is ordered by what a creator can do something about: the nudges first,
 * their standing second, and the numbers behind each market last. An analytics
 * dashboard that opens on a chart is a dashboard nobody acts on.
 */
export default function Studio() {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [markets, setMarkets] = useState<StudioMarket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([creator.standing(), creator.myMarkets()])
      .then(([mine, theirs]) => {
        setStanding(mine);
        setMarkets(theirs);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  async function claim(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await creator.claimHandle(handle.trim().toLowerCase());
      setStanding(await creator.standing());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const urgent = markets.flatMap((market) =>
    market.nudges.filter((nudge) => nudge.urgency !== 'fyi').map((nudge) => ({ market, nudge })),
  );

  return (
    <PageShell>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Your studio</h1>
          <p className="mt-1 text-base text-text-muted">
            What your markets are doing, and what would help them.
          </p>
        </div>
        {standing?.handle != null && (
          <Link
            href={`/c/${standing.handle}`}
            className="flex items-center gap-1 font-mono text-sm font-semibold text-brand underline underline-offset-2"
          >
            @{standing.handle} <ArrowUpRight size={14} />
          </Link>
        )}
      </header>

      {error !== null && <p className="mt-4 text-sm text-fall">{error}</p>}

      {standing !== null && standing.handle === null && (
        <section className="mt-6 rounded-xl border border-border p-4">
          <h2 className="font-bold">Pick a handle</h2>
          <p className="mt-1 text-sm text-text-muted">
            It goes on every market you open and every card anyone shares. Lowercase letters,
            numbers and underscores.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="tunde_01"
              aria-label="Your handle"
              className="h-11 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm focus:border-brand"
            />
            <button
              type="button"
              disabled={busy || handle.trim().length < 3}
              onClick={() => void claim()}
              className="h-11 shrink-0 rounded-md bg-brand px-4 text-sm font-bold text-paper transition-transform active:scale-press disabled:opacity-40"
            >
              Claim it
            </button>
          </div>
        </section>
      )}

      {urgent.length > 0 && (
        <section className="mt-6">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-text-muted">
            <AlertTriangle size={14} className="text-fall" /> Needs you
          </h2>
          <ul className="mt-2 space-y-2">
            {urgent.map(({ market, nudge }) => (
              <li
                key={`${market.id}-${nudge.kind}`}
                className={`rounded-lg border-l-2 p-3 ${
                  nudge.urgency === 'now' ? 'border-fall bg-fall/5' : 'border-money bg-money/5'
                }`}
              >
                <Link href={`/market/${market.id}`} className="text-sm font-semibold">
                  {market.question}
                </Link>
                <p className="mt-1 text-sm text-text-muted">{nudge.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {standing !== null && (
        <section className="mt-6 rounded-xl border border-border p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold">
              Level {standing.level}
              {standing.privileges.badge !== null && (
                <span className="ml-2 rounded-full bg-rise px-2 py-0.5 text-xs font-bold text-paper">
                  {standing.privileges.badge}
                </span>
              )}
            </h2>
            <span className="font-mono text-xs text-text-muted">
              {standing.liveMarkets}/{standing.privileges.maxLiveMarkets} live ·{' '}
              {(standing.privileges.creatorBps / 100).toFixed(2)}% creator fee
            </span>
          </div>

          {standing.progress === null ? (
            <p className="mt-2 text-sm text-text-muted">
              Pro is the top of the ladder. Featured placement, custom syndicate splits, and a share
              of the monthly bonus pool.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-text-muted">To reach level {standing.progress.target}:</p>
              {standing.progress.requirements.map((requirement) => (
                <div key={requirement.label} className="flex items-center gap-3 text-sm">
                  <div className="h-1.5 flex-1 rounded-full bg-border">
                    <div
                      className={`h-1.5 rounded-full ${requirement.met ? 'bg-rise' : 'bg-money'}`}
                      style={{
                        width: `${Math.min(100, (requirement.have / requirement.need) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="w-48 font-mono text-xs text-text-muted">
                    {requirement.label}{' '}
                    {requirement.have < 1 && requirement.need <= 1
                      ? `${Math.round(requirement.have * 100)}/${Math.round(requirement.need * 100)}%`
                      : `${Math.round(requirement.have)}/${Math.round(requirement.need)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Your markets</h2>
        {markets.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            Nothing yet.{' '}
            <Link href="/create" className="font-semibold text-brand underline underline-offset-2">
              Open your first market
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {markets.map((market) => (
              <li key={market.id} className="rounded-xl border border-border p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <Link href={`/market/${market.id}`} className="font-semibold">
                    {market.question}
                  </Link>
                  <span className="whitespace-nowrap font-mono text-xs uppercase text-text-muted">
                    {market.state}
                  </span>
                </div>

                {market.analytics !== null && (
                  <>
                    <dl className="mt-3 grid grid-cols-4 gap-3 font-mono text-xs">
                      <Stat icon={<Eye size={12} />} label="views" value={market.analytics.views} />
                      <Stat
                        icon={<Users size={12} />}
                        label="stakers"
                        value={market.analytics.stakers}
                      />
                      <Stat
                        icon={<TrendingUp size={12} />}
                        label="conversion"
                        value={
                          market.analytics.conversion === null
                            ? '—'
                            : `${(market.analytics.conversion * 100).toFixed(1)}%`
                        }
                      />
                      <Stat
                        icon={<Share2 size={12} />}
                        label="earned"
                        value={
                          <span className="text-money">
                            {Number(market.analytics.creatorFeeAccrued).toLocaleString('en-NG', {
                              maximumFractionDigits: 0,
                            })}
                          </span>
                        }
                      />
                    </dl>

                    <PoolBars pools={market.analytics.pools} />

                    {market.analytics.sources.length > 0 && (
                      <p className="mt-2 font-mono text-xs text-text-muted">
                        from{' '}
                        {market.analytics.sources
                          .map((entry) => `${entry.source} ${entry.views}`)
                          .join(' · ')}
                      </p>
                    )}
                  </>
                )}

                <NudgeList nudges={market.nudges} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {standing !== null && standing.autopsies.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">What closed</h2>
          <ul className="mt-2 space-y-3">
            {standing.autopsies.map((autopsy) => (
              <li key={autopsy.marketId} className="rounded-xl border border-border p-4">
                <p className="font-semibold">{autopsy.question}</p>
                <p className="mt-1 text-sm text-text-muted">{autopsy.summary}</p>
                {autopsy.worked.map((line) => (
                  <p key={line} className="mt-1 text-sm text-rise">
                    {line}
                  </p>
                ))}
                {autopsy.tip !== null && (
                  <p className="mt-2 border-l-2 border-money pl-3 text-sm">{autopsy.tip}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

/**
 * §2.14d's "activation progress bar per side".
 *
 * Measured against the best-funded pool rather than against the floor alone,
 * because once every side has cleared the floor — which is small — a bar drawn
 * against it is full everywhere and says nothing. The floor is still on the
 * chart, as a tick: it is the line that has to be cleared, not the scale.
 *
 * The point of this row is that a creator can see which side is short at a
 * glance, which is the same thing the nudge above is telling them.
 */
function PoolBars({
  pools,
}: {
  pools: {
    outcomeId: string;
    label: string;
    staked: string;
    price: string;
    activationProgress: number | null;
  }[];
}) {
  const best = Math.max(...pools.map((pool) => Number(pool.staked)), 0);

  return (
    <div className="mt-3 space-y-1.5">
      {pools.map((pool) => {
        const staked = Number(pool.staked);
        const share = best === 0 ? 0 : staked / best;
        // Where the activation floor sits on this scale, when it is known.
        const floorMark =
          pool.activationProgress === null || pool.activationProgress === 0 || staked === 0
            ? null
            : Math.min(100, (share / pool.activationProgress) * 100);

        return (
          <div key={pool.outcomeId} className="flex items-center gap-3 text-xs">
            <span className="w-24 truncate text-text-muted">{pool.label}</span>
            <div className="relative h-1.5 flex-1 rounded-full bg-border">
              <div
                className={`h-1.5 rounded-full ${share < 0.5 ? 'bg-money' : 'bg-rise'}`}
                style={{ width: `${Math.max(share * 100, 1)}%` }}
              />
              {floorMark !== null && (
                <span
                  title="activation floor"
                  className="absolute top-[-2px] h-[10px] w-px bg-text-muted"
                  style={{ left: `${floorMark}%` }}
                />
              )}
            </div>
            <span className="w-24 text-right font-mono text-text-muted">
              {staked.toLocaleString('en-NG', { maximumFractionDigits: 0 })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-text-muted">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-bold">{value}</dd>
    </div>
  );
}

function NudgeList({ nudges }: { nudges: Nudge[] }) {
  const quiet = nudges.filter((nudge) => nudge.urgency === 'fyi');
  if (quiet.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1">
      {quiet.map((nudge) => (
        <li key={nudge.kind} className="text-xs text-text-muted">
          {nudge.body}
        </li>
      ))}
    </ul>
  );
}
