'use client';

import { useCallback, useEffect, useState } from 'react';

import { useSavedViews } from '@/components/admin/work-queue';
import { ops, type Composition, type FundingWindow } from '@/lib/admin-api';
import { exactMoney, money } from '@/lib/format';

/**
 * §6.2's lifecycle controls.
 *
 * "Funding checks, post-activation void, seed composition view."
 *
 * The console could already void a market. What it could not do was look at
 * the ones about to need the decision, which meant the first anybody knew
 * about a window closing short was the refund landing in somebody's wallet.
 * This screen is the looking.
 *
 * Ordered by how soon a window closes, and the row says how many outcomes
 * actually have money on them — a pot total hides the case that voids a
 * market, which is one side at zero.
 */
export default function LifecyclePage() {
  // §6.10's saved views. A horizon somebody re-picks every morning is one they
  // stop using; "closing today" is a habit, not a preference.
  const { current, setCurrent, save, remove, names, views } = useSavedViews('lifecycle', {
    hours: 72,
  });
  const hours = current.hours;

  const [windows, setWindows] = useState<FundingWindow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewName, setViewName] = useState('');

  const load = useCallback(() => {
    void ops
      .funding(hours)
      .then(setWindows)
      .catch((caught: Error) => setError(caught.message));
  }, [hours]);

  useEffect(load, [load]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-black">Lifecycle</h1>
          <p className="mt-1 text-sm text-text-muted">
            What is still gathering backers, and what it is made of. A market with one side at zero
            voids however big the pot is.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {names.map((name) => (
            <span key={name} className="flex items-center rounded-sm bg-surface-raised">
              <button
                type="button"
                onClick={() => setCurrent(views[name] ?? current)}
                className="px-2 py-1 font-mono text-xs"
              >
                {name}
              </button>
              <button
                type="button"
                onClick={() => remove(name)}
                aria-label={`Forget the ${name} view`}
                className="px-1.5 py-1 text-xs text-text-muted hover:text-fall"
              >
                ×
              </button>
            </span>
          ))}

          <label>
            <span className="mr-2 text-text-muted">closing within</span>
            <select
              value={hours}
              onChange={(event) => setCurrent({ hours: Number(event.target.value) })}
              className="rounded-sm border border-border bg-surface px-2 py-1"
            >
              <option value={24}>24h</option>
              <option value={72}>72h</option>
              <option value={168}>a week</option>
              <option value={720}>everything open</option>
            </select>
          </label>

          <input
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            placeholder="save as…"
            aria-label="Name for this saved view"
            className="w-24 rounded-sm border border-border bg-surface px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={viewName.trim().length === 0}
            onClick={() => {
              save(viewName.trim());
              setViewName('');
            }}
            className="rounded-sm border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {windows !== null && windows.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-text-muted">
          No funding windows closing in that time.
        </p>
      )}

      <ul className="space-y-2">
        {(windows ?? []).map((market) => (
          <li key={market.id} className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setOpen(open === market.id ? null : market.id)}
              aria-expanded={open === market.id}
              className="flex w-full items-start justify-between gap-4 p-4 text-left hover:bg-surface-raised"
            >
              <span className="min-w-0">
                <span className="block text-md font-bold">{market.question}</span>
                <span className="mt-1 block font-mono text-xs text-text-muted">
                  {market.state} · {market.shelf} · {market.activationPath ?? 'organic'} ·{' '}
                  {market.trades} trades
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {market.outcomes.map((outcome) => (
                    <span
                      key={outcome.label}
                      className={`rounded-sm px-1.5 py-0.5 font-mono text-xs ${
                        outcome.funded ? 'bg-rise/15 text-rise' : 'bg-fall/15 text-fall'
                      }`}
                    >
                      {outcome.label} {money(outcome.staked)}
                    </span>
                  ))}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-md text-money">{money(market.pot)}</span>
                <span className="mt-0.5 block font-mono text-xs text-text-muted">
                  <Countdown iso={market.closesAt} />
                </span>
              </span>
            </button>

            {open === market.id && <CompositionPanel marketId={market.id} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How long is left, and amber once it is inside a day. */
function Countdown({ iso }: { iso: string | null }) {
  if (iso === null) return <span>awaiting seed</span>;

  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return <span className="text-fall">window closed — worker overdue</span>;

  const hours = Math.floor(ms / 3_600_000);
  const label = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  return <span className={hours < 24 ? 'text-money' : ''}>{label} left</span>;
}

/** §6.2's seed composition view, opened in place rather than on its own screen. */
function CompositionPanel({ marketId }: { marketId: string }) {
  const [composition, setComposition] = useState<Composition | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ops
      .composition(marketId)
      .then(setComposition)
      .catch((caught: Error) => setError(caught.message));
  }, [marketId]);

  if (error !== null)
    return <p className="border-t border-border p-4 text-sm text-fall">{error}</p>;
  if (composition === null)
    return <p className="border-t border-border p-4 text-sm text-text-muted">Loading…</p>;

  return (
    <div className="grid gap-4 border-t border-border p-4 text-sm md:grid-cols-3">
      <section>
        <h3 className="font-mono text-xs uppercase text-text-muted">Pools</h3>
        <ul className="mt-2 space-y-1">
          {composition.outcomes.map((outcome) => (
            <li key={outcome.label} className="flex justify-between gap-3">
              <span>{outcome.label}</span>
              <span className="font-mono tabular-nums">{exactMoney(outcome.staked)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="font-mono text-xs uppercase text-text-muted">Syndicate</h3>
        {composition.syndicates.length === 0 ? (
          <p className="mt-2 text-text-muted">None — this is not a seeded market.</p>
        ) : (
          composition.syndicates.map((syndicate) => (
            <div key={syndicate.id} className="mt-2">
              <p className="font-mono text-xs">
                {syndicate.state} · {money(syndicate.raised)} of {money(syndicate.target)} ·{' '}
                {syndicate.members.length}/{syndicate.maxSponsors} sponsors
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Organiser takes {(syndicate.organiserBps / 100).toFixed(2)}% of the fee; the split
                locked when the round opened.
              </p>
              <ul className="mt-2 space-y-1">
                {syndicate.members.map((member) => (
                  <li key={member.userId} className="flex justify-between gap-3 font-mono text-xs">
                    <span className="truncate">{member.userId}</span>
                    <span className="tabular-nums">{money(member.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section>
        <h3 className="font-mono text-xs uppercase text-text-muted">Bonds</h3>
        {composition.bonds.length === 0 ? (
          <p className="mt-2 text-text-muted">No bond held.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {composition.bonds.map((bond) => (
              <li key={bond.id} className="flex justify-between gap-3 font-mono text-xs">
                <span>{bond.state}</span>
                <span className="tabular-nums">{money(bond.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-text-muted">
          Forfeiting a bond is a four-eyes proposal in the approvals inbox — deliberately not a
          button here.
        </p>
      </section>
    </div>
  );
}
