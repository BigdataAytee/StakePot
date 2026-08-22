'use client';

import { useCallback, useEffect, useState } from 'react';

import { ops, type CreatorDeskRow } from '@/lib/admin-api';
import { money } from '@/lib/format';

/**
 * §6.6's creators desk.
 *
 * The one screen for somebody responsible for creators: who is running what,
 * how clean their settlement record is, and which bonds are held against which
 * markets.
 *
 * There is no slash-bond button. Forfeiting a bond moves money and §2.10 makes
 * it four-eyes; the approvals inbox already implements it with a proposer, an
 * approver and a reason. A second, easier path to the same outcome is exactly
 * the god button §6 forbids — so the bond is shown here with its market
 * reference so the proposal can be raised knowing what it is about.
 */
export default function CreatorsDeskPage() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CreatorDeskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void ops
      .creators(query)
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-black">Creators desk</h1>
          <p className="mt-1 text-sm text-text-muted">
            Ranked by volume hosted. The clean rate is what the ladder reads; a level set by hand
            here overrides it and says why.
          </p>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="handle or name"
          aria-label="Search creators"
          className="rounded-sm border border-border bg-surface px-2 py-1 text-sm"
        />
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <ul className="space-y-2">
        {(rows ?? []).map((creator) => (
          <CreatorRow key={creator.userId} creator={creator} onChanged={load} />
        ))}
      </ul>

      {rows !== null && rows.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-text-muted">
          No creators match that.
        </p>
      )}
    </div>
  );
}

function CreatorRow({ creator, onChanged }: { creator: CreatorDeskRow; onChanged: () => void }) {
  const settled = creator.cleanResolutions + creator.disputedResolutions;
  const cleanRate = settled === 0 ? null : creator.cleanResolutions / settled;

  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span>
          <span className="text-md font-bold">
            {creator.handle === null ? (creator.displayName ?? 'unnamed') : `@${creator.handle}`}
          </span>
          <span className="ml-2 rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-xs">
            level {creator.level}
          </span>
          {creator.status !== 'active' && (
            <span className="ml-2 rounded-sm bg-fall/15 px-1.5 py-0.5 font-mono text-xs text-fall">
              {creator.status}
            </span>
          )}
        </span>
        <span className="font-mono text-sm text-money">{money(creator.volumeHosted)} hosted</span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-5">
        <Figure label="live" value={String(creator.liveMarkets)} />
        <Figure label="clean" value={String(creator.cleanResolutions)} />
        <Figure
          label="disputed"
          value={String(creator.disputedResolutions)}
          alarm={creator.disputedResolutions > 0}
        />
        <Figure
          label="voided live"
          value={String(creator.voidedAfterActivation)}
          alarm={creator.voidedAfterActivation > 0}
        />
        <Figure
          label="clean rate"
          value={cleanRate === null ? '—' : `${Math.round(cleanRate * 100)}%`}
          alarm={cleanRate !== null && cleanRate < 0.8}
        />
      </dl>

      {creator.bonds.length > 0 && (
        <div className="mt-3 rounded-sm bg-surface-raised p-2">
          <p className="font-mono text-xs uppercase text-text-muted">Bonds held</p>
          <ul className="mt-1 space-y-0.5">
            {creator.bonds.map((bond) => (
              <li key={bond.id} className="flex justify-between gap-3 font-mono text-xs">
                <a href={`/market/${bond.marketId}`} className="truncate underline">
                  {bond.marketId}
                </a>
                <span className="tabular-nums">{money(bond.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-text-muted">
            Forfeit is a four-eyes proposal in the approvals inbox.
          </p>
        </div>
      )}

      <LevelOverride creator={creator} onChanged={onChanged} />
    </li>
  );
}

function Figure({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div>
      <dt className="uppercase text-text-muted">{label}</dt>
      <dd className={`tabular-nums ${alarm === true ? 'text-fall' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * The ladder is a pure rule and stays the source of truth. This is for what
 * the rule cannot see — a creator being wound down after a Trust and Safety
 * finding, or promoted for a reason the counters do not carry. It demands a
 * reason because a level changed without one is indistinguishable from a
 * mistake.
 */
function LevelOverride({ creator, onChanged }: { creator: CreatorDeskRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(creator.level);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ops.setLevel(creator.userId, level, reason);
      setOpen(false);
      setReason('');
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not set that level');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs font-semibold text-brand underline"
      >
        Override level
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-sm border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">
          <span className="mr-1 text-text-muted">level</span>
          <select
            value={level}
            onChange={(event) => setLevel(Number(event.target.value))}
            className="rounded-sm border border-border bg-surface px-2 py-1"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why — at least ten characters, and it is on the record"
          aria-label="Reason for the override"
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={busy || reason.trim().length < 10}
          onClick={() => void save()}
          className="rounded-sm bg-brand px-3 py-1 text-xs font-bold text-paper disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Set'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-text-muted underline"
        >
          Cancel
        </button>
      </div>
      {error !== null && <p className="mt-1 text-xs text-fall">{error}</p>}
    </div>
  );
}
