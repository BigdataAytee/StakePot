'use client';

import { useEffect, useState } from 'react';

import { API_URL, type MarketDetail } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { getToken } from '@/lib/session';

/**
 * What has been proposed, and how long is left to argue with it (§7.2f, §2.6).
 *
 * Two things were missing here and they belong together. The ticket never said
 * a resolution had been proposed at all — a market simply stopped trading and
 * went quiet for 48 hours. And although the API has accepted disputes since
 * Phase 3, no screen ever posted one, so staff could decide disputes that no
 * participant had any way to raise. A window nobody can see is not a window.
 *
 * The countdown ticks locally off the server's deadline rather than polling:
 * the number that matters is "how long have I got", and asking the server
 * every second to redraw a clock is traffic for nothing.
 */
export function ResolutionStatus({ market }: { market: MarketDetail }) {
  const proposal = market.resolution;
  if (proposal === null) return null;

  const proposed = market.outcomes.find((row) => row.id === proposal.proposedOutcomeId);
  const settled = proposal.finalizedAt !== null;

  return (
    <section className="mt-4 rounded-xl border border-border p-4">
      <h2 className="text-xs font-semibold uppercase tracking-[.05em] text-text-muted">
        {settled ? 'Final resolution' : 'Proposed resolution'}
      </h2>

      <p className="mt-2 text-md font-semibold">
        {proposed?.label ?? 'Outcome pending'}
        {settled ? '' : ' — proposed, not yet final'}
      </p>

      <p className="mt-1 text-sm text-text-muted">
        Proposed {dateTime(proposal.proposedAt)}
        {proposal.evidenceUrl !== null && (
          <>
            {' · '}
            <a
              href={proposal.evidenceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-brand underline"
            >
              evidence
            </a>
          </>
        )}
      </p>

      {!settled && market.disputeClosesAt !== null && (
        <DisputeWindow marketId={market.id} closesAt={market.disputeClosesAt} />
      )}
    </section>
  );
}

function DisputeWindow({ marketId, closesAt }: { marketId: string; closesAt: string }) {
  const left = useCountdown(closesAt);
  const open = left !== null;

  if (!open) {
    return (
      <p className="mt-3 rounded-md bg-chip p-3 text-sm text-text-muted">
        The dispute window has closed. Payouts settle once the result is confirmed.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-md bg-chip p-3">
      <p className="text-sm">
        <span className="font-semibold">{left}</span> left to dispute this.
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Only evidence from the market&rsquo;s named source counts (Rulebook Part 1 §5).
      </p>
      <DisputeForm marketId={marketId} />
    </div>
  );
}

/** "23h 14m" — a length, because what matters is how long you have. */
function useCountdown(iso: string): string | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Started after mount so the server's render and the first client paint do
    // not disagree about the second.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (now === null) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function DisputeForm({ marketId }: { marketId: string }) {
  const [open, setOpen] = useState(false);
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'filed'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = getToken();
    if (token === null) {
      setError('Sign in to file a dispute.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      const response = await fetch(`${API_URL}/community/markets/${marketId}/disputes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ evidenceUrl, text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Could not file that (${response.status})`);
      }
      setState('filed');
    } catch (caught) {
      setError((caught as Error).message);
      setState('idle');
    }
  }

  if (state === 'filed') {
    return (
      <p className="mt-2 text-sm text-rise">
        Filed. A resolver will review it before anything pays out.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-semibold hover:border-text"
      >
        Dispute this
      </button>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-2">
      <label className="text-sm font-semibold" htmlFor="dispute-url">
        Link to the source
      </label>
      <input
        id="dispute-url"
        type="url"
        required
        value={evidenceUrl}
        onChange={(event) => setEvidenceUrl(event.target.value)}
        placeholder="https://…"
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm focus:border-brand"
      />
      <label className="text-sm font-semibold" htmlFor="dispute-text">
        What does it say that the proposal does not?
      </label>
      <textarea
        id="dispute-text"
        required
        rows={3}
        maxLength={1000}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-2 text-sm focus:border-brand"
      />
      {error !== null && <p className="text-sm text-fall">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={state === 'sending'}
          className="rounded-md bg-brand px-3 py-2 text-sm font-bold text-paper disabled:opacity-45"
        >
          {state === 'sending' ? 'Filing…' : 'File dispute'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-2 text-sm font-semibold text-text-muted hover:text-text"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
