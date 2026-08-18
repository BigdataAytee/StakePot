'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { API_URL } from '@/lib/api';
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
      router.push('/verify');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that signup did not go through');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
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
            className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-md outline-none focus-visible:border-rise"
          />
          <span className="font-mono text-xs text-text-muted">
            {contact.length === 0
              ? 'Whichever you actually check — the code goes there.'
              : looksLikeEmail
                ? 'Signing up with email.'
                : 'Signing up with phone.'}
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Password</span>
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={10}
            autoComplete="new-password"
            className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-md outline-none focus-visible:border-rise"
          />
          <span className="font-mono text-xs text-text-muted">At least 10 characters.</span>
        </label>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={ageAttested}
            onChange={(event) => setAgeAttested(event.target.checked)}
            className="mt-1 h-4 w-4 accent-rise"
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
          className="mt-2 rounded-md bg-rise px-4 py-3 text-md font-black text-paper transition-transform active:scale-press disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-sm text-text-muted">
        Already have one?{' '}
        <Link href="/login" className="font-bold underline">
          Log in
        </Link>
      </p>
    </main>
  );
}
