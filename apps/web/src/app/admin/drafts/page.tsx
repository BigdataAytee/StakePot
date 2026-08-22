'use client';

import { ExternalLink, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { admin, type DraftRow, type StudioAnswers } from '@/lib/admin-api';

/**
 * §6.2's drafts queue.
 *
 * "Fed by the AI drafts queue (§2.9: ranked, scored, one-click open
 * pre-filled)." The one thing this screen must never become is a publish
 * button with a spinner in front of it, so the whole template is on the page —
 * the question, every outcome's settlement criteria, the source, the dates —
 * and the refusals are one toggle away, because what the engine turned down is
 * how you tell whether it is behaving.
 */
export default function DraftsQueue() {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [showRefused, setShowRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The checklist questions only a person can answer, per draft. Held here
  // rather than sent blank: `openFromDraft` re-runs the whole checklist and
  // refuses while any of them is unanswered, so a queue that posted an empty
  // object would show the operator a refusal instead of a market.
  const [answers, setAnswers] = useState<Record<string, StudioAnswers>>({});

  const load = (includeRejected = showRefused): void => {
    void admin
      .drafts(includeRejected)
      .then(setDrafts)
      .catch((caught: Error) => setError(caught.message));
  };

  // Reloads when the refusals toggle changes; `load` is re-created each render,
  // so it is deliberately not a dependency.
  useEffect(() => {
    void admin
      .drafts(showRefused)
      .then(setDrafts)
      .catch((caught: Error) => setError(caught.message));
  }, [showRefused]);

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await action();
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-black">Drafts</h1>
          <p className="mt-1 text-sm text-text-muted">
            The engine suggests; you open. Nothing here is live, and nothing here goes live without
            this click.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 font-mono text-xs text-text-muted">
            <input
              type="checkbox"
              checked={showRefused}
              onChange={(event) => setShowRefused(event.target.checked)}
            />
            show what it refused
          </label>
          <button
            type="button"
            disabled={busy === 'generate'}
            onClick={() => void act('generate', () => admin.generateDrafts())}
            className="flex items-center gap-1.5 rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
          >
            <Sparkles size={14} />
            {busy === 'generate' ? 'Drafting…' : 'Draft a cycle'}
          </button>
        </div>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {drafts.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing waiting. The shelf may already be full — the engine only drafts for free slots.
        </p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className={`rounded-md border p-4 ${
                draft.state === 'rejected' ? 'border-border opacity-70' : 'border-border'
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-md font-bold">
                  {/*
                    §6.2: "first-time creators always flagged for human
                    review". The flag was filed on every draft and shown on
                    none, which made the rule true in the database and
                    invisible at the desk where it has to change what somebody
                    does. These sort to the top of the queue too.
                  */}
                  {draft.firstMarket && (
                    <span className="mr-2 rounded-full bg-caution/20 px-2 py-0.5 align-middle text-xs font-bold uppercase tracking-wide text-caution">
                      First market
                    </span>
                  )}
                  {draft.question}
                </h2>
                <span className="whitespace-nowrap font-mono text-xs text-text-muted">
                  {draft.slot ?? draft.source} · score{' '}
                  <span className="text-money">{draft.score.toFixed(2)}</span>
                </span>
              </div>

              <p className="mt-1 text-sm text-text-muted">{draft.rationale}</p>

              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <h3 className="font-mono text-xs uppercase text-text-muted">Outcomes</h3>
                  <ul className="mt-1 space-y-1">
                    {draft.template.outcomes.map((outcome) => (
                      <li key={outcome.label}>
                        <span className="font-semibold">{outcome.label}</span>{' '}
                        <span className="text-text-muted">{outcome.criteria}</span>
                      </li>
                    ))}
                  </ul>
                  {draft.estimates.length > 0 && (
                    <p className="mt-2 font-mono text-xs text-text-muted">
                      estimate {draft.estimates.map((value) => Math.round(value * 100)).join('/')}
                    </p>
                  )}
                </div>
                <div className="font-mono text-xs text-text-muted">
                  <a
                    href={draft.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-rise underline underline-offset-2"
                  >
                    {draft.sourceName} <ExternalLink size={11} />
                  </a>
                  <p className="mt-1">
                    event {new Date(draft.eventDate).toLocaleDateString('en-NG')} · voids{' '}
                    {new Date(draft.voidDate).toLocaleDateString('en-NG')}
                  </p>
                  <p className="mt-1">engagement {Math.round(draft.engagement * 100)}%</p>
                </div>
              </div>

              {draft.refusals.length > 0 && (
                <ul className="mt-3 space-y-1 border-l border-fall pl-3 text-sm text-fall">
                  {draft.refusals.map((refusal) => (
                    <li key={refusal}>{refusal}</li>
                  ))}
                </ul>
              )}

              {draft.state === 'suggested' && (
                <SignOff
                  answers={answers[draft.id]}
                  onChange={(next) => setAnswers((current) => ({ ...current, [draft.id]: next }))}
                />
              )}

              {draft.state === 'suggested' && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy === draft.id || !signedOff(answers[draft.id])}
                    onClick={() =>
                      void act(draft.id, () => admin.openDraft(draft.id, answers[draft.id] ?? {}))
                    }
                    className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
                  >
                    Open it
                  </button>
                  <input
                    value={notes[draft.id] ?? ''}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [draft.id]: event.target.value }))
                    }
                    placeholder="Why not? Kept on the record."
                    aria-label={`Reason for refusing ${draft.question}`}
                    className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={busy === draft.id || (notes[draft.id] ?? '').trim().length < 5}
                    onClick={() =>
                      void act(draft.id, () =>
                        admin.rejectDraft(draft.id, (notes[draft.id] ?? '').trim()),
                      )
                    }
                    className="rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-30"
                  >
                    Pass
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Whether this draft has been signed off well enough to publish.
 *
 * The conflict check is the one whose "yes" is the bad answer: wanting a side
 * to win is the conflict, and the checklist's remedy is to hand the market to
 * somebody else rather than to note it and carry on.
 */
function signedOff(answers: StudioAnswers | undefined): boolean {
  if (answers?.attestedNoInfluence !== true) return false;
  const given = answers.confirmations ?? {};
  return given['18'] === true && given['25'] === true && given['R3'] === false;
}

/**
 * The four things a person has to answer before a draft becomes a market.
 *
 * Rendered here, on the queue, rather than behind an "are you sure" — the
 * questions are the review. A confirmation dialogue that says "publish this
 * market?" asks nothing; these ask four specific things the checklist says
 * software cannot decide.
 */
function SignOff({
  answers,
  onChange,
}: {
  answers: StudioAnswers | undefined;
  onChange: (next: StudioAnswers) => void;
}) {
  const given = answers?.confirmations ?? {};
  const set = (rule: string, value: boolean): void =>
    onChange({
      attestedNoInfluence: answers?.attestedNoInfluence ?? false,
      confirmations: { ...given, [rule]: value },
    });

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-surface p-3 text-sm">
      <p className="text-fine font-semibold uppercase tracking-[.05em] text-text-muted">
        Before it opens
      </p>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={answers?.attestedNoInfluence === true}
          onChange={(event) =>
            onChange({ attestedNoInfluence: event.target.checked, confirmations: given })
          }
        />
        <span>
          <b>Rules 5 &amp; 16.</b> Nobody trading this — including me — can affect the outcome or
          holds inside knowledge of it.
        </span>
      </label>

      {/*
        Each question maps its own press to its own stored answer, spelled out
        rather than routed through a shared "is this the good answer" helper.
        The first version had one: it took a `want` prop, computed
        `pressed === want`, and the caller then negated it again — so pressing
        the *right* answer to the front-page test stored the wrong one and the
        publish button stayed dark with no explanation. Three questions do not
        need an abstraction, and this one was inverting itself.
      */}
      <Question
        rule="18"
        text="Would this embarrass us if it were screenshotted onto the front page?"
        // Confirmed means "no, it would not" — so a "No" press stores true.
        pressed={given['18'] === undefined ? undefined : !given['18']}
        onPress={(yes) => set('18', !yes)}
      />
      <Question
        rule="25"
        text="Could somebody with no context resolve this using only the page and the named source?"
        pressed={given['25']}
        onPress={(yes) => set('25', yes)}
      />
      <Question
        rule="R3"
        text="Do you want a particular side to win?"
        // The one where "yes" is the bad answer: the checklist's remedy is to
        // hand the market to somebody else, and the validator refuses on it.
        pressed={given['R3']}
        onPress={(yes) => set('R3', yes)}
      />
    </div>
  );
}

/**
 * One yes/no question, storing exactly what was pressed.
 *
 * No notion of a "correct" answer lives here. Two of the three questions want
 * a "no" — the front-page test and the conflict check — and a component that
 * knew which was which would render them all as "tick to confirm", which has a
 * reviewer ticking a box beside "would this embarrass us?" instead of reading
 * it.
 */
function Question({
  rule,
  text,
  pressed,
  onPress,
}: {
  rule: string;
  text: string;
  pressed: boolean | undefined;
  onPress: (yes: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-text-muted">Rule {rule}</span>
      <span className="flex-1">{text}</span>
      <span className="flex gap-1">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={pressed === value}
            onClick={() => onPress(value)}
            className={`rounded-sm border px-2.5 py-1 text-xs font-bold ${
              pressed === value ? 'border-brand bg-brand text-paper' : 'border-border hover:bg-chip'
            }`}
          >
            {value ? 'Yes' : 'No'}
          </button>
        ))}
      </span>
    </div>
  );
}
