'use client';

import { AlertTriangle, Check, ChevronDown, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Finding, RuleReport } from '@stakeam/rules';

import { ChanceGauge } from '@/components/market/chance-gauge';
import { ArgumentBar } from '@/components/argument-bar';
import { admin, type SettlingSource, type StudioDraft } from '@/lib/admin-api';
import { ANCHORS, STEPS, STEP_TITLE, rulesOn, type StepKey } from './wizard-anchors';

/**
 * The Studio's create wizard.
 *
 * Three short steps and a review, where there used to be five long ones. The
 * change is not that fewer rules are enforced — every validator in
 * `packages/rules` still runs, server-side, on review and again on publish,
 * and `__tests__/wizard-anchors.test.ts` fails the build if any rule loses the
 * field that answers for it. What changed is that the rules stopped being
 * *read out*.
 *
 * The old screen printed the checklist beside every step: forty numbered lines
 * of law, which is why it read like a compliance form and why the person
 * filling it in learned to scroll past the part that was supposed to stop them.
 * Here a rule appears in exactly one circumstance — its own field, currently
 * failing — as the single sentence the validator itself produced. Nothing is
 * restated, so the screen cannot say something the enforcement does not.
 *
 * Most of them never appear at all, because the input makes them true:
 *
 *   - rule 26 (state the timezone) — the settle field is stamped WAT and the
 *     hour is required by the control, so there is no way to write a time
 *     without one;
 *   - rule 2 (a void date, after the event) — the picker cannot select a date
 *     before the settle date and defaults to thirty days after it;
 *   - rule 1 (name the body) — the source is a list of registered settling
 *     sources, and "widely reported" is not on it;
 *   - rule R2 (the exact page) — a URL field that says so, and rejects a bare
 *     domain the moment it loses focus;
 *   - rule 3 (an "Any other" bucket) — added by the outcome builder itself as
 *     soon as there is a third outcome;
 *   - rule 4 (edge cases) — four defaults, pre-ticked, so the common market
 *     needs no typing here at all.
 *
 * Designing a rule out of reach beats explaining it. What is left is the
 * handful that need a person: the wording, and the three judgement calls,
 * which are asked once, at review, about a market that actually exists.
 */

/** The four edge cases rule 4 wants answered on every market, with its defaults. */
const EDGE_DEFAULTS: readonly { key: string; label: string; answer: string }[] = [
  {
    key: 'postponed',
    label: 'Postponed past the void date',
    answer: 'The market voids and everyone is refunded.',
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    answer: 'The market voids and everyone is refunded.',
  },
  {
    // Rule 4 singles this one out: every market has a source, so every market
    // can meet a source that says nothing, and it is the case most often left
    // out. The validator refuses a draft without it.
    key: 'no publication',
    label: 'The source publishes nothing',
    answer: 'The market voids and everyone is refunded.',
  },
  {
    key: 'revised',
    label: 'The figure is revised later',
    answer: 'The first published figure governs. Revisions are ignored.',
  },
];

const THIRTY_DAYS = 30 * 86_400_000;

