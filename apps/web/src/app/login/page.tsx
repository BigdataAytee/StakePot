'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { API_URL } from '@/lib/api';
import { setToken } from '@/lib/session';

/** §2.1 — "Login: password or OTP; JWT sessions." Password today. */
export default function LoginPage() {
  const router = useRouter();
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact: contact.trim(), password }),
      });
      const payload = (await response.json().catch(() => null)) as {
        accessToken?: string;
        message?: unknown;
      } | null;

      if (!response.ok || payload?.accessToken === undefined) {
        // Deliberately the same sentence whether the account is unknown or the
        // password is wrong: distinguishing them turns the login form into a
        // tool for discovering who has an account here.
        throw new Error(
          typeof payload?.message === 'string' && payload.message.length > 0
            ? payload.message
            : 'those details did not match',
        );
      }

      setToken(payload.accessToken);
      router.push('/markets');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'those details did not match');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-black leading-none">Welcome back</h1>
      <p className="mt-2 text-md text-text-muted">Pick up where you left off.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Email or phone</span>
          <input
            required
            autoFocus
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            autoComplete="username"
            className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-md outline-none focus-visible:border-rise"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">Password</span>
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className="rounded-md border border-border bg-surface-raised px-3 py-2.5 text-md outline-none focus-visible:border-rise"
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

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-md bg-rise px-4 py-3 text-md font-black text-paper transition-transform active:scale-press disabled:opacity-50"
        >
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-text-muted">
        New here?{' '}
        <Link href="/signup" className="font-bold underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}
