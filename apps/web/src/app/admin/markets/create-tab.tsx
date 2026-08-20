'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { RuleReport } from '@stakeam/rules';

import { RuleReportPanel } from '@/components/rules/rule-report';
import { admin, type StudioDraft } from '@/lib/admin-api';

/**
 * The Studio's create wizard.
 *
 * Five steps, and the checklist runs on every one of them. That is the whole
 * design: the alternative — a form, then a validation at the end — is how a
 * person spends ten minutes writing a market and learns at the last click that
 * the metric was never named. Every step shows the rules that bind *at that
 * step*, with their numbers, so the document and the screen stay legible
 * against each other.
 *
 * Built to work on a phone, because that is where it is run from: one column,
 * full-width controls, and the step navigation pinned where a thumb reaches.
 */
const STEPS = ['Question', 'Outcomes', 'Source & dates', 'Liquidity', 'Review'] as const;
type Step = (typeof STEPS)[number];

/** Which rules a reviewer should be reading at each step. */
const STEP_RULES: Record<Step, readonly string[]> = {
  Question: ['20', '25', '28', '29', 'R6'],
  Outcomes: ['3', '4', '6', '11'],
  'Source & dates': ['1', '2', '17', '22', '26', '27', 'R2'],
  Liquidity: ['24', '30', '31', '33'],
  Review: [],
};

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
    edgeCases: {},
    liquidityParam: '50000',
  };
}

