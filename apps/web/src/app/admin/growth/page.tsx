'use client';

import { useCallback, useEffect, useState } from 'react';

import { ops, type BroadcastRow, type FeatureFlagRow, type TopCallRow } from '@/lib/admin-api';
import { dateTime, money, percent } from '@/lib/format';

/**
 * §6.8's content and growth console — the three screens that did not exist.
 *
 * "Weekly Top Calls curation... notification broadcasts... feature flags & A/B
 * toggles."
 *
 * All three are the same shape underneath: something the system proposes or
 * could do at scale, held behind a person. The Top Calls job proposes and
 * somebody features; a broadcast is drafted by one person and sent by another;
 * a flag ramps by percentage rather than flipping on for everyone at once.
 */
type Tab = 'flags' | 'broadcasts' | 'topcalls';

export default function GrowthPage() {
  const [tab, setTab] = useState<Tab>('flags');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-black">Content &amp; growth</h1>
        <p className="mt-1 text-sm text-text-muted">
          Flags, broadcasts and the weekly showcase. Everything here reaches members, so everything
          here waits for a person.
        </p>
      </header>

      <nav className="flex gap-1" aria-label="Growth sections">
        {(
          [
            ['flags', 'Feature flags'],
            ['broadcasts', 'Broadcasts'],
            ['topcalls', 'Top Calls'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`rounded-sm px-3 py-1.5 text-sm ${
              tab === key ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'flags' && <Flags />}
      {tab === 'broadcasts' && <Broadcasts />}
      {tab === 'topcalls' && <TopCalls />}
    </div>
  );
}

/**
 * §2.13's canary gating.
 *
 * The percentage is the point. A flag that only goes on and off turns a bad
 * release into an incident for everybody at once; a rollout that ramps lets a
 * change be wrong for 5% of accounts for ten minutes. Members keep the same
 * answer as the percentage rises — raising it adds people, it never swaps the
 * cohort.
 */
function Flags() {
  const [flags, setFlags] = useState<FeatureFlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void ops
      .flags()
      .then(setFlags)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-3">
      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <ul className="space-y-2">
        {(flags ?? []).map((flag) => (
          <FlagRow key={flag.key} flag={flag} onSaved={load} />
        ))}
      </ul>

      <NewFlag onSaved={load} />
    </div>
  );
}

function FlagRow({ flag, onSaved }: { flag: FeatureFlagRow; onSaved: () => void }) {
  const [pct, setPct] = useState(flag.rolloutPct);
  const [busy, setBusy] = useState(false);

  async function save(next: Partial<FeatureFlagRow>): Promise<void> {
    setBusy(true);
    try {
      await ops.saveFlag({
        key: flag.key,
        description: flag.description,
        enabled: next.enabled ?? flag.enabled,
        rolloutPct: next.rolloutPct ?? pct,
        allowList: flag.allowList,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span>
          <span className="font-mono text-sm font-semibold">{flag.key}</span>
          <span className="ml-2 text-xs text-text-muted">{flag.description}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save({ enabled: !flag.enabled })}
          className={`rounded-sm px-2 py-1 font-mono text-xs ${
            flag.enabled ? 'bg-rise/15 text-rise' : 'bg-surface-raised text-text-muted'
          }`}
        >
          {flag.enabled ? 'live' : 'off'}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          onChange={(event) => setPct(Number(event.target.value))}
          onPointerUp={() => void save({ rolloutPct: pct })}
          aria-label={`Rollout percentage for ${flag.key}`}
          className="flex-1 accent-brand"
          disabled={!flag.enabled || busy}
        />
        <span className="w-12 text-right font-mono text-sm tabular-nums">{pct}%</span>
      </div>

      <p className="mt-1 font-mono text-xs text-text-muted">
        {flag.allowList.length > 0 && `${flag.allowList.length} always-in · `}
        {flag.updatedBy ?? 'unset'} · {dateTime(flag.updatedAt)}
      </p>
      {!flag.enabled && (
        <p className="mt-1 text-xs text-text-muted">
          Off is a kill switch: it beats the percentage and the allow list both.
        </p>
      )}
    </li>
  );
}

function NewFlag({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    setError(null);
    try {
      await ops.saveFlag({ key, description, enabled: false, rolloutPct: 0 });
      setKey('');
      setDescription('');
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not create that flag');
    }
  }

  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="flag-key"
          aria-label="Flag key"
          className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm"
        />
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What it gates"
          aria-label="Flag description"
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 py-1 text-sm"
        />
        <button
          type="button"
          disabled={key.trim().length < 2 || description.trim().length < 3}
          onClick={() => void create()}
          className="rounded-sm border border-border px-3 py-1 text-sm disabled:opacity-40"
        >
          Add
        </button>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        New flags start off at 0%. An unknown key reads as off everywhere, so shipping the code
        before the flag exists is safe.
      </p>
      {error !== null && <p className="mt-1 text-xs text-fall">{error}</p>}
    </div>
  );
}

/**
 * §6.8's notification broadcasts.
 *
 * Drafted by one person and sent by another, which is the four-eyes shape
 * applied to the one console action that reaches every member at once and
 * cannot be taken back.
 */
function Broadcasts() {
  const [rows, setRows] = useState<BroadcastRow[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [segment, setSegment] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void ops
      .broadcasts()
      .then(setRows)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  useEffect(load, [load]);

  async function draft(): Promise<void> {
    setError(null);
    try {
      await ops.draftBroadcast({ title, body, segment });
      setTitle('');
      setBody('');
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not draft that');
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border p-3">
        <h2 className="text-sm font-semibold">Draft one</h2>
        <div className="mt-2 space-y-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            aria-label="Broadcast title"
            className="w-full rounded-sm border border-border bg-surface px-2 py-1 text-sm"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            placeholder="What you want to tell them"
            aria-label="Broadcast body"
            className="w-full rounded-sm border border-border bg-surface px-2 py-1 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={segment}
              onChange={(event) => setSegment(event.target.value)}
              aria-label="Segment"
              className="rounded-sm border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="all">Everyone active</option>
              <option value="tier1">Verified (tier 1+)</option>
              <option value="creators">Creators</option>
              <option value="dormant">Dormant 30 days</option>
            </select>
            <button
              type="button"
              disabled={title.trim().length < 3 || body.trim().length < 3}
              onClick={() => void draft()}
              className="rounded-sm border border-border px-3 py-1 text-sm disabled:opacity-40"
            >
              Save draft
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Drafting is not sending. Somebody other than you has to send it — the same rule as a money
          approval, for the same reason.
        </p>
        {error !== null && <p className="mt-1 text-xs text-fall">{error}</p>}
      </section>

      <ul className="space-y-2">
        {(rows ?? []).map((broadcast) => (
          <BroadcastRowView key={broadcast.id} broadcast={broadcast} onSent={load} />
        ))}
      </ul>
    </div>
  );
}

function BroadcastRowView({ broadcast, onSent }: { broadcast: BroadcastRow; onSent: () => void }) {
  const [reach, setReach] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (broadcast.sentAt !== null) return;
    void ops
      .broadcastReach(broadcast.id)
      .then((result) => setReach(result.recipients))
      .catch(() => undefined);
  }, [broadcast.id, broadcast.sentAt]);

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ops.sendBroadcast(broadcast.id);
      onSent();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not send that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-md font-bold">{broadcast.title}</span>
        <span className="font-mono text-xs text-text-muted">
          {broadcast.segment} ·{' '}
          {broadcast.sentAt === null
            ? `${reach ?? '…'} would receive`
            : `sent to ${broadcast.recipients} · ${dateTime(broadcast.sentAt)}`}
        </span>
      </div>
      <p className="mt-1 text-sm text-text-muted">{broadcast.body}</p>

      {broadcast.sentAt === null && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void send()}
            className="rounded-sm bg-brand px-3 py-1 text-xs font-bold text-paper disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
          <span className="font-mono text-xs text-text-muted">
            drafted by {broadcast.createdBy}
          </span>
        </div>
      )}
      {error !== null && <p className="mt-1 text-xs text-fall">{error}</p>}
    </li>
  );
}

/**
 * §6.8's Top Calls curation.
 *
 * The job proposes the boldest correct calls of the week; nothing reaches the
 * public showcase without somebody choosing it. A curated marketing asset that
 * publishes itself is one unfortunate market away from featuring something the
 * platform has to apologise for.
 */
function TopCalls() {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [view, setView] = useState<{ week: string; calls: TopCallRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void ops
      .topCalls(week)
      .then(setView)
      .catch((caught: Error) => setError(caught.message));
  }, [week]);

  useEffect(load, [load]);

  async function propose(): Promise<void> {
    setBusy(true);
    try {
      await ops.proposeTopCalls(week);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm">
          <span className="mr-2 text-text-muted">week</span>
          <input
            value={week ?? view?.week ?? ''}
            onChange={(event) => setWeek(event.target.value || undefined)}
            placeholder="2026-W33"
            className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void propose()}
          className="rounded-sm border border-border px-3 py-1 text-sm disabled:opacity-40"
        >
          {busy ? 'Finding…' : 'Re-run the proposer'}
        </button>
      </div>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      <ul className="space-y-2">
        {(view?.calls ?? []).map((call) => (
          <li
            key={call.id}
            className={`rounded-md border p-3 ${
              call.featured ? 'border-rise/50 bg-rise/5' : 'border-border'
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-md font-bold">{call.question}</span>
              <button
                type="button"
                onClick={() => {
                  void ops.featureTopCall(call.id, !call.featured).then(load);
                }}
                className={`rounded-sm px-2 py-1 font-mono text-xs ${
                  call.featured ? 'bg-rise/15 text-rise' : 'bg-surface-raised text-text-muted'
                }`}
              >
                {call.featured ? 'featured' : 'feature it'}
              </button>
            </div>
            <p className="mt-1 font-mono text-xs text-text-muted">
              {call.handle === null ? (call.displayName ?? 'anonymous') : `@${call.handle}`} bought{' '}
              <span className="text-money">{Math.round(percent(call.entryPrice))}%</span> · resolved{' '}
              {call.resolvedOutcome} · pot {money(call.pot)}
            </p>
          </li>
        ))}
      </ul>

      {view !== null && view.calls.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-text-muted">
          Nothing proposed for {view.week}. Nothing resolved that week, or the job has not run.
        </p>
      )}
    </div>
  );
}
