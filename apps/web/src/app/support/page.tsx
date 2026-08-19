'use client';

import { useEffect, useState } from 'react';
import { SiteFooter } from '@/components/site-footer';

import { API_URL } from '@/lib/api';
import { PageShell } from '@/components/market/page-shell';

interface Ticket {
  id: string;
  subject: string;
  category: string;
  state: string;
  slaDue: string;
  createdAt: string;
  messages: { id: string; authorId: string; body: string; createdAt: string }[];
}

const CATEGORIES = [
  { id: 'payout_query', label: 'A payout' },
  { id: 'dispute', label: 'A result I disagree with' },
  { id: 'account', label: 'My account' },
  { id: 'rg_request', label: 'Limits or taking a break' },
  { id: 'other', label: 'Something else' },
] as const;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const token = window.localStorage.getItem('stakeam.token');
  if (token === null) throw new Error('Sign in to see your tickets.');

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
 * Support (§2.12).
 *
 * One screen: what you have already asked, and a box to ask something new. The
 * category is not bureaucracy — it sets how fast the desk has promised to
 * answer, so it is worth picking honestly.
 */
export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['id']>('payout_query');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    void call<Ticket[]>('/account/tickets')
      .then(setTickets)
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await call('/account/tickets', { category, subject, body });
      setSubject('');
      setBody('');
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell width="narrow">
      <h1 className="text-xl font-black">Support</h1>
      <p className="mt-2 text-md text-text-muted">
        Tell us what happened and we will come back to you. Payout questions get the fastest answer;
        anything about limits or taking a break is handled faster still.
      </p>

      <section className="mt-6 space-y-3">
        <label className="block text-sm font-semibold">
          What is it about?
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as typeof category)}
            className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2.5"
          >
            {CATEGORIES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="One line: what is wrong?"
          aria-label="Subject"
          className="w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-rise"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          placeholder="What happened, and when?"
          aria-label="What happened"
          className="w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-rise"
        />

        {error !== null && <p className="text-sm text-fall">{error}</p>}

        <button
          type="button"
          disabled={busy || subject.trim().length < 5 || body.trim().length < 10}
          onClick={() => void submit()}
          className="w-full rounded-md bg-rise py-3 font-bold text-paper transition-transform active:scale-press disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send it'}
        </button>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Your tickets</h2>
        {tickets.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">Nothing open.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="rounded-md border border-border p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold">{ticket.subject}</h3>
                  <span className="font-mono text-xs uppercase text-text-muted">
                    {ticket.state.replace(/_/g, ' ')}
                  </span>
                </div>
                <ol className="mt-3 space-y-2">
                  {ticket.messages.map((message) => (
                    <li key={message.id} className="border-l border-border pl-3">
                      <p className="font-mono text-xs text-text-muted">
                        {new Date(message.createdAt).toLocaleString('en-NG')}
                      </p>
                      <p className="text-sm">{message.body}</p>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>
      <SiteFooter />
    </PageShell>
  );
}
