'use client';

import { useState } from 'react';

import { API_URL } from '@/lib/api';
import { getToken } from '@/lib/session';
import { SITE_URL } from '@/lib/site';

/**
 * "I'm YES at 60% — prove me wrong" (§2.15d, §7.2f).
 *
 * The challenge service and the landing route have both existed since Phase 5;
 * what was missing was any way to mint one. A feature reachable only by
 * calling the API yourself is not a feature, and this is the one §2.15d calls
 * "the strongest signup motivator" — so it is a button on the ticket, beside
 * share, where somebody who has just taken a side is standing.
 */
export function ChallengeButton({ marketId }: { marketId: string }) {
  const [state, setState] = useState<'idle' | 'minting' | 'copied' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function mint() {
    const token = getToken();
    if (token === null) {
      setState('error');
      setMessage('Sign in and take a side first.');
      return;
    }

    setState('minting');
    try {
      const response = await fetch(`${API_URL}/markets/${marketId}/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        // The usual refusal is "you hold no position" — §2.15d's challenge
        // carries the challenger's side, so there has to be one.
        throw new Error(body.message ?? 'Could not make a challenge link');
      }
      const { token: link } = (await response.json()) as { token: string };
      const url = `${SITE_URL}/challenge/${link}`;

      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setState('copied');
      setMessage(url);
    } catch (caught) {
      setState('error');
      setMessage((caught as Error).message);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void mint()}
        disabled={state === 'minting'}
        className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold text-text-muted hover:border-text hover:text-text disabled:opacity-45"
      >
        {state === 'minting' ? 'Making…' : state === 'copied' ? 'Link copied' : 'Challenge'}
      </button>
      {message !== null && state === 'error' && (
        <p className="absolute right-0 top-10 z-10 w-56 rounded-md border border-border bg-surface p-2 text-xs text-fall shadow-lifted">
          {message}
        </p>
      )}
    </div>
  );
}
