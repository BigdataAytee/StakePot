'use client';

import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import { admin, type QueueMarket } from '@/lib/admin-api';
import { money } from '@/lib/format';

/**
 * §6.3's resolution centre, as the work-queue pattern §6.10 asks for.
 *
 * "Items presented one-at-a-time with full context on a single screen — the
 * market's rules, the evidence, the AI score, the history — decision buttons
 * fixed bottom-right, auto-advance to the next item."
 *
 * The screen is deliberately dense with *context* and thin on controls: an
 * operator confirming a result should be reading the market's own written rules
 * and the named source, not hunting for them in another tab.
 */
export default function ResolutionCentre() {
  const [queue, setQueue] = useState<QueueMarket[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    void admin
      .resolutionQueue()
      .then((items) => {
        setQueue(items);
        setIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
      })
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  const market = queue[index];

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && queue.length === 0) return <p className="text-sm text-fall">{error}</p>;
  if (market === undefined) {
    return (
      <div>
        <h1 className="text-lg font-black">Resolution centre</h1>
        <p className="mt-2 text-sm text-text-muted">Queue clear. Nothing is waiting on a result.</p>
      </div>
    );
  }

  const criteria = (market.criteria ?? {}) as Record<string, string>;
  const proposedOutcome = market.outcomes.find((o) => o.id === market.proposal?.proposedOutcomeId);
  const openDisputes = market.disputes.filter((d) => d.state === 'open');

  return (
    <div className="space-y-5 pb-24">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-black">Resolution centre</h1>
          <p className="mt-1 font-mono text-xs text-text-muted">
            item {index + 1} of {queue.length} · {market.shelf} · {market.state}
          </p>
        </div>
        <div className="flex gap-2 font-mono text-xs">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded-sm border border-border px-2 py-1 disabled:opacity-30"
          >
            prev
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(queue.length - 1, i + 1))}
            disabled={index >= queue.length - 1}
            className="rounded-sm border border-border px-2 py-1 disabled:opacity-30"
          >
            next
          </button>
        </div>
      </header>

      <h2 className="text-md font-bold">{market.question}</h2>

      <div className="grid grid-cols-2 gap-5">
        {/* The market's own rules — the thing the decision must be made against. */}
        <section className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">How this settles</h3>
          <dl className="mt-2 space-y-2 text-sm">
            {market.outcomes.map((outcome) => (
              <div key={outcome.id}>
                <dt className="font-semibold">{outcome.label}</dt>
                <dd className="text-text-muted">{criteria[outcome.label] ?? '—'}</dd>
                <dd className="font-mono text-xs text-text-muted">
                  staked {money(outcome.staked)} · {Math.round(Number(outcome.price) * 100)}%
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 font-mono text-xs text-text-muted">
            pot {money(market.pot)} · voids {new Date(market.voidDate).toLocaleDateString('en-NG')}
          </p>
          <a
            href={market.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-sm text-rise underline underline-offset-2"
          >
            {market.sourceName} <ExternalLink size={12} />
          </a>
        </section>

        {/* The claim, and anything filed against it. */}
        <section className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Proposed result</h3>
          {market.proposal === null ? (
            <ProposeForm market={market} busy={busy} onSubmit={act} />
          ) : (
            <div className="mt-2 space-y-2 text-sm">
              <p>
                <span className="font-bold">{proposedOutcome?.label ?? 'unknown outcome'}</span>{' '}
                <span className="text-text-muted">
                  by {market.proposal.proposedBy.slice(0, 8)}… on{' '}
                  {new Date(market.proposal.proposedAt).toLocaleString('en-NG')}
                </span>
              </p>
              <a
                href={market.proposal.evidenceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-rise underline underline-offset-2"
              >
                evidence <ExternalLink size={12} />
              </a>
              <p className="font-mono text-xs text-text-muted">
                {market.disputeClosesAt === null
                  ? 'no window'
                  : market.windowClosed
                    ? 'dispute window closed'
                    : `window closes ${new Date(market.disputeClosesAt).toLocaleString('en-NG')}`}
              </p>
            </div>
          )}

          {market.disputes.length > 0 && (
            <div className="mt-4 space-y-3 border-t border-border pt-3">
              <h4 className="text-sm font-semibold">Disputes</h4>
              {market.disputes.map((dispute) => (
                <DisputeCard key={dispute.id} dispute={dispute} busy={busy} onSubmit={act} />
              ))}
            </div>
          )}
        </section>
      </div>

      <DossierPanel market={market} onChanged={load} />

      {market.proposal !== null && (
        <FinalizeBar market={market} busy={busy} blocked={openDisputes.length > 0} onSubmit={act} />
      )}

      {error !== null && <p className="text-sm text-fall">{error}</p>}
    </div>
  );
}

function ProposeForm({
  market,
  busy,
  onSubmit,
}: {
  market: QueueMarket;
  busy: boolean;
  onSubmit: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [outcomeId, setOutcomeId] = useState(market.outcomes[0]?.id ?? '');
  const [evidenceUrl, setEvidenceUrl] = useState('');

  return (
    <div className="mt-2 space-y-2">
      <p className="text-sm text-text-muted">
        No result proposed yet. Posting one opens the dispute window; it pays out nothing.
      </p>
      <select
        value={outcomeId}
        onChange={(event) => setOutcomeId(event.target.value)}
        aria-label="Winning outcome"
        className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
      >
        {market.outcomes.map((outcome) => (
          <option key={outcome.id} value={outcome.id}>
            {outcome.label}
          </option>
        ))}
      </select>
      <input
        value={evidenceUrl}
        onChange={(event) => setEvidenceUrl(event.target.value)}
        placeholder="https://source-link"
        aria-label="Evidence link"
        className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-xs"
      />
      <button
        type="button"
        disabled={busy || evidenceUrl === ''}
        onClick={() => void onSubmit(() => admin.propose(market.id, outcomeId, evidenceUrl))}
        className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
      >
        Post proposed result
      </button>
    </div>
  );
}

function DisputeCard({
  dispute,
  busy,
  onSubmit,
}: {
  dispute: QueueMarket['disputes'][number];
  busy: boolean;
  onSubmit: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [decision, setDecision] = useState('');

  return (
    <article className="rounded-sm border border-border p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs text-text-muted">{dispute.userId.slice(0, 8)}…</span>
        <span
          className={`font-mono text-xs uppercase ${
            dispute.state === 'open' ? 'text-caution' : 'text-text-muted'
          }`}
        >
          {dispute.state}
        </span>
      </div>
      <p className="mt-1.5">{dispute.text}</p>
      <a
        href={dispute.evidenceUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-xs text-rise underline underline-offset-2"
      >
        their evidence <ExternalLink size={11} />
      </a>

      {dispute.state === 'open' ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
            rows={2}
            placeholder="Reasoning — this is the licensing exhibit."
            className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || decision.trim().length < 10}
              onClick={() =>
                void onSubmit(() => admin.decideDispute(dispute.id, true, decision.trim()))
              }
              className="rounded-sm border border-caution px-2 py-1 text-xs font-bold text-caution disabled:opacity-30"
            >
              Uphold
            </button>
            <button
              type="button"
              disabled={busy || decision.trim().length < 10}
              onClick={() =>
                void onSubmit(() => admin.decideDispute(dispute.id, false, decision.trim()))
              }
              className="rounded-sm border border-border px-2 py-1 text-xs disabled:opacity-30"
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        dispute.decision !== null && (
          <p className="mt-2 text-xs text-text-muted">{dispute.decision}</p>
        )
      )}
    </article>
  );
}

/** §6.10: decision buttons fixed bottom-right, one keystroke from done. */
function FinalizeBar({
  market,
  busy,
  blocked,
  onSubmit,
}: {
  market: QueueMarket;
  busy: boolean;
  blocked: boolean;
  onSubmit: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [outcomeId, setOutcomeId] = useState(
    market.proposal?.proposedOutcomeId ?? market.outcomes[0]?.id ?? '',
  );
  const [reasoning, setReasoning] = useState('');

  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface-raised px-5 py-3">
      <div className="flex items-end gap-3">
        <label className="text-xs text-text-muted">
          Final outcome
          <select
            value={outcomeId}
            onChange={(event) => setOutcomeId(event.target.value)}
            className="mt-1 block w-48 rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-text"
          >
            {market.outcomes.map((outcome) => (
              <option key={outcome.id} value={outcome.id}>
                {outcome.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-xs text-text-muted">
          Reasoning
          <input
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
            placeholder="What the named source says, and why this is the result."
            className="mt-1 block w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm text-text"
          />
        </label>
        <button
          type="button"
          disabled={busy || blocked || reasoning.trim().length < 10}
          onClick={() =>
            void onSubmit(() => admin.finalize(market.id, outcomeId, reasoning.trim()))
          }
          className="rounded-sm bg-rise px-4 py-2 text-sm font-bold text-paper disabled:opacity-40"
        >
          {blocked ? 'Decide the disputes first' : 'Post final result & pay out'}
        </button>
      </div>
      <p className="mt-1.5 font-mono text-xs text-text-muted">
        You cannot confirm a result you proposed — someone else does, or nobody is checking.
      </p>
    </div>
  );
}

/**
 * What the research layer makes of this market — advisory, and labelled as such.
 *
 * It sits *below* the propose/confirm controls on purpose. A dossier that
 * appeared above them would read as the answer, with the human controls as
 * confirmation of it; the order here says the opposite, which is the true
 * relationship. Nothing on this panel can settle anything: the endpoints behind
 * it read a row, write a row, and record that somebody looked.
 *
 * The two buttons are the accountability trail rather than a decision. A
 * reading nobody ever contradicted is indistinguishable from a reading nobody
 * read, and the engine only improves if the difference is recorded.
 */
function DossierPanel({ market, onChanged }: { market: QueueMarket; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dossier = market.dossier;

  async function run(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const named = market.outcomes.find((o) => o.id === dossier?.proposedOutcomeId);

  return (
    <section className="rounded-md border border-dashed border-border p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">Research dossier</h3>
        <span className="rounded-sm bg-border px-1.5 py-0.5 font-mono text-fine font-bold uppercase text-text-muted">
          advisory
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => admin.buildDossier(market.id))}
          className="ml-auto rounded-sm border border-border px-2.5 py-1 text-xs font-semibold disabled:opacity-40"
        >
          {dossier === null ? 'Build' : 'Rebuild'}
        </button>
      </div>

      {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}

      {dossier === null ? (
        <p className="mt-2 text-sm text-text-muted">
          {/* "Nobody built one" and "one was built and found nothing" are
              different facts, and only the second says anything about the
              market. */}
          No dossier has been built for this market. Building one reads what the pipeline has
          collected; it cannot propose or settle.
        </p>
      ) : (
        <div className="mt-2 space-y-2.5 text-sm">
          <p>
            {dossier.recommendVoid ? (
              <span className="font-bold text-caution">Review for a void</span>
            ) : (
              <span className="font-bold">{named?.label ?? 'No outcome named'}</span>
            )}{' '}
            <span className="font-mono text-xs text-text-muted">
              confidence {Math.round(dossier.confidence * 100)}% · built{' '}
              {new Date(dossier.builtAt).toLocaleString('en-NG')}
            </span>
          </p>

          <p className="text-text-muted">{dossier.reasoning}</p>

          {dossier.conflicts.length > 0 && (
            <ul className="space-y-1">
              {dossier.conflicts.map((conflict) => (
                <li
                  key={conflict.factKey}
                  className="rounded-md bg-caution-bg px-2 py-1.5 text-xs text-caution"
                >
                  {/* Flagged, never averaged. The criteria have to name which
                      source settles it before anybody proposes. */}
                  <b className="font-mono">{conflict.factKey}</b> —{' '}
                  {conflict.claims
                    .map((claim) => `${claim.sourceName} says ${String(claim.value)}`)
                    .join('; ')}
                </li>
              ))}
            </ul>
          )}

          {dossier.evidence.length > 0 && (
            <ul className="space-y-1 text-xs">
              {dossier.evidence.slice(0, 8).map((item) => (
                <li key={item.url}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-start gap-1 hover:underline"
                  >
                    {item.headline}
                    <ExternalLink size={11} className="mt-0.5 shrink-0 opacity-60" />
                  </a>{' '}
                  <span className="text-text-muted">
                    {item.sourceName} · {item.publishedAt.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {dossier.reviewedAt === null ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
              <span className="text-xs text-text-muted">Did this reading match yours?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => admin.recordDossierDecision(market.id, true))}
                className="rounded-sm border border-border px-2.5 py-1 text-xs font-semibold disabled:opacity-40"
              >
                It matched
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => admin.recordDossierDecision(market.id, false))}
                className="rounded-sm border border-border px-2.5 py-1 text-xs font-semibold disabled:opacity-40"
              >
                It was wrong
              </button>
            </div>
          ) : (
            <p className="border-t border-border pt-2.5 font-mono text-xs text-text-muted">
              Marked {dossier.accepted === true ? 'matching' : 'wrong'} on{' '}
              {new Date(dossier.reviewedAt).toLocaleString('en-NG')}.
            </p>
          )}

          <p className="text-xs text-text-muted">
            {/* Said on the screen, not only in the code. */}
            Nothing here settles the market. That still takes one person proposing with a source
            link and a second confirming, after the dispute window.
          </p>
        </div>
      )}
    </section>
  );
}
