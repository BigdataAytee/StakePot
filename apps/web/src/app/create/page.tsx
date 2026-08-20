'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { creator, type Opportunity } from '@/lib/creator-api';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';

import { BalanceMeter } from '@/components/balance-meter';
import { PageShell, PageTitle } from '@/components/market/page-shell';
import { API_URL } from '@/lib/api';
import { TICKET_TEMPLATES, type TicketTemplate } from '@/lib/templates';

/**
 * Community market creation (§2.5, §2.14a).
 *
 * The schema is the same shape the server screens, so a creator finds out
 * they've missed the source or the void date while they're still typing rather
 * than after they've committed a ₦2,000 bond. The server screens again
 * regardless — a client-side check is a courtesy, never a control.
 */
const schema = z.object({
  question: z
    .string()
    .min(15, 'Give the question enough detail that a stranger could settle it.')
    .refine((q) => q.trim().endsWith('?'), 'Write it as a question, ending in a question mark.'),
  outcomes: z
    .array(
      z.object({
        label: z.string().min(1, 'Name the outcome.'),
        criteria: z.string().min(10, 'Say what makes this the result.'),
      }),
    )
    .min(2, 'List at least two outcomes.'),
  otherLabel: z.string().optional(),
  sourceName: z.string().min(1, 'Name the official source that settles this.'),
  sourceUrl: z.string().url('Link the source.').startsWith('https://', 'Use an https link.'),
  eventDate: z.string().min(1, 'When does it happen?'),
  voidDate: z.string().min(1, 'When does it void if nothing settles it?'),
  /** §2.4: the creator chooses the activation path, and it is not reversible. */
  activationPath: z.enum(['organic', 'seeded']),
});

type FormValues = z.infer<typeof schema>;

interface CopilotResponse {
  template: {
    question: string;
    outcomes: { label: string; criteria: string }[];
    otherLabel?: string;
    sourceName: string;
    sourceUrl: string;
    eventDate: string;
    voidDate: string;
  };
  estimates: number[];
  balanced: boolean;
  engagement: number;
  rationale: string;
  problems: { code: string; message: string }[];
  /** §2.14e's warnings. Present on balance-check, absent on the co-pilot. */
  risks?: Risk[];
}

/**
 * §2.14e — "auto-void risk warnings *before* posting".
 *
 * Warnings, never refusals. A creator whose market voids loses no money — the
 * bond comes back — but they lose the week they spent telling people to back
 * it, and that is what this is trying to save them.
 */
interface Risk {
  code: string;
  message: string;
  suggestion: string;
  severity: 'high' | 'medium' | 'low';
}

/** `2026-08-21T10:13:00.000Z` → `2026-08-21T10:13`, what a datetime-local wants. */
function forInput(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 16);
}

