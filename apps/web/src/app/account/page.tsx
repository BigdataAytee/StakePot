'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PageShell, PageTitle } from '@/components/market/page-shell';
import { dateTime, money } from '@/lib/format';
import { authed, getToken, useSession } from '@/lib/session';

/**
 * §2.18's account housekeeping, and §2.17's referrals.
 *
 * Sessions, the withdrawal freeze, consents and the referral code all existed
 * as services with no screen — which is the same failure as no feature at all.
 * A person cannot end a session they cannot see.
 *
 * The order is deliberate: sessions first, because somebody who opens this
 * page is usually here because something felt wrong.
 */
interface SessionRow {
  id: string;
  userAgent: string;
  ip: string;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

interface SessionsView {
  sessions: SessionRow[];
  freeze: { active: boolean; until: string | null; reason: string | null };
}

interface ConsentsView {
  history: { document: string; version: string; acceptedAt: string; current: boolean }[];
  outstanding: string[];
  marketing: boolean;
}

interface ReferralsView {
  code: string;
  invited: number;
  qualified: number;
  earned: string;
  referrals: { joinedAt: string; status: string; earned: string }[];
}

export default function AccountPage() {
  const { me, loading } = useSession();

  if (!loading && me === null) {
    return (
      <PageShell>
        <p className="text-base text-text-muted">
          <Link href="/login" className="font-semibold text-brand underline">
            Log in
          </Link>{' '}
          to manage your account.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <PageTitle
        title="Account"
        blurb="Where you are signed in, what you agreed to, and who you brought."
      />
      <Sessions />
      <Referrals />
      <Consents />
      <nav className="mt-8 flex flex-wrap gap-4 text-sm">
        <Link href="/account/limits" className="font-semibold text-brand underline">
          Limits and taking a break
        </Link>
        <Link href="/support" className="font-semibold text-brand underline">
          Support
        </Link>
      </nav>
    </PageShell>
  );
}

function Sessions() {
  const [view, setView] = useState<SessionsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (getToken() === null) return;
    void authed<SessionsView>('/account/sessions')
      .then(setView)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'could not load your sessions'),
      );
  }, []);

  useEffect(load, [load]);

  async function act(path: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await authed(path, { method: 'POST' });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="text-md font-bold">Where you are signed in</h2>
      <p className="text-sm text-text-muted">
        If you see something here you do not recognise, end it — then change your password.
      </p>

      {view?.freeze.active === true && (
        <p className="mt-3 rounded-lg border border-caution/50 bg-caution/10 px-3 py-2 text-sm">
          <span className="font-semibold">Withdrawals are paused</span> until{' '}
          {view.freeze.until === null ? 'shortly' : dateTime(view.freeze.until)}. This happens
          automatically after your contact details change, so that nobody who takes over your number
          can move money before you notice.
        </p>
      )}

      {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}

      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {(view?.sessions ?? []).map((session) => (
          <li key={session.id} className="flex items-start justify-between gap-4 p-4">
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold">
                {describe(session.userAgent)}
                {session.current && (
                  <span className="ml-2 rounded-full bg-rise-bg px-2 py-0.5 text-xs font-bold text-rise">
                    this device
                  </span>
                )}
              </span>
              <span className="mt-0.5 block font-mono text-xs text-text-muted">
                {session.ip} · last seen {dateTime(session.lastSeenAt)}
              </span>
            </span>
            {!session.current && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(`/account/sessions/${session.id}/revoke`)}
                className="h-11 shrink-0 rounded-md border border-border px-3 text-sm font-semibold hover:border-text disabled:opacity-40"
              >
                End
              </button>
            )}
          </li>
        ))}
        {view !== null && view.sessions.length === 0 && (
          <li className="p-4 text-sm text-text-muted">
            Nothing recorded yet. Sessions appear from your next sign-in.
          </li>
        )}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('/account/sessions/revoke-others')}
          className="h-11 rounded-md border border-border px-3 text-sm font-semibold hover:border-text disabled:opacity-40"
        >
          Sign out everywhere else
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('/account/lock')}
          className="h-11 rounded-md border border-fall/50 px-3 text-sm font-semibold text-fall hover:border-fall disabled:opacity-40"
        >
          This wasn&rsquo;t me — lock the account
        </button>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Locking ends every session and pauses withdrawals for a week. Support can lift it once they
        have spoken to you.
      </p>
    </section>
  );
}

