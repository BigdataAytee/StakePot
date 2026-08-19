'use client';

import { useEffect, useState } from 'react';

import { API_URL } from '@/lib/api';
import { exactMoney } from '@/lib/format';
import { PageShell } from '@/components/market/page-shell';

interface RgView {
  depositLimit: string | null;
  stakeLimit: string | null;
  lossLimit: string | null;
  cooloffUntil: string | null;
  selfExcluded: boolean;
  selfExcludedAt: string | null;
  stakedToday: string;
  lostToday: string;
  effectiveStakeLimit: string;
  effectiveLossLimit: string;
  helpline: string;
  realityCheckMinutes: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const token = window.localStorage.getItem('stakeam.token');
  if (token === null) throw new Error('Sign in to manage your limits.');

  const response = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      parsed !== null && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `Something went wrong (${response.status})`;
    throw new Error(message);
  }
  return parsed as T;
}

/**
 * The limits screen (§2.12).
 *
 * Written to be usable by someone who is not having a good day: the controls
 * get plainer and heavier as they get more serious, the helpline sits above
 * them rather than in a footer, and nothing here is dressed up as a feature.
 */
export default function LimitsPage() {
  const [view, setView] = useState<RgView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stakeLimit, setStakeLimit] = useState('');
  const [lossLimit, setLossLimit] = useState('');
  const [days, setDays] = useState('7');
  const [confirm, setConfirm] = useState('');

  const load = (): void => {
    void call<RgView>('/account/limits')
      .then((next) => {
        setView(next);
        setStakeLimit(next.stakeLimit ?? '');
        setLossLimit(next.lossLimit ?? '');
      })
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  async function act(path: string, body: unknown, message: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const next = await call<RgView>(path, body);
      setView(next);
      setNotice(message);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  if (view === null) {
    return (
      <PageShell width="narrow">
        <h1 className="text-xl font-black">Your limits</h1>
        <p className="mt-3 text-sm text-text-muted">{error ?? 'Loading…'}</p>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <h1 className="text-xl font-black">Your limits</h1>
      <p className="mt-3 rounded-md border border-border bg-surface-raised px-4 py-3 text-md">
        {view.helpline}
      </p>

      {notice !== null && <p className="mt-4 text-sm text-rise">{notice}</p>}
      {error !== null && <p className="mt-4 text-sm text-fall">{error}</p>}

      {view.selfExcluded ? (
        <section className="mt-6 rounded-md border border-fall bg-fall/10 p-4">
          <h2 className="font-semibold">You are self-excluded</h2>
          <p className="mt-1 text-sm">
            Staking is off for good. Your balance is still yours — you can withdraw it whenever you
            like. If you want to talk to a person, open a support ticket and we will pick it up.
          </p>
          {view.selfExcludedAt !== null && (
            <p className="mt-2 font-mono text-xs text-text-muted">
              since {new Date(view.selfExcludedAt).toLocaleDateString('en-NG')}
            </p>
          )}
        </section>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-2 gap-3">
            <Figure label="Staked today" value={exactMoney(view.stakedToday)} />
            <Figure label="Daily stake limit" value={exactMoney(view.effectiveStakeLimit)} />
            <Figure label="Down today" value={exactMoney(view.lostToday)} />
            <Figure label="Daily loss limit" value={exactMoney(view.effectiveLossLimit)} />
          </section>

          <section className="mt-6">
            <h2 className="text-sm font-semibold">Set your own limits</h2>
            <p className="mt-1 text-sm text-text-muted">
              A tighter limit takes effect straight away. A looser one cannot be set during a
              cool-off — that is what a cool-off is for.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm">
                Most I can stake in a day
                <input
                  value={stakeLimit}
                  onChange={(event) => setStakeLimit(event.target.value)}
                  inputMode="decimal"
                  placeholder="no limit"
                  className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono tabular-nums outline-none focus:border-rise"
                />
              </label>
              <label className="block text-sm">
                Most I can lose in a day
                <input
                  value={lossLimit}
                  onChange={(event) => setLossLimit(event.target.value)}
                  inputMode="decimal"
                  placeholder="no limit"
                  className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono tabular-nums outline-none focus:border-rise"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() =>
                void act(
                  '/account/limits',
                  {
                    ...(stakeLimit === '' ? { clearStake: true } : { stakeLimit }),
                    ...(lossLimit === '' ? { clearLoss: true } : { lossLimit }),
                  },
                  'Saved.',
                )
              }
              className="mt-3 rounded-md bg-rise px-4 py-2.5 font-bold text-paper transition-transform active:scale-press"
            >
              Save limits
            </button>
          </section>

          <section className="mt-8">
            <h2 className="text-sm font-semibold">Take a break</h2>
            <p className="mt-1 text-sm text-text-muted">
              Staking stops until it runs out. Nothing else changes, and your balance stays where it
              is.
              {view.cooloffUntil !== null && (
                <span className="ml-1 text-money">
                  Currently on a break until {new Date(view.cooloffUntil).toLocaleString('en-NG')}.
                </span>
              )}
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={days}
                onChange={(event) => setDays(event.target.value)}
                inputMode="numeric"
                aria-label="Days"
                className="w-24 rounded-md border border-border bg-surface px-3 py-2.5 font-mono tabular-nums"
              />
              <button
                type="button"
                onClick={() =>
                  void act('/account/cool-off', { days: Number(days) }, 'Your break has started.')
                }
                className="rounded-md border border-border px-4 py-2.5 font-semibold"
              >
                Start a break
              </button>
            </div>
          </section>

          <section className="mt-8 rounded-md border border-border p-4">
            <h2 className="text-sm font-semibold">Stop for good</h2>
            <p className="mt-1 text-sm text-text-muted">
              Self-exclusion is permanent. Staking stops, your balance stays yours to withdraw, and
              only a person can undo it — type SELF-EXCLUDE to confirm.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="SELF-EXCLUDE"
                aria-label="Type SELF-EXCLUDE to confirm"
                className="flex-1 rounded-md border border-border bg-surface px-3 py-2.5 font-mono"
              />
              <button
                type="button"
                disabled={confirm.trim().toUpperCase() !== 'SELF-EXCLUDE'}
                onClick={() =>
                  void act(
                    '/account/self-exclude',
                    { confirm },
                    'You are self-excluded. Your balance is still yours.',
                  )
                }
                className="rounded-md bg-fall px-4 py-2.5 font-bold text-paper disabled:opacity-30"
              >
                Self-exclude
              </button>
            </div>
          </section>
        </>
      )}

      <p className="mt-8 text-sm text-text-muted">
        We check in after {view.realityCheckMinutes} minutes of continuous play, so you always know
        how long you have been here.
      </p>
    </PageShell>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums text-money">{value}</p>
    </div>
  );
}
