'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AuthShell } from '@/components/auth-shell';
import { money } from '@/lib/format';
import { usePublicConfig } from '@/lib/public-config';
import { authed, getToken, useSession } from '@/lib/session';

/**
 * §2.1 Tier 1 — "confirm ownership of the signup email/phone (OTP or link).
 * Unlocks full signup bonus, market creation, leaderboards, and prize
 * eligibility."
 *
 * The screen states what verifying is *for* rather than just demanding a code.
 * Tier 1 is the anti-farming gate, so the person being asked deserves to know
 * they are buying something with the thirty seconds.
 */
export default function VerifyPage() {
  const router = useRouter();
  const config = usePublicConfig();
  const { me, loading, refresh } = useSession();

  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requested = useRef(false);

  // No token at all means this page cannot do its job — send them to sign up.
  useEffect(() => {
    if (!loading && getToken() === null) router.replace('/signup');
  }, [loading, router]);

  // Already verified: nothing to do here, and leaving them staring at a code
  // box for an account that is past this step would just be confusing.
  useEffect(() => {
    if (me !== null && me.contactVerified) router.replace('/markets');
  }, [me, router]);

  const send = useCallback(
    async function send() {
      setError(null);
      setNotice(null);
      try {
        const result = await authed<{
          sent?: boolean;
          contact?: string;
          alreadyVerified?: boolean;
        }>('/auth/verify/request', {});
        if (result.alreadyVerified === true) {
          await refresh();
          return;
        }
        setSentTo(result.contact ?? null);
        setNotice('Code sent.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'could not send a code');
      }
    },
    [refresh],
  );

  // Send the first code automatically. A screen that asks for a code it has
  // not sent yet is a screen nobody can complete.
  useEffect(() => {
    if (loading || me === null || me.contactVerified || requested.current) return;
    requested.current = true;
    void send();
  }, [loading, me, send]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await authed('/auth/verify/confirm', { code: code.trim() });
      await refresh();
      router.push('/markets');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that code is not right');
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-black leading-none">Confirm your contact</h1>
      <p className="mt-2 text-md text-text-muted">
        {sentTo === null
          ? 'We are sending you a six-digit code.'
          : `We sent a six-digit code to ${sentTo}.`}
      </p>

      <ul className="mt-4 flex flex-col gap-1.5 text-sm text-text-muted">
        <li>
          • Unlocks{' '}
          <span className="text-money">
            {config === null ? 'the full signup bonus' : money(config.signupBonusSpc)}
          </span>{' '}
          on top of your starter balance
        </li>
        <li>• Lets you open your own markets</li>
        <li>• Puts you on the leaderboard and in prize draws</li>
      </ul>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Six-digit code</span>
          <input
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            className="rounded-md border border-border bg-surface-raised px-3 py-3 text-center font-mono text-xl tracking-[0.3em] tabular-nums outline-none focus-visible:border-rise"
          />
        </label>

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-fall bg-surface-raised px-3 py-2 text-sm text-fall"
          >
            {error}
          </p>
        )}
        {notice !== null && error === null && (
          <p className="font-mono text-xs text-text-muted">{notice}</p>
        )}

        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="min-h-[3rem] rounded-md bg-rise px-4 py-3 text-md font-black text-paper transition-transform active:scale-press disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Verify'}
        </button>

        <button
          type="button"
          onClick={() => void send()}
          className="min-h-[3rem] text-sm text-text-muted underline"
        >
          Send another code
        </button>
      </form>

      <p className="mt-6 text-sm text-text-muted">
        You can{' '}
        <Link href="/markets" className="font-bold underline">
          look around first
        </Link>{' '}
        — your starter balance already works.
      </p>
    </AuthShell>
  );
}