export function CreateTab({ seed }: { seed?: StudioDraft | undefined } = {}) {
  const [step, setStep] = useState<Step>('Question');
  // Seeded when the Library hands over a repeat. The wizard is otherwise
  // identical: the whole checklist still runs, because a market that ran fine
  // last quarter is exactly the one nobody re-reads.
  const [draft, setDraft] = useState<StudioDraft>(seed ?? blankDraft);
  const [edgeText, setEdgeText] = useState('');
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [attested, setAttested] = useState(false);
  const [report, setReport] = useState<RuleReport | null>(null);
  const [warningReason, setWarningReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Debounced rather than on every keystroke: the review is a round trip that
  // runs a duplicate search across the live shelf, and firing it per character
  // would make typing a question the heaviest thing the database does.
  useEffect(() => {
    const timer = setTimeout(() => void check(), 600);
    return () => clearTimeout(timer);
  }, [check]);

  function patch(next: Partial<StudioDraft>): void {
    setDraft((current) => ({ ...current, ...next }));
  }

  /**
   * Edge cases as one textarea, "situation: what happens" per line.
   *
   * A repeating pair of fields would be more obviously structured and worse to
   * use: rule 4 wants six or seven of these, and six pairs of inputs on a phone
   * is a screen nobody fills in.
   */
  function parseEdges(text: string): void {
    setEdgeText(text);
    const map: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (key.length > 0 && value.length > 0) map[key] = value;
    }
    patch({ edgeCases: map });
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
        <div className="mt-3 flex gap-2">
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
              setEdgeText('');
              setAnswers({});
              setAttested(false);
              setReport(null);
              setWarningReason('');
              setStep('Question');
            }}
            className="rounded-sm border border-border px-3 py-1.5 text-sm"
          >
            Write another
          </button>
        </div>
      </div>
    );
  }

  const stepReport =
    report === null
      ? null
      : {
          ...report,
          findings: report.findings.filter((finding) =>
            step === 'Review' ? true : STEP_RULES[step].includes(finding.rule),
          ),
        };

  return (
    <div className="space-y-4">
      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {STEPS.map((name, index) => (
          <button
            key={name}
            type="button"
            onClick={() => setStep(name)}
            aria-current={step === name}
            className={`shrink-0 rounded-sm px-3 py-1.5 text-xs font-semibold ${
              step === name ? 'bg-brand text-paper' : 'bg-chip text-text-muted hover:text-text'
            }`}
          >
            {index + 1}. {name}
          </button>
        ))}
      </nav>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {/*
        Two columns while writing, one on the review step.
        
        On the earlier steps the checklist is a running commentary beside the
        field you are filling in, which is what a sidebar is for. On the review
        step it *is* the screen — forty lines of it — and leaving it in a 380px
        rail put the thing being reviewed in a column narrower than the empty
        space beside it.
      */}
      <div className={`grid gap-4 ${step === 'Review' ? '' : 'min-[900px]:grid-cols-[1fr_380px]'}`}>
        <div className="space-y-3">
          {step === 'Question' && (
            <Field label="The question" hint="One sentence, ending in a question mark.">
              <textarea
                value={draft.question}
                onChange={(event) => patch({ question: event.target.value })}
                rows={3}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                placeholder="Will year-on-year headline CPI, as first published by the NBS, print below 24.5% for August?"
              />
            </Field>
          )}

          {step === 'Outcomes' && (
            <>
              {draft.outcomes.map((outcome, index) => (
                <div key={index} className="rounded-md border border-border bg-surface p-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={outcome.label}
                      onChange={(event) =>
                        patch({
                          outcomes: draft.outcomes.map((row, at) =>
                            at === index ? { ...row, label: event.target.value } : row,
                          ),
                        })
                      }
                      aria-label={`Outcome ${index + 1} label`}
                      className="flex-1 rounded-sm border border-border bg-surface-raised px-2 py-1.5 text-sm font-semibold"
                    />
                    {draft.outcomes.length > 2 && (
                      <button
                        type="button"
                        aria-label={`Remove outcome ${index + 1}`}
                        onClick={() =>
                          patch({ outcomes: draft.outcomes.filter((_, at) => at !== index) })
                        }
                        className="text-text-muted hover:text-fall"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={outcome.criteria}
                    onChange={(event) =>
                      patch({
                        outcomes: draft.outcomes.map((row, at) =>
                          at === index ? { ...row, criteria: event.target.value } : row,
                        ),
                      })
                    }
                    rows={2}
                    aria-label={`What makes ${outcome.label || `outcome ${index + 1}`} the result`}
                    placeholder="Exactly what makes this the result, per the named source, with the hour and WAT."
                    className="mt-2 w-full rounded-sm border border-border bg-surface-raised px-2 py-1.5 text-sm"
                  />
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    patch({ outcomes: [...draft.outcomes, { label: '', criteria: '' }] })
                  }
                  className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm"
                >
                  <Plus size={14} /> Another outcome
                </button>
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.otherLabel !== undefined}
                    onChange={(event) =>
                      patch({ otherLabel: event.target.checked ? 'Any other' : undefined })
                    }
                  />
                  Add an “Any other” bucket
                </label>
              </div>

              <Field
                label="Edge cases"
                hint="One per line, “situation: what happens”. Rule 4 wants postponed, cancelled, abandoned, no publication, disputed, methodology changed."
              >
                <textarea
                  value={edgeText}
                  onChange={(event) => parseEdges(event.target.value)}
                  rows={5}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
                  placeholder={
                    'no publication: the market voids\npostponed: settles on the new date'
                  }
                />
              </Field>
            </>
          )}

          {step === 'Source & dates' && (
            <>
              <Field label="Source" hint="The body that settles it. Rule 1.">
                <input
                  value={draft.sourceName}
                  onChange={(event) => patch({ sourceName: event.target.value })}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  placeholder="National Bureau of Statistics"
                />
              </Field>
              <Field label="The exact page" hint="Not the site it lives on. Rule R2.">
                <input
                  value={draft.sourceUrl}
                  onChange={(event) => patch({ sourceUrl: event.target.value })}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  placeholder="https://nigerianstat.gov.ng/elibrary/read/1241"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Event date and hour" hint="Trading freezes here. Rules 2, 22, 26.">
                  <input
                    type="datetime-local"
                    value={draft.eventDate.slice(0, 16)}
                    onChange={(event) =>
                      patch({
                        eventDate:
                          event.target.value === ''
                            ? ''
                            : new Date(event.target.value).toISOString(),
                      })
                    }
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Void date" hint="Everyone is refunded if it has not happened.">
                  <input
                    type="datetime-local"
                    value={draft.voidDate.slice(0, 16)}
                    onChange={(event) =>
                      patch({
                        voidDate:
                          event.target.value === ''
                            ? ''
                            : new Date(event.target.value).toISOString(),
                      })
                    }
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                </Field>
              </div>
            </>
          )}

          {step === 'Liquidity' && (
            <>
              <Field
                label="Liquidity constant L"
                hint="About 25× a typical stake. Too small and the price swings wildly; too large and the market looks frozen. Rule 24."
              >
                <input
                  value={draft.liquidityParam ?? ''}
                  onChange={(event) => patch({ liquidityParam: event.target.value })}
                  inputMode="numeric"
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
                />
              </Field>
              <Field label="Typical stake you expect" hint="What L is sized against.">
                <input
                  value={draft.expectedStake ?? ''}
                  onChange={(event) => patch({ expectedStake: event.target.value })}
                  inputMode="numeric"
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
                  placeholder="2000"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Category">
                  <input
                    value={draft.category ?? ''}
                    onChange={(event) => patch({ category: event.target.value })}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Tags" hint="Comma separated.">
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
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Icon">
                  <input
                    value={draft.icon ?? ''}
                    onChange={(event) => patch({ icon: event.target.value })}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.blockbuster === true}
                  onChange={(event) => patch({ blockbuster: event.target.checked })}
                />
                A blockbuster — an election or a tournament, allowed to run long (rule 10)
              </label>
            </>
          )}

          {step === 'Review' && (
            <SignOff
              attested={attested}
              onAttest={setAttested}
              answers={answers}
              onAnswer={(rule, value) => setAnswers((current) => ({ ...current, [rule]: value }))}
              report={report}
              warningReason={warningReason}
              onWarningReason={setWarningReason}
              onPublish={() => void publish()}
              busy={busy}
            />
          )}
        </div>

        <aside
          className={
            step === 'Review'
              ? 'order-first'
              : 'min-[900px]:sticky min-[900px]:top-4 min-[900px]:self-start'
          }
        >
          {stepReport === null ? (
            <p className="rounded-xl border border-border bg-surface-raised p-4 text-sm text-text-muted">
              Write the question and the checklist starts running against it.
            </p>
          ) : (
            <RuleReportPanel report={stepReport} defaultExpanded />
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The review step: the whole checklist, then the questions software cannot
 * answer, then the button.
 *
 * The button is last and it is disabled while anything blocks. A review screen
 * whose publish button works regardless of what the report says is a report
 * printed for decoration.
 */
function SignOff({
  attested,
  onAttest,
  answers,
  onAnswer,
  report,
  warningReason,
  onWarningReason,
  onPublish,
  busy,
}: {
  attested: boolean;
  onAttest: (value: boolean) => void;
  answers: Record<string, boolean>;
  onAnswer: (rule: string, value: boolean) => void;
  report: RuleReport | null;
  warningReason: string;
  onWarningReason: (value: string) => void;
  onPublish: () => void;
  busy: boolean;
}) {
  const needsReason = (report?.warnings.length ?? 0) > 0 && warningReason.trim().length < 5;
  const blocked = report === null || report.blocked || needsReason;

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-sm">
        <input
          type="checkbox"
          checked={attested}
          onChange={(event) => onAttest(event.target.checked)}
        />
        <span>
          <b>Rules 5 &amp; 16.</b> Nobody trading this — including me — can affect the outcome or
          holds inside knowledge of it.
        </span>
      </label>

      <Judgement
        rule="18"
        text="Would this embarrass us if it were screenshotted onto the front page?"
        pressed={answers['18'] === undefined ? undefined : !answers['18']}
        onPress={(yes) => onAnswer('18', !yes)}
      />
      <Judgement
        rule="25"
        text="Could somebody with no context resolve this using only the page and the named source?"
        pressed={answers['25']}
        onPress={(yes) => onAnswer('25', yes)}
      />
      <Judgement
        rule="R3"
        text="Do you want a particular side to win?"
        pressed={answers['R3']}
        onPress={(yes) => onAnswer('R3', yes)}
      />

      {(report?.warnings.length ?? 0) > 0 && (
        <Field
          label={`Publishing over ${report?.warnings.length} warning${
            report?.warnings.length === 1 ? '' : 's'
          }`}
          hint="A warning is publishable — the checklist calls these commercial judgements. Publishing over one silently is not: the reason goes to the audit log beside the warning it answers."
        >
          <input
            value={warningReason}
            onChange={(event) => onWarningReason(event.target.value)}
            className="w-full rounded-md border border-caution bg-surface px-3 py-2 text-sm"
            placeholder="Why open it anyway?"
          />
        </Field>
      )}

      <button
        type="button"
        disabled={blocked || busy}
        onClick={onPublish}
        className="w-full rounded-md bg-rise px-4 py-3 text-base font-bold text-paper disabled:opacity-30"
      >
        {busy ? 'Opening…' : 'Open the market'}
      </button>

      {blocked && report !== null && (
        <p className="text-xs text-text-muted">
          {report.failures.length > 0 &&
            `${report.failures.length} rule${report.failures.length === 1 ? '' : 's'} failing. `}
          {report.unanswered.length > 0 &&
            `${report.unanswered.length} question${
              report.unanswered.length === 1 ? '' : 's'
            } to answer. `}
          {needsReason && 'Say why you are publishing over the warnings.'}
        </p>
      )}
    </div>
  );
}

function Judgement({
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
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-sm">
      <span className="font-mono text-xs text-text-muted">Rule {rule}</span>
      <span className="flex-1">{text}</span>
      <span className="flex gap-1">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={pressed === value}
            onClick={() => onPress(value)}
            className={`rounded-sm border px-3 py-1.5 text-xs font-bold ${
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      {hint !== undefined && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}