/** "Chrome on Android" out of a user-agent string. Best effort, never wrong-confident. */
function describe(agent: string): string {
  const browser = /Firefox/.test(agent)
    ? 'Firefox'
    : /Edg\//.test(agent)
      ? 'Edge'
      : /Chrome/.test(agent)
        ? 'Chrome'
        : /Safari/.test(agent)
          ? 'Safari'
          : 'Browser';

  const platform = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iPhone'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS/.test(agent)
          ? 'Mac'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'unknown device';

  return `${browser} on ${platform}`;
}

function Referrals() {
  const [view, setView] = useState<ReferralsView | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (getToken() === null) return;
    void authed<ReferralsView>('/account/referrals')
      .then(setView)
      .catch(() => undefined);
  }, []);

  if (view === null) return null;

  const link =
    typeof window === 'undefined' ? '' : `${window.location.origin}/signup?ref=${view.code}`;

  return (
    <section className="mt-8">
      <h2 className="text-md font-bold">Bring people in</h2>
      <p className="text-sm text-text-muted">
        You are paid when somebody you invited verifies their contact and places their first stake —
        not when they sign up. That is deliberate: it keeps the programme honest.
      </p>

      <div className="mt-3 rounded-xl border border-border p-4">
        <p className="font-mono text-2xl font-bold tracking-[.2em]">{view.code}</p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
          className="mt-2 h-11 rounded-md border border-border px-3 text-sm font-semibold hover:border-text"
        >
          {copied ? 'Link copied' : 'Copy your link'}
        </button>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-text-muted">Invited</dt>
            <dd className="font-mono text-base font-bold">{view.invited}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Qualified</dt>
            <dd className="font-mono text-base font-bold">{view.qualified}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Earned</dt>
            <dd className="font-mono text-base font-bold text-money">{money(view.earned)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Consents() {
  const [view, setView] = useState<ConsentsView | null>(null);

  const load = useCallback(() => {
    if (getToken() === null) return;
    void authed<ConsentsView>('/account/consents')
      .then(setView)
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  async function set(document: string, accepted: boolean): Promise<void> {
    await authed('/account/consents', {
      method: 'POST',
      body: JSON.stringify({ document, accepted }),
    });
    load();
  }

  if (view === null) return null;

  return (
    <section className="mt-8">
      <h2 className="text-md font-bold">What you agreed to</h2>
      <p className="text-sm text-text-muted">
        Recorded per version. If a document changes in a way that matters, you will be asked again
        rather than assumed to have agreed.
      </p>

      {view.outstanding.length > 0 && (
        <div className="mt-3 rounded-lg border border-caution/50 bg-caution/10 p-3 text-sm">
          <p className="font-semibold">There is a newer version of some documents.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {view.outstanding.map((document) => (
              <button
                key={document}
                type="button"
                onClick={() => void set(document, true)}
                className="h-11 rounded-md bg-brand px-3 text-sm font-bold text-paper"
              >
                Accept the {document}
              </button>
            ))}
          </div>
        </div>
      )}

      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {view.history.map((entry) => (
          <li
            key={`${entry.document}:${entry.version}`}
            className="flex items-baseline justify-between gap-4 p-3 text-sm"
          >
            <span className="capitalize">
              {entry.document.replace('_', ' ')}{' '}
              <span className="font-mono text-xs text-text-muted">v{entry.version}</span>
            </span>
            <span className="font-mono text-xs text-text-muted">{dateTime(entry.acceptedAt)}</span>
          </li>
        ))}
      </ul>

      {/*
        NDPA: marketing is a separate, freely withdrawable consent and is never
        bundled into accepting the terms.
      */}
      <label className="mt-3 flex items-start gap-3 rounded-lg border border-border p-3">
        <input
          type="checkbox"
          checked={view.marketing}
          onChange={(event) => void set('marketing', event.target.checked)}
          className="mt-0.5 size-4 accent-brand"
        />
        <span className="text-sm">
          <span className="font-semibold">Send me things about new markets and prizes.</span>
          <span className="mt-0.5 block text-text-muted">
            Separate from the terms, and you can turn it off here at any time.
          </span>
        </span>
      </label>
    </section>
  );
}