export default function CreatePage() {
  const [template, setTemplate] = useState<TicketTemplate | null>(null);
  const [submitted, setSubmitted] = useState<{ state: string; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idea, setIdea] = useState('');
  const [thinking, setThinking] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [risks, setRisks] = useState<Risk[] | null>(null);
  const [conflictAttested, setConflictAttested] = useState(false);

  // §2.14b's feed. Public, so it renders before anybody signs in — the whole
  // point is to show a would-be creator that there is demand waiting.
  useEffect(() => {
    void creator
      .opportunities()
      .then(setOpportunities)
      .catch(() => setOpportunities([]));
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      question: '',
      outcomes: [
        { label: 'YES', criteria: '' },
        { label: 'NO', criteria: '' },
      ],
      sourceName: '',
      sourceUrl: '',
      eventDate: '',
      voidDate: '',
      activationPath: 'organic',
    },
  });

  const outcomes = useFieldArray({ control: form.control, name: 'outcomes' });

  /**
   * §2.14a step 2: "AI restructure (live)".
   *
   * The creator types the question the way they would say it; the co-pilot
   * fills the whole template and hands back its own balance estimate, which is
   * what the meter below shows. Everything it writes stays editable — it is a
   * co-pilot, and the market is still theirs.
   */
  async function askCopilot(): Promise<void> {
    const token = window.localStorage.getItem('stakeam.token');
    if (token === null) {
      setError('Sign in to use the co-pilot.');
      return;
    }

    setThinking(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/community/copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: idea }),
      });
      const body = (await response.json()) as CopilotResponse & { message?: string };
      if (!response.ok)
        throw new Error(body.message ?? `The co-pilot could not help (${response.status})`);

      form.reset({
        question: body.template.question,
        outcomes: body.template.outcomes,
        ...(body.template.otherLabel === undefined ? {} : { otherLabel: body.template.otherLabel }),
        sourceName: body.template.sourceName,
        sourceUrl: body.template.sourceUrl,
        eventDate: forInput(body.template.eventDate),
        voidDate: forInput(body.template.voidDate),
        activationPath: form.getValues('activationPath'),
      });
      setEstimate(Math.max(...body.estimates));
      setRationale(body.rationale);
      setTemplate(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setThinking(false);
    }
  }

  /** Re-check the balance after the creator has edited what the co-pilot wrote. */
  async function checkBalance(): Promise<void> {
    const token = window.localStorage.getItem('stakeam.token');
    if (token === null) {
      setError('Sign in to check the balance.');
      return;
    }

    setThinking(true);
    setError(null);
    try {
      const values = form.getValues();
      const response = await fetch(`${API_URL}/community/balance-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          question: values.question,
          outcomes: values.outcomes,
          ...(values.otherLabel === undefined ? {} : { otherLabel: values.otherLabel }),
          sourceName: values.sourceName,
          sourceUrl: values.sourceUrl,
          eventDate: new Date(values.eventDate).toISOString(),
          voidDate: new Date(values.voidDate).toISOString(),
          activationPath: values.activationPath,
          conflictAttested,
        }),
      });
      const body = (await response.json()) as CopilotResponse & { message?: string };
      if (!response.ok)
        throw new Error(body.message ?? `Could not check that (${response.status})`);

      setEstimate(Math.max(...body.estimates));
      setRationale(body.rationale);
      setRisks(body.risks ?? []);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setThinking(false);
    }
  }

  function applyTemplate(picked: TicketTemplate): void {
    setTemplate(picked);
    form.reset({
      question: picked.question,
      outcomes: picked.outcomes,
      ...(picked.otherLabel === undefined ? {} : { otherLabel: picked.otherLabel }),
      sourceName: picked.sourceName,
      sourceUrl: picked.sourceUrl,
      eventDate: '',
      voidDate: '',
      activationPath: form.getValues('activationPath'),
    });
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setError(null);
    const token = window.localStorage.getItem('stakeam.token');
    if (token === null) {
      setError('Sign in to open a market.');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/community/markets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(values),
      });
      const body = (await response.json()) as { state?: string; reason?: string; message?: string };
      if (!response.ok) throw new Error(body.message ?? `Submission failed (${response.status})`);
      setSubmitted({
        state: body.state ?? 'suggested',
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  if (submitted !== null) {
    return (
      <PageShell width="narrow">
        <div className="rounded-xl border border-border p-6">
          <h1 className="text-xl font-bold">
            {submitted.state === 'rejected' ? 'Not this one' : 'Sent for review'}
          </h1>
          <p className="mt-2 text-base text-text-muted">
            {submitted.reason ??
              'A reviewer checks every new market before it opens. You keep your bond either way unless you settle dishonestly.'}
          </p>
          <a
            href="/"
            className="mt-5 inline-block font-semibold text-brand underline underline-offset-2"
          >
            Back to markets
          </a>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width="narrow">
      <PageTitle
        title="Talk your own"
        blurb="Open a market for your people to call. You put up a bond, you settle it against one named source, and you earn a cut of the losing pool."
      />

      {opportunities.length > 0 && (
        <section className="mb-8 rounded-xl border border-rise/40 bg-rise-bg p-4">
          <h2 className="text-sm font-semibold">People are already asking</h2>
          <p className="mt-1 text-sm text-text-muted">
            Nobody has opened a market for these yet. The first one to does.
          </p>
          <ul className="mt-3 space-y-2">
            {opportunities.slice(0, 5).map((opportunity) => (
              <li key={opportunity.id} className="flex items-baseline justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setIdea(opportunity.title)}
                  className="text-left text-sm font-semibold underline underline-offset-2"
                >
                  {opportunity.title}
                </button>
                <span className="whitespace-nowrap font-mono text-xs text-text-muted">
                  {opportunity.evidence?.searchers != null
                    ? `${opportunity.evidence.searchers} searched`
                    : opportunity.source.replace('_', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8 rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold">Say it how you would say it</h2>
        <p className="mt-1 text-sm text-text-muted">
          Type your question the way you would ask a friend. The co-pilot turns it into a proper
          ticket — outcomes, source, dates — and you edit whatever it gets wrong.
        </p>
        <textarea
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          rows={2}
          placeholder="who go win the Surulere LGA chairmanship"
          className="mt-3 w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand"
        />
        <button
          type="button"
          disabled={thinking || idea.trim().length < 10}
          onClick={() => void askCopilot()}
          className="mt-2 rounded-md bg-brand px-4 font-bold h-11 text-paper transition-transform active:scale-press disabled:opacity-40"
        >
          {thinking ? 'Thinking…' : 'Draft it for me'}
        </button>
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          Start from a template
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {TICKET_TEMPLATES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => applyTemplate(option)}
              aria-pressed={template?.id === option.id}
              className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                template?.id === option.id
                  ? 'border-brand bg-brand/10'
                  : 'border-border hover:border-brand'
              }`}
            >
              <span className="block font-semibold">{option.name}</span>
              <span className="block font-mono text-xs text-text-muted">{option.category}</span>
            </button>
          ))}
        </div>
      </section>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <Field label="The question" error={form.formState.errors.question?.message}>
          <textarea
            {...form.register('question')}
            rows={2}
            placeholder="Will the Super Eagles beat Ivory Coast on Saturday?"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand"
          />
        </Field>

        <div>
          <BalanceMeter estimate={estimate} low={0.35} high={0.65} />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={thinking}
              onClick={() => void checkBalance()}
              className="h-11 shrink-0 rounded-md border border-border px-3 text-sm font-semibold hover:border-text disabled:opacity-40"
            >
              {thinking ? 'Checking…' : 'Check the balance'}
            </button>
            {rationale !== null && <p className="text-sm text-text-muted">{rationale}</p>}
          </div>
        </div>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Outcomes</h2>
            <button
              type="button"
              onClick={() => outcomes.append({ label: '', criteria: '' })}
              className="flex items-center gap-1 text-sm font-semibold text-brand"
            >
              <Plus size={14} /> Add outcome
            </button>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            List every way this can end. If the field is open, add an &ldquo;Any other&rdquo;
            bucket.
          </p>

          <div className="mt-3 space-y-3">
            {outcomes.fields.map((field, index) => (
              <div key={field.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <input
                    {...form.register(`outcomes.${index}.label`)}
                    placeholder="YES"
                    className="h-11 w-32 rounded-md border border-border bg-surface px-3 font-semibold outline-none focus:border-brand"
                  />
                  {outcomes.fields.length > 2 && (
                    <button
                      type="button"
                      onClick={() => outcomes.remove(index)}
                      aria-label={`Remove outcome ${index + 1}`}
                      className="ml-auto text-text-muted hover:text-fall"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <input
                  {...form.register(`outcomes.${index}.criteria`)}
                  placeholder="What exactly makes this the result?"
                  className="mt-2 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-sm text-fall">
                  {form.formState.errors.outcomes?.[index]?.criteria?.message}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Field label="Official source" error={form.formState.errors.sourceName?.message}>
          <input
            {...form.register('sourceName')}
            placeholder="CBN official rate"
            className="h-11 w-full rounded-md border border-border bg-surface px-3 outline-none focus:border-brand"
          />
        </Field>

        <Field label="Source link" error={form.formState.errors.sourceUrl?.message}>
          <input
            {...form.register('sourceUrl')}
            placeholder="https://www.cbn.gov.ng/rates/"
            className="h-11 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus:border-brand"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Event date" error={form.formState.errors.eventDate?.message}>
            <input
              type="datetime-local"
              {...form.register('eventDate')}
              className="h-11 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus:border-brand"
            />
          </Field>
          <Field label="Voids after" error={form.formState.errors.voidDate?.message}>
            <input
              type="datetime-local"
              {...form.register('voidDate')}
              className="h-11 w-full rounded-md border border-border bg-surface px-3 font-mono text-sm outline-none focus:border-brand"
            />
          </Field>
        </div>

        <ActivationPathChooser
          value={form.watch('activationPath')}
          onChange={(path) => form.setValue('activationPath', path)}
        />

        <ConflictAttestation value={conflictAttested} onChange={setConflictAttested} />

        {risks !== null && <RiskPanel risks={risks} />}

        {error !== null && <p className="text-sm text-fall">{error}</p>}

        <button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="w-full rounded-md bg-brand py-3.5 font-bold text-paper transition-transform active:scale-press disabled:opacity-40"
        >
          {form.formState.isSubmitting ? 'Sending…' : 'Send for review'}
        </button>

        <p className="text-sm text-text-muted">
          A reviewer checks every new market. Your ₦2,000 bond is held while it runs and comes back
          when you settle it — or if it never gets off the ground.
        </p>
      </form>
    </PageShell>
  );
}

/**
 * §2.14e's warnings, shown where the creator can still act on them.
 *
 * Ordered by severity and each one paired with what to do instead, because a
 * warning with no suggestion is just discouragement. Nothing here blocks the
 * submit button: deciding which questions are worth asking is not ours to
 * make, and the market that fills against our expectations is the interesting
 * one.
 */
function RiskPanel({ risks }: { risks: Risk[] }) {
  if (risks.length === 0) {
    return (
      <p className="rounded-lg border border-rise/40 bg-rise-bg px-3 py-2 text-sm">
        Nothing obvious stands in the way of this one filling.
      </p>
    );
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...risks].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <section className="rounded-xl border border-border">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Before you post</h2>
      <ul className="divide-y divide-border">
        {sorted.map((risk) => (
          <li key={risk.code} className="px-4 py-3">
            <p className="flex items-baseline gap-2 text-sm font-semibold">
              <span
                className={`mt-0.5 size-2 shrink-0 rounded-full ${
                  risk.severity === 'high'
                    ? 'bg-fall'
                    : risk.severity === 'medium'
                      ? 'bg-money'
                      : 'bg-border'
                }`}
                aria-hidden
              />
              {risk.message}
            </p>
            <p className="mt-1 pl-4 text-sm text-text-muted">{risk.suggestion}</p>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2.5 text-sm text-text-muted">
        None of this stops you posting. If it voids, every stake is refunded in full and your bond
        comes back.
      </p>
    </section>
  );
}

/**
 * The Rulebook Part 3 attestation, asked plainly.
 *
 * Not buried in the terms: the creator settles this market themselves, and the
 * one thing that makes that safe is them saying up front whether they can
 * influence the result. Declaring costs nothing; hiding it forfeits the bond,
 * and it is only fair to say that where the question is asked.
 */
function ConflictAttestation({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-border p-3">
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-brand"
      />
      <span className="text-sm">
        <span className="font-semibold">
          I have no influence over this result and no inside knowledge of it.
        </span>
        <span className="mt-0.5 block text-text-muted">
          You settle this market against the source you named. If that is not true of you here, say
          so — declaring it costs nothing, and hiding it forfeits your bond.
        </span>
      </span>
    </label>
  );
}

/**
 * The two ways a market can open (§2.4, Rulebook Part 3 §2).
 *
 * Presented as a real trade-off rather than a default and an advanced option:
 * Path A costs nothing but has to fill on its own; Path B opens now because the
 * creator (or a syndicate) put money on every outcome at once. The one thing a
 * creator must not misread is that seeding is not taking a side — the seed is
 * symmetric, so it cannot pay off for the person who also settles the market.
 */
function ActivationPathChooser({
  value,
  onChange,
}: {
  value: 'organic' | 'seeded';
  onChange: (path: 'organic' | 'seeded') => void;
}) {
  const options = [
    {
      id: 'organic' as const,
      title: 'Let it fill',
      blurb: 'Free. Opens for staking, and goes live if enough people back both sides in time.',
    },
    {
      id: 'seeded' as const,
      title: 'Seed it open',
      blurb:
        'You (or sponsors you invite) put equal money on every outcome, and it goes live at once.',
    },
  ];

  return (
    <section>
      <h2 className="text-sm font-semibold">How should it open?</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={value === option.id}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              value === option.id ? 'border-brand bg-brand/10' : 'border-border hover:border-brand'
            }`}
          >
            <span className="block text-sm font-semibold">{option.title}</span>
            <span className="mt-1 block text-sm text-text-muted">{option.blurb}</span>
          </button>
        ))}
      </div>
      {value === 'seeded' && (
        <p className="mt-2 text-sm text-text-muted">
          The seed is split equally across every outcome, so you never hold a side in a market you
          settle. It still needs real backers by the deadline — otherwise the market voids and your
          seed comes back in full.
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      <div className="mt-1.5">{children}</div>
      {error !== undefined && <p className="mt-1 text-sm text-fall">{error}</p>}
    </label>
  );
}
