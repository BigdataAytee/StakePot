'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { API_URL } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { PasswordField } from '@/components/password-field';
import { money } from '@/lib/format';
import { setToken } from '@/lib/session';
import { usePublicConfig } from '@/lib/public-config';

/**
 * §2.1 Tier 0 — "signup with email **or** phone + password... Age attestation
 * (18+) checkbox", in ten seconds.
 *
 * One field for the contact, not two. Asking a Nigerian user to first classify
 * their own identifier as email-or-phone before typing it is a step that buys
 * nothing: an `@` says which one it is. That single decision is most of the
 * ten seconds.
 */
export default function SignupPage() {
  const router = useRouter();
  const config = usePublicConfig();
  // §2.17: `?ref=CODE` off a shared link. Read once, on the client, because
  // the whole page is client-rendered and a Suspense boundary for one query
  // parameter would cost more than it saves.
  const [referralCode, setReferralCode] = useState('');
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref');
    if (code !== null) setReferralCode(code.trim().toUpperCase());
  }, []);
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [ageAttested, setAgeAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const looksLikeEmail = contact.includes('@');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`${API_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(looksLikeEmail ? { email: contact.trim() } : { phone: contact.trim() }),
          password,
          ageAttested,
          // A wrong code is ignored server-side rather than refused — a bad
          // link must never be the reason somebody cannot open an account.
          ...(referralCode.trim().length === 0 ? {} : { referralCode: referralCode.trim() }),
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        accessToken?: string;
        message?: unknown;
      } | null;

      if (!response.ok || payload?.accessToken === undefined) {
        const message = Array.isArray(payload?.message)
          ? String(payload.message[0])
          : typeof payload?.message === 'string'
            ? payload.message
            : 'that signup did not go through';
        throw new Error(message);
      }

      setToken(payload.accessToken);
      // Into the product, not onto a checkpoint. §2.1's Tier 0 is "friction-free
      // entry" — the starter balance is already spendable on both shelves, and
      // a code box between somebody and the thing they just signed up for reads
      // as a wall whether or not it is one. Verification is invited from the
      // header and required where money leaves; it is not the price of entry.
      router.push('/markets');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that signup did not go through');
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-2xl font-black leading-none">Create your account</h1>
      <p className="mt-2 text-md text-text-muted">
        Ten seconds.{' '}
        {config === null
          ? 'You get a starter balance to trade with — no card, no deposit.'
          : `You get ${money(config.starterBalanceSpc)} to start — no card, no deposit.`}
      </p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Email or phone</span>
          <input
            required
            autoFocus
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            placeholder="you@example.com or 08031234567"
            autoComplete="username"
            className="rounded-md border border-border bg-surface-raised px-3 py-3 text-md outline-none focus-visible:border-rise"
          />
          <span className="font-mono text-xs text-text-muted">
            {contact.length === 0
              ? 'Whichever you actually check — the code goes there.'
              : looksLikeEmail
                ? 'Signing up with email.'
                : 'Signing up with phone.'}
          </span>
        </label>

        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={10}
          hint="At least 10 characters."
        />

        {referralCode !== '' && (
          <p className="rounded-md border border-rise/40 bg-rise-bg px-3 py-2 text-sm">
            You were invited with code <span className="font-mono font-bold">{referralCode}</span>.
            Whoever sent it is paid once you verify your contact and place a first stake — nothing
            comes out of your balance.
          </p>
        )}

        {/*
          A 16px checkbox gating the only button on the screen is the kind of
          thing that reads fine on a desktop and is genuinely hard to hit with a
          thumb. The whole row is the target now, and the box itself clears the
          44px minimum.
        */}
        <label className="-mx-2 flex min-h-[3rem] cursor-pointer items-center gap-3 rounded-md px-2 py-2">
          <input
            type="checkbox"
            checked={ageAttested}
            onChange={(event) => setAgeAttested(event.target.checked)}
            className="h-6 w-6 shrink-0 accent-rise"
          />
          <span className="text-sm">
            I am 18 or older, and I have read the{' '}
            <Link href="/rules" className="underline">
              rules
            </Link>
            .
          </span>
        </label>

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-fall bg-surface-raised px-3 py-2 text-sm text-fall"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !ageAttested}
          className="mt-2 min-h-[3rem] rounded-md bg-rise px-4 py-3 text-md font-black text-paper transition-transform active:scale-press disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-sm text-text-muted">
        Already have one?{' '}
        <Link href="/login" className="inline-block py-2 font-bold underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  );
}