/** The settle instant, written the way rule 26 wants to read it. */
function watStamp(iso: string): string {
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return '';
  return `${when.toLocaleString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} WAT on ${when.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;
}

/**
 * What settles a Yes/No market, written from the source and the settle time.
 *
 * This is how rule 26 gets designed away rather than explained. The rule wants
 * the timezone stated *in the wording* — the validator reads the question and
 * the outcome criteria, not the form — so a WAT badge stuck on the input would
 * have satisfied nobody, and the old wizard's answer was a line of red text
 * telling staff to type "WAT" into a textarea themselves.
 *
 * Instead the criteria are composed from the two fields that already say it:
 * the source, and the instant the settle picker holds. Rule 3's "say what makes
 * this the result" and rule 26's timezone both come out true, and neither has
 * anything to tell anybody.
 *
 * Only for the untouched binary default. The moment somebody opens the outcome
 * builder and edits, their words stand — the derived text is a starting point,
 * not an override.
 */
function derivedCriteria(draft: StudioDraft): StudioDraft['outcomes'] | null {
  if (draft.outcomes.length !== 2) return null;
  const stamp = watStamp(draft.eventDate);
  const source = draft.sourceName.trim();
  if (stamp === '' || source === '') return null;

  const [yes, no] = draft.outcomes;
  if (yes === undefined || no === undefined) return null;
  return [
    { ...yes, criteria: `${source} confirms this as at ${stamp}.` },
    { ...no, criteria: `${source} does not confirm this as at ${stamp}.` },
  ];
}

function blankDraft(): StudioDraft {
  return {
    question: '',
    outcomes: [
      { label: 'Yes', criteria: '' },
      { label: 'No', criteria: '' },
    ],
    sourceName: '',
    sourceUrl: '',
    eventDate: '',
    voidDate: '',
    edgeCases: Object.fromEntries(EDGE_DEFAULTS.map((edge) => [edge.key, edge.answer])),
    liquidityParam: '50000',
    expectedStake: '2000',
  };
}

export function CreateTab({ seed }: { seed?: StudioDraft | undefined } = {}) {
  const [step, setStep] = useState<StepKey>('question');
  // Seeded when the Library hands over a repeat. The whole checklist still
  // runs: a market that ran fine last quarter is exactly the one nobody
  // re-reads.
  const [draft, setDraft] = useState<StudioDraft>(seed ?? blankDraft);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [attested, setAttested] = useState(false);
  const [report, setReport] = useState<RuleReport | null>(null);
  const [warningsAccepted, setWarningsAccepted] = useState(false);
  const [warningReason, setWarningReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<SettlingSource[]>([]);
  // False until somebody edits an outcome by hand. While it holds, the criteria
  // are rewritten from the source and the settle time on every change.
  const [criteriaTouched, setCriteriaTouched] = useState(seed !== undefined);

  useEffect(() => {
    void admin
      .settlingSources()
      .then(setSources)
      // A registry that will not load is not a reason to block a draft: the
      // field falls back to free text and rule 1's validator still runs.
      .catch(() => setSources([]));
  }, []);

  // Keep the default binary criteria in step with the source and settle time.
  useEffect(() => {
    if (criteriaTouched) return;
    const next = derivedCriteria(draft);
    if (next === null) return;
    if (next.every((outcome, index) => outcome.criteria === draft.outcomes[index]?.criteria))
      return;
    setDraft((current) => ({ ...current, outcomes: next }));
  }, [criteriaTouched, draft]);

  const check = useCallback(async (): Promise<void> => {
    if (draft.question.trim().length === 0) return;
    try {
      setReport(
        await admin.studioReview(draft, { attestedNoInfluence: attested, confirmations: answers }),
      );
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [draft, attested, answers]);

  // Debounced rather than per keystroke: the review is a round trip that runs a
  // duplicate search across the live shelf, and firing it per character would
  // make typing a question the heaviest thing the database does.
  useEffect(() => {
    const timer = setTimeout(() => void check(), 600);
    return () => clearTimeout(timer);
  }, [check]);

  const patch = useCallback((next: Partial<StudioDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  /** Jump to the field a failing rule belongs to, and put the cursor in it. */
  function goTo(rule: string): void {
    const anchor = ANCHORS[rule];
    if (anchor === undefined) return;
    setStep(anchor.step);
    // After the step has rendered. A ref would be tidier and would need one per
    // field across four components; the id is already there for the label.
    setTimeout(() => {
      const element = document.getElementById(anchor.field);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    }, 60);
  }

  async function publish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await admin.studioPublish(draft, {
        attestedNoInfluence: attested,
        confirmations: answers,
        ...(warningReason.trim().length > 0 ? { warningReason: warningReason.trim() } : {}),
      });
      setPublished(result.marketId);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (published !== null) {
    return (
      <div className="rounded-xl border border-rise bg-rise/[.06] p-4">
        <h2 className="font-bold">The market is open.</h2>
        <p className="mt-1 text-sm text-text-muted">
          Seeded flat by the platform and live on the official shelf.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`/market/${published}`}
            className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper"
          >
            See it as a trader does
          </a>
          <button
            type="button"
            onClick={() => {
              setPublished(null);
              setDraft(blankDraft());
              setAnswers({});
              setAttested(false);
              setReport(null);
              setWarningsAccepted(false);
              setWarningReason('');
              setStep('question');
            }}
            className="rounded-sm border border-border px-3 py-1.5 text-sm"
          >
            Write another
          </button>
        </div>
      </div>
    );
  }

  const index = STEPS.indexOf(step);
  const shared = { draft, patch, report, error };

  return (
    <div className="space-y-4">
      <StepDots current={step} onJump={setStep} />

      <h2 className="text-xl font-black tracking-tight">{STEP_TITLE[step]}</h2>

      {error !== null && (
        <p role="alert" className="text-sm text-fall">
          {error}
        </p>
      )}

      {step === 'question' && (
        <QuestionStep {...shared} onEditOutcomes={() => setCriteriaTouched(true)} />
      )}
      {step === 'settles' && <SettlesStep {...shared} sources={sources} />}
      {step === 'unusual' && <UnusualStep {...shared} attested={attested} onAttest={setAttested} />}
      {step === 'review' && (
        <ReviewStep
          draft={draft}
          report={report}
          answers={answers}
          onAnswer={(rule, value) => setAnswers((current) => ({ ...current, [rule]: value }))}
          warningsAccepted={warningsAccepted}
          onAcceptWarnings={setWarningsAccepted}
          warningReason={warningReason}
          onWarningReason={setWarningReason}
          onFix={goTo}
          onPublish={() => void publish()}
          busy={busy}
        />
      )}

      {/* Pinned where a thumb reaches. The step is one screen; the way off it
          should not be a scroll away. */}
      {step !== 'review' && (
        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-border bg-surface px-4 py-3 sm:mx-0 sm:rounded-b-xl sm:px-0">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setStep(STEPS[index - 1] as StepKey)}
              className="rounded-md border border-border px-4 py-2.5 text-sm font-semibold"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => setStep(STEPS[index + 1] as StepKey)}
            className="flex-1 rounded-md bg-brand px-4 py-2.5 text-sm font-bold text-paper"
          >
            {index === STEPS.length - 2 ? 'Review it' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Four dots.
 *
 * Not a tab bar with five labels that no longer fits across a phone. The dot
 * says where you are and how much is left, which is the only thing progress
 * has to say; the heading below it says what this step is.
 */
function StepDots({ current, onJump }: { current: StepKey; onJump: (step: StepKey) => void }) {
  const at = STEPS.indexOf(current);
  return (
    <nav aria-label="Steps" className="flex items-center gap-2">
      {STEPS.map((step, index) => (
        <button
          key={step}
          type="button"
          onClick={() => onJump(step)}
          aria-label={`Step ${index + 1}: ${STEP_TITLE[step]}`}
          aria-current={step === current ? 'step' : undefined}
          className={`h-2 rounded-full transition-all ${
            index === at
              ? 'w-8 bg-brand'
              : index < at
                ? 'w-2 bg-brand/45 hover:bg-brand/70'
                : 'w-2 bg-border hover:bg-text-muted/40'
          }`}
        />
      ))}
      <span className="ml-auto font-mono text-fine uppercase tracking-widest text-text-muted">
        {at + 1} of {STEPS.length}
      </span>
    </nav>
  );
}

interface StepProps {
  draft: StudioDraft;
  patch: (next: Partial<StudioDraft>) => void;
  report: RuleReport | null;
  error: string | null;
}

/**
 * Step 1. One box.
 *
 * The outcomes sit under it, collapsed to a line of text, because the answer to
 * almost every market is Yes or No and a market whose answers are Yes and No
 * has nothing to configure. Opening the builder is a deliberate act by somebody
 * writing a three-way race, and it is the builder — not the person — that
 * remembers rule 3's "Any other".
 */
function QuestionStep({
  draft,
  patch,
  report,
  onEditOutcomes,
}: StepProps & { onEditOutcomes: () => void }) {
  const [open, setOpen] = useState(draft.outcomes.length > 2);
  const [thinking, setThinking] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);

  const binary = draft.outcomes.length === 2;

  async function tidy(): Promise<void> {
    if (draft.question.trim().length < 8) return;
    setThinking(true);
    setCopilotError(null);
    try {
      const written = await admin.copilot(draft.question);
      patch({
        question: written.question,
        outcomes: written.outcomes,
        ...(written.otherLabel === undefined ? {} : { otherLabel: written.otherLabel }),
        ...(written.sourceName === '' ? {} : { sourceName: written.sourceName }),
        ...(written.sourceUrl === '' ? {} : { sourceUrl: written.sourceUrl }),
        ...(written.eventDate === '' ? {} : { eventDate: written.eventDate }),
        ...(written.voidDate === '' ? {} : { voidDate: written.voidDate }),
      });
      if (written.outcomes.length > 2) setOpen(true);
    } catch (caught) {
      setCopilotError((caught as Error).message);
    } finally {
      setThinking(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        id="question"
        value={draft.question}
        onChange={(event) => patch({ question: event.target.value })}
        rows={4}
        aria-label="The question"
        className="w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-base leading-snug"
        placeholder="Will year-on-year headline CPI, as first published by the NBS, print below 24.5% for August?"
      />
      <FieldNote report={report} rules={rulesOn('question', 'question')} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void tidy()}
          disabled={thinking || draft.question.trim().length < 8}
          className="flex items-center gap-1.5 rounded-md border border-brand px-3 py-1.5 text-sm font-semibold text-brand disabled:opacity-35"
        >
          <Sparkles size={14} />
          {thinking ? 'Rewriting…' : 'Tidy this up'}
        </button>
        <span className="text-xs text-text-muted">
          Turns a rough idea into wording a stranger could settle.
        </span>
      </div>
      {copilotError !== null && <p className="text-xs text-fall">{copilotError}</p>}

      {/* The answers, as a sentence until somebody needs otherwise. */}
      {!open ? (
        <div
          id="outcomes"
          tabIndex={-1}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-chip px-3 py-2 text-sm"
        >
          <span className="text-text-muted">Two answers:</span>
          <b>{draft.outcomes.map((outcome) => outcome.label).join(' / ')}</b>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              patch({
                outcomes: [...draft.outcomes, { label: '', criteria: '' }],
                otherLabel: 'Any other',
              });
            }}
            className="ml-auto font-semibold text-brand"
          >
            More than two?
          </button>
        </div>
      ) : (
        <OutcomeBuilder
          draft={draft}
          patch={patch}
          onEdit={onEditOutcomes}
          onBinary={() => {
            setOpen(false);
            patch({
              outcomes: [
                { label: 'Yes', criteria: draft.outcomes[0]?.criteria ?? '' },
                { label: 'No', criteria: draft.outcomes[1]?.criteria ?? '' },
              ],
              otherLabel: undefined,
            });
          }}
        />
      )}
      {!binary && <FieldNote report={report} rules={rulesOn('question', 'outcomes')} />}
    </div>
  );
}

/**
 * The outcome builder, which keeps rule 3 for you.
 *
 * "Any other" is added the moment there is a third outcome and removed when
 * there is not — the checklist calls it a non-negotiable, and a non-negotiable
 * that depends on somebody ticking a box is a non-negotiable with a hole in it.
 */
function OutcomeBuilder({
  draft,
  patch,
  onBinary,
  onEdit,
}: {
  draft: StudioDraft;
  patch: (next: Partial<StudioDraft>) => void;
  onBinary: () => void;
  /** Hands the criteria over: from here on they are the operator's words. */
  onEdit: () => void;
}) {
  function setOutcomes(outcomes: StudioDraft['outcomes']): void {
    onEdit();
    patch({
      outcomes,
      // More than two runners means the field can be finished outside the list.
      otherLabel: outcomes.length > 2 ? (draft.otherLabel ?? 'Any other') : undefined,
    });
  }

  return (
    <div id="outcomes" tabIndex={-1} className="space-y-2">
      {draft.outcomes.map((outcome, index) => (
        <div key={index} className="rounded-md border border-border bg-surface p-2.5">
          <div className="flex items-center gap-2">
            <input
              value={outcome.label}
              onChange={(event) =>
                setOutcomes(
                  draft.outcomes.map((row, at) =>
                    at === index ? { ...row, label: event.target.value } : row,
                  ),
                )
              }
              aria-label={`Answer ${index + 1}`}
              placeholder={`Answer ${index + 1}`}
              className="flex-1 rounded-sm border border-border bg-surface-raised px-2 py-1.5 text-sm font-semibold"
            />
            {draft.outcomes.length > 2 && (
              <button
                type="button"
                aria-label={`Remove answer ${index + 1}`}
                onClick={() => setOutcomes(draft.outcomes.filter((_, at) => at !== index))}
                className="text-text-muted hover:text-fall"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
          <textarea
            value={outcome.criteria}
            onChange={(event) =>
              setOutcomes(
                draft.outcomes.map((row, at) =>
                  at === index ? { ...row, criteria: event.target.value } : row,
                ),
              )
            }
            rows={2}
            aria-label={`What makes ${outcome.label || `answer ${index + 1}`} the result`}
            placeholder="What makes this the result, per the source."
            className="mt-1.5 w-full rounded-sm border border-border bg-surface-raised px-2 py-1.5 text-sm"
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setOutcomes([...draft.outcomes, { label: '', criteria: '' }])}
          className="flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5"
        >
          <Plus size={14} /> Another answer
        </button>
        {draft.otherLabel !== undefined && (
          <span className="rounded-sm bg-chip px-2 py-1 text-xs text-text-muted">
            “{draft.otherLabel}” added — every result has somewhere to go
          </span>
        )}
        <button
          type="button"
          onClick={onBinary}
          className="ml-auto text-xs text-text-muted underline"
        >
          back to Yes / No
        </button>
      </div>
    </div>
  );
}

/**
 * Step 2. Three fields, and the rules built into them.
 *
 * The settle control is a `datetime-local` with WAT stamped on it, so rule 26
 * has nothing to say. The void control cannot be set before the settle date and
 * arrives pre-filled thirty days after it, so rule 2 is satisfied on arrival.
 * The source is a list; the page is a URL that says it wants a page.
 */
function SettlesStep({
  draft,
  patch,
  report,
  sources,
}: StepProps & { sources: readonly SettlingSource[] }) {
  const [urlTouched, setUrlTouched] = useState(false);
  const known = sources.some((source) => source.name === draft.sourceName);

  /** A URL with nothing after the host is the site, not the page (rule R2). */
  const bareDomain = useMemo(() => {
    const url = draft.sourceUrl.trim();
    if (url === '') return false;
    try {
      const path = new URL(url).pathname;
      return path === '' || path === '/';
    } catch {
      return true;
    }
  }, [draft.sourceUrl]);

  function setEvent(local: string): void {
    if (local === '') {
      patch({ eventDate: '' });
      return;
    }
    const when = new Date(local);
    // Rule 2 without a sentence about rule 2: a void date arrives, already
    // after the event, and the picker below will not let it move before it.
    const voidBy =
      draft.voidDate === '' || new Date(draft.voidDate) <= when
        ? new Date(when.getTime() + THIRTY_DAYS).toISOString()
        : draft.voidDate;
    patch({ eventDate: when.toISOString(), voidDate: voidBy });
  }

  const settlesAs =
    draft.outcomes.length === 2 && (draft.outcomes[0]?.criteria ?? '') !== ''
      ? (draft.outcomes[0]?.criteria ?? null)
      : null;

  const eventLocal = draft.eventDate === '' ? '' : toLocal(draft.eventDate);
  const voidFloor =
    draft.eventDate === ''
      ? undefined
      : toLocal(new Date(new Date(draft.eventDate).getTime() + 3_600_000).toISOString());

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-semibold">Who settles it</span>
        <input
          id="source"
          list="settling-sources"
          value={draft.sourceName}
          onChange={(event) => patch({ sourceName: event.target.value })}
          placeholder="National Bureau of Statistics"
          className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-base"
        />
        <datalist id="settling-sources">
          {sources.map((source) => (
            <option key={source.id} value={source.name} />
          ))}
        </datalist>
      </label>
      {draft.sourceName.trim() !== '' && !known && sources.length > 0 && (
        <p className="-mt-2.5 text-xs text-caution">
          Not a registered settling source. Add it under Research first, or pick one from the list.
        </p>
      )}
      <FieldNote report={report} rules={rulesOn('settles', 'source')} />

      <label className="block">
        <span className="text-sm font-semibold">The page that will settle it</span>
        <input
          id="sourceUrl"
          type="url"
          inputMode="url"
          value={draft.sourceUrl}
          onBlur={() => setUrlTouched(true)}
          onChange={(event) => patch({ sourceUrl: event.target.value })}
          placeholder="https://nigerianstat.gov.ng/elibrary/read/1241"
          className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm"
        />
      </label>
      {urlTouched && bareDomain ? (
        <p className="-mt-2.5 text-xs text-fall">
          That is the site. Link the page the figure will appear on.
        </p>
      ) : (
        <FieldNote report={report} rules={rulesOn('settles', 'sourceUrl')} />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-semibold">Trading stops</span>
          {/* WAT lives in the furniture, not in a rule under the field. */}
          <span className="mt-1.5 flex items-center rounded-md border border-border bg-surface pr-3 focus-within:border-brand">
            <input
              id="eventDate"
              type="datetime-local"
              value={eventLocal}
              onChange={(event) => setEvent(event.target.value)}
              // `min-w-0` because a native datetime control has an intrinsic
              // width wider than a 390px column, and without it the WAT stamp
              // beside it is pushed off the edge — losing the one piece of
              // furniture that satisfies rule 26.
              className="w-full min-w-0 bg-transparent px-3 py-2.5 text-sm outline-none"
            />
            <span className="font-mono text-xs font-bold text-text-muted">WAT</span>
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-semibold">Refund everyone by</span>
          <span className="mt-1.5 flex items-center rounded-md border border-border bg-surface pr-3 focus-within:border-brand">
            <input
              id="voidDate"
              type="datetime-local"
              value={draft.voidDate === '' ? '' : toLocal(draft.voidDate)}
              min={voidFloor}
              onChange={(event) =>
                patch({
                  voidDate:
                    event.target.value === '' ? '' : new Date(event.target.value).toISOString(),
                })
              }
              className="w-full min-w-0 bg-transparent px-3 py-2.5 text-sm outline-none"
            />
            <span className="font-mono text-xs font-bold text-text-muted">WAT</span>
          </span>
        </label>
      </div>
      <FieldNote
        report={report}
        rules={[...rulesOn('settles', 'eventDate'), ...rulesOn('settles', 'voidDate')]}
      />

      {/* What the two fields above just wrote into the market's settlement
          criteria. Shown, not hidden: text composed on somebody's behalf and
          never put in front of them is text they will find out about at
          resolution. */}
      {settlesAs !== null && (
        <p className="rounded-md bg-chip px-3 py-2 text-xs text-text-muted">
          Settles as <b className="text-text">“{settlesAs}”</b> — edit the answers on step one to
          say it differently.
        </p>
      )}
    </div>
  );
}

/**
 * Step 3. Tap, don't write.
 *
 * Rule 4 wants six or seven edge cases mapped. Asked as a textarea it got one,
 * or none. Asked as four pre-ticked lines with the answer already on them, the
 * common market needs no typing at all — and the creator is reading four
 * decisions rather than composing them, which is the difference between "what
 * else could go wrong" and "is any of this wrong".
 *
 * Rules 5 and 16 are one toggle rather than two paragraphs: they are the same
 * promise from two directions, and asking twice taught people to tick twice.
 */
function UnusualStep({
  draft,
  patch,
  report,
  attested,
  onAttest,
}: StepProps & { attested: boolean; onAttest: (value: boolean) => void }) {
  const [extra, setExtra] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const cases = draft.edgeCases;

  function toggle(key: string, answer: string, on: boolean): void {
    const next = { ...cases };
    if (on) next[key] = answer;
    else delete next[key];
    patch({ edgeCases: next });
  }

  function addExtra(): void {
    const at = extra.indexOf(':');
    if (at <= 0) return;
    const key = extra.slice(0, at).trim();
    const value = extra.slice(at + 1).trim();
    if (key === '' || value === '') return;
    patch({ edgeCases: { ...cases, [key]: value } });
    setExtra('');
  }

  const custom = Object.keys(cases).filter(
    (key) => !EDGE_DEFAULTS.some((edge) => edge.key === key),
  );

  return (
    <div className="space-y-4">
      <fieldset id="edgeCases" tabIndex={-1}>
        <legend className="text-sm font-semibold">If things go sideways</legend>
        <div className="mt-1.5 divide-y divide-border overflow-hidden rounded-md border border-border bg-surface">
          {EDGE_DEFAULTS.map((edge) => (
            <label key={edge.key} className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5">
              <input
                type="checkbox"
                checked={cases[edge.key] !== undefined}
                onChange={(event) => toggle(edge.key, edge.answer, event.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm">
                {edge.label}
                <span className="block text-xs text-text-muted">{edge.answer}</span>
              </span>
            </label>
          ))}
          {custom.map((key) => (
            <div key={key} className="flex items-start gap-2.5 px-3 py-2.5">
              <Check size={14} className="mt-1 shrink-0 text-rise" />
              <span className="flex-1 text-sm">
                {key}
                <span className="block text-xs text-text-muted">{cases[key]}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove the "${key}" case`}
                onClick={() => toggle(key, '', false)}
                className="text-text-muted hover:text-fall"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addExtra();
              }
            }}
            placeholder="Anything else — “abandoned: settles on the replay”"
            aria-label="Another edge case"
            className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addExtra}
            className="rounded-md border border-border px-3 py-2 text-sm font-semibold"
          >
            Add
          </button>
        </div>
      </fieldset>
      <FieldNote report={report} rules={rulesOn('unusual', 'edgeCases')} />

      <label
        htmlFor="attestation"
        className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface p-3.5"
      >
        <input
          id="attestation"
          type="checkbox"
          checked={attested}
          onChange={(event) => onAttest(event.target.checked)}
          className="h-5 w-5 shrink-0"
        />
        <span className="text-sm font-medium">
          I can’t influence this outcome and have no inside information.
        </span>
      </label>
      <FieldNote report={report} rules={rulesOn('unusual', 'attestation')} />

      {/* Sizing and the card. Defaulted, so most markets never open this. */}
      <div className="rounded-md border border-border bg-surface">
        <button
          type="button"
          onClick={() => setAdvanced((open) => !open)}
          aria-expanded={advanced}
          className="flex w-full items-center gap-2 px-3.5 py-2.5 text-sm font-semibold"
        >
          <ChevronDown
            size={15}
            className={`transition-transform ${advanced ? 'rotate-180' : ''}`}
          />
          Size and how the card looks
          <span className="ml-auto font-mono text-fine uppercase tracking-widest text-text-muted">
            defaults set
          </span>
        </button>

        {advanced && (
          <div className="space-y-3 border-t border-border px-3.5 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold">Typical stake you expect</span>
                <input
                  id="expectedStake"
                  value={draft.expectedStake ?? ''}
                  onChange={(event) => patch({ expectedStake: event.target.value })}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold">Liquidity L</span>
                <input
                  id="liquidityParam"
                  value={draft.liquidityParam ?? ''}
                  onChange={(event) => patch({ liquidityParam: event.target.value })}
                  inputMode="numeric"
                  className="mt-1 w-full rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-sm"
                />
              </label>
            </div>
            <FieldNote report={report} rules={rulesOn('unusual', 'liquidityParam')} />

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="text-xs font-semibold">Category</span>
                <input
                  id="category"
                  value={draft.category ?? ''}
                  onChange={(event) => patch({ category: event.target.value })}
                  className="mt-1 w-full rounded-md border border-border bg-surface-raised px-2.5 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold">Tags</span>
                <input
                  value={(draft.tags ?? []).join(', ')}
                  onChange={(event) =>
                    patch({
                      tags: event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter((tag) => tag.length > 0),
                    })
                  }
                  className="mt-1 w-full rounded-md border border-border bg-surface-raised px-2.5 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold">Icon</span>
                <input
                  value={draft.icon ?? ''}
                  onChange={(event) => patch({ icon: event.target.value })}
                  className="mt-1 w-full rounded-md border border-border bg-surface-raised px-2.5 py-2 text-sm"
                />
              </label>
            </div>
            <FieldNote report={report} rules={rulesOn('unusual', 'category')} />

            <label className="flex items-center gap-2 text-sm">
              <input
                id="newsFlow"
                type="checkbox"
                checked={draft.blockbuster === true}
                onChange={(event) => patch({ blockbuster: event.target.checked })}
              />
              A blockbuster — an election or a tournament, allowed to run long
            </label>
            <FieldNote report={report} rules={rulesOn('unusual', 'newsFlow')} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The review screen.
 *
 * The market first, exactly as a trader will meet it — because the question
 * that matters here is not "did forty validators pass" but "is this the market
 * I meant to open", and that one is answered by looking at it.
 *
 * Then the verdict, as a strip: three counts and a row per thing that needs
 * attention. Passing rules are not printed. A list of thirty green ticks is
 * not reassurance, it is the thing a reviewer learns to scroll past, and the
 * two amber rows in the middle of it go past with them.
 *
 * Every row that can be fixed is a button back to the field that causes it.
 */
function ReviewStep({
  draft,
  report,
  answers,
  onAnswer,
  warningsAccepted,
  onAcceptWarnings,
  warningReason,
  onWarningReason,
  onFix,
  onPublish,
  busy,
}: {
  draft: StudioDraft;
  report: RuleReport | null;
  answers: Record<string, boolean>;
  onAnswer: (rule: string, value: boolean) => void;
  warningsAccepted: boolean;
  onAcceptWarnings: (value: boolean) => void;
  warningReason: string;
  onWarningReason: (value: string) => void;
  onFix: (rule: string) => void;
  onPublish: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const warnings = report?.warnings.length ?? 0;
  const needsReason = warnings > 0 && (!warningsAccepted || warningReason.trim().length < 5);
  const blocked = report === null || report.blocked || needsReason;

  return (
    <div className="space-y-4">
      <Preview draft={draft} />

      {report === null ? (
        <p className="rounded-xl border border-border bg-surface-raised p-4 text-sm text-text-muted">
          Write the question and the checklist runs against it.
        </p>
      ) : (
        <VerdictStrip report={report} expanded={expanded} onExpand={setExpanded} onFix={onFix} />
      )}

      {/* The two questions software cannot answer, asked once, about a market
          that now exists on the screen above. */}
      <div className="space-y-2">
        <Judgement
          id="judgement-25"
          question="Could a stranger settle this using only this page and the source?"
          yes="Yes"
          no="Let me re-read it"
          answer={answers['25']}
          onAnswer={(value) => onAnswer('25', value)}
        />
        {/* Rule 18 is the front-page test, and its validator passes on `true`.
            The checklist words it as "would this embarrass us", which is a
            question whose good answer is "no" — a shape that gets misread at
            speed. Asked the other way round the good answer is "yes", and the
            value sent is the same one the rule wants. */}
        <Judgement
          id="judgement-18"
          question="Happy for this to be screenshotted?"
          yes="Yes"
          no="Rethink"
          answer={answers['18']}
          onAnswer={(value) => onAnswer('18', value)}
        />
        <Judgement
          id="judgement-R3"
          question="Are you hoping one side wins?"
          yes="Yes — hand it on"
          no="No"
          answer={answers['R3']}
          onAnswer={(value) => onAnswer('R3', value)}
        />
      </div>

      {warnings > 0 && (
        <div className="rounded-md border border-caution bg-caution-bg/40 p-3">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={warningsAccepted}
              onChange={(event) => onAcceptWarnings(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Open it over {warnings} warning{warnings === 1 ? '' : 's'}.
            </span>
          </label>
          {warningsAccepted && (
            <input
              value={warningReason}
              onChange={(event) => onWarningReason(event.target.value)}
              placeholder="Why open it anyway? This goes to the audit log."
              aria-label="Why publish over the warnings"
              className="mt-2 w-full rounded-md border border-caution bg-surface px-3 py-2 text-sm"
            />
          )}
        </div>
      )}

      <button
        type="button"
        disabled={blocked || busy}
        onClick={onPublish}
        className="w-full rounded-md bg-rise px-4 py-3.5 text-base font-bold text-paper disabled:opacity-30"
      >
        {busy ? 'Opening…' : 'Open the market'}
      </button>

      {blocked && report !== null && (
        <p className="text-center text-xs text-text-muted">
          {report.failures.length > 0 && `${report.failures.length} to fix. `}
          {report.unanswered.length > 0 && `${report.unanswered.length} to answer. `}
          {needsReason && 'Confirm the warnings and say why.'}
        </p>
      )}
    </div>
  );
}

/**
 * The market as a trader will meet it.
 *
 * A flat 50/50 gauge, because that is genuinely where it opens: the platform's
 * seed is symmetric and buys no side. Showing anything else here would be a
 * prediction dressed as a preview.
 */
function Preview({ draft }: { draft: StudioDraft }) {
  const labels = [
    ...draft.outcomes.map((outcome) => outcome.label || '—'),
    ...(draft.otherLabel === undefined ? [] : [draft.otherLabel]),
  ];
  // Flat, and honestly so: the platform's seed is symmetric and buys no side,
  // so this is where the market really opens.
  const even = (1 / Math.max(labels.length, 1)).toFixed(4);

  return (
    <section className="rounded-xl border border-border bg-surface-raised p-4">
      <p className="font-mono text-fine uppercase tracking-widest text-text-muted">
        How it will look
      </p>

      <div className="mt-2.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className="rounded-sm bg-rise px-1.5 py-0.5 font-mono text-fine font-bold text-paper">
            LIVE
          </span>
          <h3 className="mt-1.5 text-base font-bold leading-snug">
            {draft.question.trim() === '' ? 'Your question goes here.' : draft.question}
          </h3>
        </div>
        {labels.length === 2 && (
          <ChanceGauge value={50} size={64} label={labels[0] ?? ''} className="shrink-0" />
        )}
      </div>

      <div className="mt-3">
        <ArgumentBar
          segments={labels.map((label, index) => ({
            id: `preview-${index}`,
            label,
            price: even,
            ordinal: index,
            isOther: draft.otherLabel !== undefined && index === labels.length - 1,
          }))}
        />
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          Settles against <b className="text-text">{draft.sourceName || '—'}</b>
        </span>
        <span>
          Trading stops{' '}
          <b className="font-mono text-text">
            {draft.eventDate === ''
              ? '—'
              : `${new Date(draft.eventDate).toLocaleString('en-NG', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })} WAT`}
          </b>
        </span>
      </dl>
    </section>
  );
}

/**
 * Pass / warn / fail, in one strip.
 *
 * Collapsed it shows only what stands between here and publishing. Expanded it
 * prints all forty lines — because a reviewer signing off against a document
 * is entitled to see the whole document, and the rules nothing checked are part
 * of what they are signing.
 */
function VerdictStrip({
  report,
  expanded,
  onExpand,
  onFix,
}: {
  report: RuleReport;
  expanded: boolean;
  onExpand: (value: boolean) => void;
  onFix: (rule: string) => void;
}) {
  const attention = report.findings.filter(
    (finding) => finding.status === 'fail' || finding.status === 'warn',
  );
  const shown = expanded ? report.findings : attention;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        <Count tone="fall" value={report.failures.length} label="to fix" />
        <Count tone="caution" value={report.warnings.length} label="warning" />
        <Count
          tone="rise"
          value={report.findings.length - attention.length - report.unanswered.length}
          label="clear"
        />
        <button
          type="button"
          onClick={() => onExpand(!expanded)}
          aria-expanded={expanded}
          className="ml-auto flex items-center gap-1 text-xs font-semibold text-text-muted"
        >
          {/* The count comes from the report, not from a number typed here:
              the register grows, and a button that says "40" beside a
              forty-three line list is the screen disagreeing with the law. */}
          {expanded ? 'Just the issues' : `All ${report.findings.length} rules`}
          <ChevronDown
            size={13}
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {shown.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((finding) => (
            <VerdictRow key={finding.rule} finding={finding} onFix={onFix} />
          ))}
        </ul>
      )}
      {shown.length === 0 && (
        <p className="border-t border-border px-3.5 py-3 text-sm text-rise">
          Nothing failing and nothing to weigh up.
        </p>
      )}
    </section>
  );
}

function Count({
  tone,
  value,
  label,
}: {
  tone: 'fall' | 'caution' | 'rise';
  value: number;
  label: string;
}) {
  const colour =
    tone === 'fall'
      ? value > 0
        ? 'text-fall'
        : 'text-text-muted'
      : tone === 'caution'
        ? value > 0
          ? 'text-caution'
          : 'text-text-muted'
        : 'text-rise';
  return (
    <span className={`text-xs ${colour}`}>
      <b className="font-mono text-sm">{value}</b> {label}
      {value === 1 ? '' : label === 'warning' ? 's' : ''}
    </span>
  );
}

function VerdictRow({ finding, onFix }: { finding: Finding; onFix: (rule: string) => void }) {
  // Only what somebody can act on. A `note` means nothing was checked — there
  // is no field to send them to, and a Fix link beside "nothing was checked
  // against the 35-65% band" sends them looking for a control that is not
  // there.
  const actionable =
    finding.status === 'fail' || finding.status === 'warn' || finding.status === 'ask';
  const fixable = actionable && ANCHORS[finding.rule] !== undefined;
  const tone =
    finding.status === 'fail'
      ? 'text-fall'
      : finding.status === 'warn'
        ? 'text-caution'
        : finding.status === 'ask'
          ? 'text-brand'
          : 'text-text-muted';

  return (
    <li className="flex items-start gap-2 px-3.5 py-2 text-xs">
      {finding.status === 'fail' || finding.status === 'warn' ? (
        <AlertTriangle size={13} className={`mt-0.5 shrink-0 ${tone}`} />
      ) : finding.status === 'pass' ? (
        <Check size={13} className="mt-0.5 shrink-0 text-rise" />
      ) : (
        <span className={`mt-0.5 shrink-0 font-mono ${tone}`}>·</span>
      )}
      <span className="flex-1">{finding.message}</span>
      {fixable && (
        <button
          type="button"
          onClick={() => onFix(finding.rule)}
          className="shrink-0 font-semibold text-brand underline"
        >
          Fix
        </button>
      )}
    </li>
  );
}

function Judgement({
  id,
  question,
  yes,
  no,
  answer,
  onAnswer,
}: {
  id: string;
  question: string;
  yes: string;
  no: string;
  answer: boolean | undefined;
  onAnswer: (value: boolean) => void;
}) {
  return (
    <div id={id} tabIndex={-1} className="rounded-md border border-border bg-surface p-3">
      <p className="text-sm font-medium">{question}</p>
      <div className="mt-2 flex gap-2">
        {([true, false] as const).map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={answer === value}
            onClick={() => onAnswer(value)}
            className={`flex-1 rounded-sm border px-3 py-2 text-sm font-bold ${
              answer === value ? 'border-brand bg-brand text-paper' : 'border-border hover:bg-chip'
            }`}
          >
            {value ? yes : no}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One line under a field, and only when there is something to say.
 *
 * The words are the validator's own, never a restatement — so the screen and
 * the enforcement cannot drift apart, and a rule whose message improves
 * improves here too. Passing rules print nothing: a field that congratulates
 * you for filling it in correctly is a field that has to be read.
 */
function FieldNote({ report, rules }: { report: RuleReport | null; rules: readonly string[] }) {
  if (report === null) return null;
  const relevant = report.findings.filter(
    (finding) =>
      rules.includes(finding.rule) && (finding.status === 'fail' || finding.status === 'warn'),
  );
  if (relevant.length === 0) return null;

  // One line. If three rules on one field are unhappy, the first is the one to
  // act on and the rest reappear as it is fixed — a stack of three under a
  // textarea is the compliance list again, at a smaller size.
  const first = relevant.find((finding) => finding.status === 'fail') ?? relevant[0];
  if (first === undefined) return null;

  return (
    <p
      className={`-mt-1.5 flex items-start gap-1.5 text-xs ${
        first.status === 'fail' ? 'text-fall' : 'text-caution'
      }`}
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>
        {first.message}
        {relevant.length > 1 && (
          <span className="opacity-70"> (+{relevant.length - 1} more on this)</span>
        )}
      </span>
    </p>
  );
}

/** An ISO instant as the local value a `datetime-local` control wants. */
function toLocal(iso: string): string {
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(
    when.getHours(),
  )}:${pad(when.getMinutes())}`;
}
